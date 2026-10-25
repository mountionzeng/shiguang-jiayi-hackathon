const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("../cloudfunctions/drinkingTimeBridge/core.js");

const CONTEXT = { APPID: "wx0000000000000000", OPENID: "o-contract-vector-openid" };
const CLAIM_ID = "123e4567-e89b-42d3-a456-426614174000";
const PACKAGE = {
  kind: "chapter-package", version: 1, packageId: "cp_abcdefgh1234", lineage: { rootPackageId: "cp_abcdefgh1234", parentPackageId: null },
  createdAt: "2026-10-24T00:00:00.000Z", sender: { platform: "miniprogram", displayName: "ignored" }, storyTitle: "Test",
  chapters: [{ chapterId: "chapter-1", title: "One", containsAiText: false, cover: null, blocks: [], layout: null }], assets: [],
};

test("1.7.0 投递签名体从云函数上下文推导主体并剥离客户端传来的 fileID", () => {
  const input = { action: "sendChapter", package: PACKAGE, recipientContactId: "A".repeat(43), requestId: CLAIM_ID,
    assetFileIDs: { leaked: "cloud://someone/private" }, assetPhotos: { leaked: "photo-x" } };
  const { path, body } = core.chapterDeliveryBody("sendChapter", input, CONTEXT);
  assert.equal(path, "/chapter-delivery/send");
  assert.equal(body.subject, core.subjectFor(CONTEXT.APPID, CONTEXT.OPENID));
  assert.equal(body.recipientContactId, input.recipientContactId);
  assert.equal("assetFileIDs" in body, false);
  assert.equal("assetPhotos" in body, false);
  assert.throws(() => core.chapterDeliveryBody("sendChapter", { ...input, subject: "shiguang:" + "f".repeat(64) }, CONTEXT), /invalid_input/);
  assert.throws(() => core.chapterDeliveryBody("sendChapter", { ...input, userId: 7 }, CONTEXT), /invalid_input/);
});

test("1.7.0 投递结果形状拒绝指向任意 host 的媒体路径", () => {
  const result = { deliveryId: CLAIM_ID, repeated: false, uploadTickets: [{ assetId: "asset-" + "a".repeat(32),
    path: "https://attacker.invalid/upload", token: "A".repeat(43), mime: "image/png", bytes: 10, sha256: "a".repeat(64), expiresAt: "2026-10-24T00:10:00.000Z" }] };
  assert.equal(core.chapterDeliveryResultShapeError("application/json", result, "sendChapter"), "bridge_unavailable");
  result.uploadTickets[0].path = "/api/chapter-delivery/media/cp_abcdefgh1234/asset-" + "a".repeat(32);
  assert.equal(core.chapterDeliveryResultShapeError("application/json", result, "sendChapter"), null);
});

test("1.7.0 收件回包必须给出有效的投递种类以决定完成状态", () => {
  const result = { delivery: { deliveryId: CLAIM_ID, kind: "return", status: "pending" }, package: PACKAGE, imageUrls: {} };
  assert.equal(core.chapterDeliveryResultShapeError("application/json", result, "readChapterPackage"), null);
  result.delivery.kind = "unknown";
  assert.equal(core.chapterDeliveryResultShapeError("application/json", result, "readChapterPackage"), "bridge_unavailable");
  result.delivery.kind = "return";
  result.imageUrls = [];
  assert.equal(core.chapterDeliveryResultShapeError("application/json", result, "readChapterPackage"), "bridge_unavailable");
});

test("canonical JSON 把数组里的 undefined 按传输结果规范化为 null", () => {
  assert.equal(core.canonicalJson([undefined, { gone: undefined }]), "[null,{}]");
});

test('好友卡片领取保护通过可信桥透传，旧的跨端领取仍兼容', () => {
  const input = {token:'A'.repeat(43),otherUserOnly:true};
  assert.equal(core.chapterDeliveryBody('claimChapterPackage',input,CONTEXT).body.otherUserOnly,true);
  assert.equal(core.chapterDeliveryBody('claimChapterPackage',{token:input.token},CONTEXT).body.otherUserOnly,undefined);
  assert.throws(()=>core.chapterDeliveryBody('claimChapterPackage',{...input,otherUserOnly:'true'},CONTEXT),/invalid_input/);
});
