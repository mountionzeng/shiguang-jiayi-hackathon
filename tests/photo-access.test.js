const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const core = require("../cloudfunctions/photoAccess/core.js");

const FAMILY = "family_o-owner";
const PHOTO = "photo-1720000000000-abc123";

test("读取照片校验用途、规格、数量和不重复的照片编号", () => {
  assert.deepEqual(core.normalizeReadInput({
    familyId: FAMILY,
    photoIds: [PHOTO],
    variant: "small",
    purpose: "ai-caption",
  }), { familyId: FAMILY, photoIds: [PHOTO], variant: "small", purpose: "ai-caption" });
  assert.throws(() => core.normalizeReadInput({ familyId: FAMILY, photoIds: [], variant: "small", purpose: "view" }), error => error.code === "INVALID_PHOTOS");
  assert.throws(() => core.normalizeReadInput({ familyId: FAMILY, photoIds: [PHOTO, PHOTO], variant: "small", purpose: "view" }), error => error.code === "INVALID_PHOTOS");
  assert.throws(() => core.normalizeReadInput({ familyId: FAMILY, photoIds: [PHOTO], variant: "original", purpose: "view" }), error => error.code === "INVALID_VARIANT");
  assert.throws(() => core.normalizeReadInput({ familyId: FAMILY, photoIds: [PHOTO], variant: "small", purpose: "export" }), error => error.code === "INVALID_PURPOSE");
});

test("登记照片只接受固定云路径、两种压缩图和正整数元数据", () => {
  const input = core.normalizeRegisterInput({
    familyId: FAMILY,
    photoId: PHOTO,
    source: "import",
    displayFileID: `cloud://env/user-photos/${FAMILY}/${PHOTO}/display.jpg`,
    smallFileID: `cloud://env/user-photos/${FAMILY}/${PHOTO}/small.jpg`,
    width: 1200,
    height: 800,
    displayBytes: 300000,
    smallBytes: 80000,
  });
  assert.equal(input.source, "import");
  assert.throws(() => core.normalizeRegisterInput({ ...input, displayFileID: "cloud://env/other/display.jpg" }), error => error.code === "INVALID_FILES");
  assert.throws(() => core.normalizeRegisterInput({ ...input, displayFileID: `${input.displayFileID}.bak` }), error => error.code === "INVALID_FILES");
  assert.throws(() => core.normalizeRegisterInput({ ...input, smallBytes: 0 }), error => error.code === "INVALID_METADATA");
});

test("小程序调用只认上下文身份，云函数代读必须同时有内部口令和代读身份", () => {
  assert.equal(core.requesterOpenid({ SOURCE: "wx_client", OPENID: "owner-openid" }, { onBehalfOfOpenid: "fake" }, "secret"), "owner-openid");
  assert.equal(core.requesterOpenid({ SOURCE: "wx_trigger" }, { internalToken: "secret", onBehalfOfOpenid: "owner-openid" }, "secret"), "owner-openid");
  assert.throws(() => core.requesterOpenid({ SOURCE: "wx_trigger" }, { internalToken: "bad", onBehalfOfOpenid: "owner-openid" }, "secret"), error => error.code === "FORBIDDEN");
  assert.throws(() => core.requesterOpenid({ SOURCE: "wx_client", OPENID: "" }, {}, "secret"), error => error.code === "OPENID_NOT_AVAILABLE");
});

test("本人始终可看自己的照片；AI 只拦 risky，家人必须有引用且明确 pass", () => {
  const photo = {
    familyId: FAMILY,
    photoId: PHOTO,
    _openid: "owner-openid",
    displayFileID: "cloud://display",
    smallFileID: "cloud://small",
    displayBytes: 300000,
    smallBytes: 80000,
    width: 1200,
    height: 800,
    moderation: { ok: false, suggest: "review" },
  };
  const ownView = core.publicPhoto(photo, { familyId: FAMILY, photoId: PHOTO, purpose: "view", variant: "display" }, "owner-openid", []);
  assert.equal(ownView.status, "ok");
  const ownAi = core.publicPhoto(photo, { familyId: FAMILY, photoId: PHOTO, purpose: "ai-caption", variant: "small" }, "owner-openid", []);
  assert.equal(ownAi.status, "ok");
  assert.equal(core.publicPhoto({ ...photo, moderation: { ok: false, suggest: "risky" } }, { familyId: FAMILY, photoId: PHOTO, purpose: "ai-caption", variant: "small" }, "owner-openid", []).status, "risky");

  const sharedInput = { familyId: FAMILY, photoId: PHOTO, purpose: "view", variant: "display" };
  assert.equal(core.publicPhoto(photo, sharedInput, "relative-openid", [{ photoIds: [PHOTO] }]).status, "forbidden");
  assert.equal(core.publicPhoto({ ...photo, moderation: { ok: true, suggest: "pass" } }, sharedInput, "relative-openid", []).status, "forbidden");
  assert.equal(core.publicPhoto({ ...photo, moderation: { ok: true, suggest: "pass" } }, sharedInput, "relative-openid", [{ photoIds: [PHOTO] }]).status, "ok");
});

test("photoAccess 接线：只返回临时链接、不返回 fileID，图片检测用社交日志场景", () => {
  const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/photoAccess/index.js"), "utf8");
  assert.match(source, /security\.mediaCheckAsync/);
  assert.match(source, /scene:\s*4/);
  assert.match(source, /action === "moderationResult"/);
  assert.match(source, /PHOTO_ACCESS_INTERNAL_TOKEN/);
  assert.match(source, /const \{ fileID, \.\.\.safe \} = result/);
  assert.match(source, /visibleMemoriesForAccess/);

  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../cloudfunctions/photoAccess/config.json"), "utf8"));
  assert.deepEqual(config.permissions.openapi, ["security.mediaCheckAsync"]);
  const { CORE_COLLECTIONS } = require("../cloudfunctions/ensureCloudCollections/bootstrap.js");
  assert.ok(CORE_COLLECTIONS.includes("photos"));
  for (const name of ["resetCurrentUserRoom", "deleteDemoFamilyOnce"]) {
    const cleanup = fs.readFileSync(path.join(__dirname, `../cloudfunctions/${name}/index.js`), "utf8");
    assert.match(cleanup, /photos:\s*"photos"/);
    assert.match(cleanup, /record\.displayFileID, record\.smallFileID/);
  }
  const inspect = fs.readFileSync(path.join(__dirname, "../cloudfunctions/inspectFamilyData/index.js"), "utf8");
  assert.match(inspect, /photos:\s*"photos"/);
});

test("云端照片管理只允许小程序本人操作，确认后先删文件再删记录", () => {
  const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/photoAccess/index.js"), "utf8");
  assert.match(source, /action === "listMine"/);
  assert.match(source, /action === "deleteMine"/);
  assert.match(source, /event\.confirm !== "DELETE_MY_CLOUD_PHOTOS"/);
  assert.match(source, /loadAll\(PHOTOS, \{ familyId, _openid: openid \}\)/);
  assert.match(source, /if \(isInternalContext\(context\)\) throw new PhotoAccessError\("FORBIDDEN", "只能在小程序里管理照片"\)/);
  assert.ok(source.indexOf("await cloud.deleteFile") < source.indexOf("photos.map(photo => db.collection(PHOTOS).doc(photo._id).remove())"));

  assert.equal(core.normalizeFamilyId(FAMILY), FAMILY);
  assert.throws(() => core.normalizeFamilyId("family/other"), error => error.code === "INVALID_FAMILY");

  const page = fs.readFileSync(path.join(__dirname, "../miniprogram/pages/me/me.wxml"), "utf8");
  assert.match(page, /云端照片 \{\{cloudPhotoCount\}\} 张/);
  assert.match(page, /还没存到云端的照片只在这台手机上/);
  assert.match(page, /看照片会另外询问/);
});
