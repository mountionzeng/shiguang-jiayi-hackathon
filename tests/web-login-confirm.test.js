// 契约 1.6.0：网页登录确认。subject 只由云函数从 OPENID 计算。
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const core = require("../cloudfunctions/drinkingTimeBridge/core.js");

const CONTEXT = { APPID: "wx0000000000000000", OPENID: "o-contract-vector-openid" };
const SUBJECT = "shiguang:8bf5716e65f591b83c18b8e37ce6e4d2ed2985fac96c3d1dac30f85ea04451c1";

test("主体由服务端计算，客户端传入的 subject 与 userId 被忽略", () => {
  const body = core.webLoginBody({ code: "abc-234", decision: "confirm", subject: "shiguang:" + "f".repeat(64), userId: 9, OPENID: "forged" }, CONTEXT);
  assert.deepEqual(body, { subject: SUBJECT, code: "ABC234", decision: "confirm" });
});

test("缺少 OPENID、码格式不对、决定不认识都失败", () => {
  assert.throws(() => core.webLoginBody({ code: "ABC234", decision: "confirm" }, { APPID: "wx1" }), /OPENID_NOT_AVAILABLE/);
  assert.throws(() => core.webLoginBody({ code: "ABC23", decision: "confirm" }, CONTEXT), /invalid_input/);
  assert.throws(() => core.webLoginBody({ code: "ABC234", decision: "approve" }, CONTEXT), /invalid_input/);
});

test("契约测试向量 V2 固定不变", () => {
  const body = { subject: SUBJECT, code: "ABC234", decision: "confirm" };
  const message = `POST\n/web-login/confirm\n1789999200000\nAAECAwQFBgcICQoLDA0ODxAR\n${core.canonicalJson(body)}`;
  assert.equal(Buffer.byteLength(message), 187);
  assert.equal(crypto.createHash("sha256").update(message).digest("hex"), "cc4e564610ef759d039ba1dc12a74cba7c93ab0516920e9fe4f20e90fda46feb");
  assert.equal(core.signature("contract-vector-secret-public-do-not-deploy", "/web-login/confirm", "1789999200000", "AAECAwQFBgcICQoLDA0ODxAR", body),
    "fae8fa7340accaecfc87d8b8c8faf4fac7ed1288ca2f14228924e088975a38e2");
});

test("响应形状：只接受 JSON 与已知结果", () => {
  assert.equal(core.webLoginResultShapeError("application/json", { outcome: "confirmed" }), null);
  assert.equal(core.webLoginResultShapeError("application/json", { outcome: "preview", clientHint: "Mac · Chrome", mode: "login" }), null);
  assert.equal(core.webLoginResultShapeError("application/json", { outcome: "preview", mode: "login" }), "bridge_unavailable");
  assert.equal(core.webLoginResultShapeError("text/html", { outcome: "confirmed" }), "bridge_unavailable");
  assert.equal(core.webLoginResultShapeError("application/json", { outcome: "ok" }), "bridge_unavailable");
});

test("开关关闭时云函数入口拒绝确认，且只提供入口可见性", async () => {
  const Module = require("node:module");
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "wx-server-sdk") return { init() {}, DYNAMIC_CURRENT_ENV: "x", database: () => ({}), getWXContext: () => CONTEXT };
    return original.call(this, request, ...rest);
  };
  process.env.DRINKING_TIME_BRIDGE_BASE_URL = "https://test.drinkingtime.top/api/shiguang";
  process.env.DRINKING_TIME_BRIDGE_SECRET = "s".repeat(32);
  delete process.env.WEB_LOGIN_CONFIRM_ENABLED;
  try {
    const { main } = require("../cloudfunctions/drinkingTimeBridge/index.js");
    await assert.rejects(main({ action: "confirmWebLogin", code: "ABC234", decision: "confirm" }), /web_login_disabled/);
    assert.deepEqual(await main({ action: "webLoginEnabled" }), { enabled: false });
    process.env.WEB_LOGIN_CONFIRM_ENABLED = "true";
    assert.deepEqual(await main({ action: "webLoginEnabled" }), { enabled: true });
  } finally {
    Module._load = original;
    delete process.env.WEB_LOGIN_CONFIRM_ENABLED;
  }
});
