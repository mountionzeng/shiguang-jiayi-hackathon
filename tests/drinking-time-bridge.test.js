const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("../cloudfunctions/drinkingTimeBridge/core.js");

test("跨端身份不暴露 OPENID 且签名绑定路径和故事正文", () => {
  const story = { sourceKey: "story:外婆", sourceRevision: "0123456789abcdef" };
  const body = core.requestBody("issueDesktop", { story, subject: "forged", userId: 99 }, { APPID: "wx-app", OPENID: "openid-secret" });
  assert.match(body.subject, /^shiguang:[0-9a-f]{64}$/);
  assert.ok(!body.subject.includes("openid-secret"));
  assert.deepEqual(body.story, story);
  assert.equal("userId" in body, false);
  const signature = core.signature("x".repeat(32), "/desktop/pair/issue", "1", "nonce", body);
  assert.notEqual(signature, core.signature("x".repeat(32), "/desktop/pair/issue", "1", "nonce", { ...body, story: { ...story, sourceRevision: "fedcba9876543210" } }));
});

test("服务地址保留 Drinking Time 桥接前缀", () => {
  assert.equal(core.bridgeUrl("https://test.drinkingtime.top/api/shiguang", "/desktop/pair/issue").toString(), "https://test.drinkingtime.top/api/shiguang/desktop/pair/issue");
});

test("云函数只接受微信故事进入电脑这个方向", () => {
  const context = { APPID: "wx-app", OPENID: "openid-secret" };
  assert.throws(() => core.requestBody("list", {}, context), /invalid_input/);
  assert.throws(() => core.requestBody("issueDesktop", { story: null }, context), /invalid_input/);
  const storyAccess={grantId:"desktop-grant-"+"a".repeat(64)};
  assert.deepEqual(core.requestBody("issueDesktop",{storyAccess},context).storyAccess,storyAccess);
  assert.throws(()=>core.requestBody("issueDesktop",{story:{},storyAccess},context),/invalid_input/);
});

test("跨端身份不回退到旧账号 AppID", () => {
  const event = { story: { sourceKey: "story:迁移", sourceRevision: "0123456789abcdef" } };
  assert.throws(
    () => core.requestBody("issueDesktop", event, { OPENID: "openid-secret" }),
    /APPID_NOT_AVAILABLE/,
  );
  const configured = core.requestBody(
    "issueDesktop",
    event,
    { OPENID: "openid-secret" },
    { appIdFallback: "wx-new-account" },
  );
  assert.equal(configured.subject, core.subjectFor("wx-new-account", "openid-secret"));
});

test("签名序列化与实际 JSON 请求一样忽略 undefined 字段", () => {
  assert.equal(core.canonicalJson({ a: 1, missing: undefined }), '{"a":1}');
});

test("接口约定 1.1.0 第 3.5 节：成功响应形状不对就当作 bridge_unavailable", () => {
  const ok = { code: "ABC234", expiresAt: "2026-09-14T10:05:00.000Z", storyId: 31, imported: true };
  assert.equal(core.issueDesktopResultShapeError("application/json", ok), null);
  assert.equal(core.issueDesktopResultShapeError("application/json; charset=utf-8", ok), null);
  // 漏挂载点时服务端返回 200 + 网页首页 HTML，不是 JSON。
  assert.equal(core.issueDesktopResultShapeError("text/html", ok), "bridge_unavailable");
  assert.equal(core.issueDesktopResultShapeError("application/json", {}), "bridge_unavailable");
  assert.equal(core.issueDesktopResultShapeError("application/json", { ...ok, code: "000000" }), "bridge_unavailable");
  assert.equal(core.issueDesktopResultShapeError("application/json", { ...ok, expiresAt: "不是时间" }), "bridge_unavailable");
  assert.equal(core.issueDesktopResultShapeError("application/json", { ...ok, storyId: 0 }), "bridge_unavailable");
  assert.equal(core.issueDesktopResultShapeError("application/json", { ...ok, storyId: 1.5 }), "bridge_unavailable");
  assert.equal(core.issueDesktopResultShapeError("application/json", { ...ok, imported: "true" }), "bridge_unavailable");
  const authority={code:"ABC234",expiresAt:"2026-09-14T10:05:00.000Z",storyAccessId:7,bound:true};
  assert.equal(core.issueDesktopResultShapeError("application/json",authority),null);
  assert.equal(core.issueDesktopResultShapeError("application/json",{...authority,storyId:3,imported:true}),"bridge_unavailable");
});
