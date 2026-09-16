const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const core = require("../cloudfunctions/contentSecurityCheck/core.js");

test("检测请求：openid 必填、场景固定为社交日志、正文按码点截到 2500 字", () => {
  const long = "字".repeat(3000);
  const input = core.normalizeCheckInput({ content: `  ${long}  `, title: "  标题  " });
  assert.equal(Array.from(input.content).length, core.MAX_LENGTH);
  assert.equal(input.title, "标题");

  const request = core.buildCheckRequest(input, "openid-123");
  assert.equal(request.version, 2);
  assert.equal(request.scene, 4);
  assert.equal(request.openid, "openid-123");
  assert.equal(request.title, "标题");

  assert.throws(() => core.buildCheckRequest(input, ""), /OPENID_NOT_AVAILABLE/);
});

test("没有标题时请求体里不带 title 字段", () => {
  const input = core.normalizeCheckInput({ content: "一段没有标题的文字" });
  assert.equal(input.title, undefined);
  const request = core.buildCheckRequest(input, "openid-123");
  assert.ok(!("title" in request));
});

test("只有 suggest 为 pass 才算通过；review／risky 都当作没通过", () => {
  assert.deepEqual(core.interpretCheckResponse({ result: { suggest: "pass", label: 100 } }), {
    ok: true,
    suggest: "pass",
    label: 100,
  });
  assert.equal(core.interpretCheckResponse({ result: { suggest: "review" } }).ok, false);
  assert.equal(core.interpretCheckResponse({ result: { suggest: "risky" } }).ok, false);
  assert.equal(core.interpretCheckResponse({}).ok, false);
  assert.equal(core.interpretCheckResponse(undefined).suggest, "review");
});

test("调用失败一律按未通过处理，绝不当成通过", () => {
  assert.deepEqual(core.failClosed(new Error("网络出错")).ok, false);
  assert.match(core.failClosed({ errMsg: "cloud.callFunction:fail timeout" }).error, /timeout/);
  assert.equal(core.failClosed(undefined).suggest, "review");
});

test("main 声明了微信内容安全权限，且检测调用失败或 openid 缺失都不会当作通过放行", () => {
  const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/contentSecurityCheck/index.js"), "utf8");
  assert.match(source, /security\.msgSecCheck/);
  assert.match(source, /OPENID_NOT_AVAILABLE/);
  assert.match(source, /failClosed\(error\)/);

  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../cloudfunctions/contentSecurityCheck/config.json"), "utf8"));
  assert.deepEqual(config.permissions.openapi, ["security.msgSecCheck"]);
});
