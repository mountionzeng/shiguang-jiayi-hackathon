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
});

test("签名序列化与实际 JSON 请求一样忽略 undefined 字段", () => {
  assert.equal(core.canonicalJson({ a: 1, missing: undefined }), '{"a":1}');
});
