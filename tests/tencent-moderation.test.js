const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const moderation = require("../cloudfunctions/chatInterview/tencentModeration.js");

test("AI cloud functions deploy the same paid moderation adapter and dependency", () => {
  const names = ["chatInterview", "generateBiography", "organizeMemory", "personalMemory"];
  const canonical = fs.readFileSync(path.join(__dirname, "../cloudfunctions/chatInterview/tencentModeration.js"), "utf8").trimEnd();
  for (const name of names) {
    assert.equal(
      fs.readFileSync(path.join(__dirname, `../cloudfunctions/${name}/tencentModeration.js`), "utf8").trimEnd(),
      canonical,
      `${name} must carry the same paid moderation adapter`,
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, `../cloudfunctions/${name}/package.json`), "utf8"));
    assert.equal(pkg.dependencies["tencentcloud-sdk-nodejs-tms"], "4.1.311");
  }
});

test("Tencent paid moderation stays disabled until the release flag is enabled", async () => {
  let calls = 0;
  const result = await moderation.moderateTextWithTencent({
    content: "虚构测试文字",
    env: {},
    client: { async TextModeration() { calls += 1; return { Suggestion: "Pass" }; } },
  });
  assert.deepEqual(result, { available: false, reason: "disabled" });
  assert.equal(calls, 0);
});

test("Tencent paid moderation sends base64 text and maps provider suggestions", async () => {
  const requests = [];
  const client = { async TextModeration(request) {
    requests.push(request);
    return { Suggestion: requests.length === 1 ? "Pass" : "Review" };
  } };
  const env = { AI_PAID_MODERATION_ENABLED: "true", AI_MODERATION_TENCENT_BIZ_TYPE: "shiguang-text" };
  const passed = await moderation.moderateTextWithTencent({ content: "虚构安全文字", dataId: "case-pass", env, client });
  const reviewed = await moderation.moderateTextWithTencent({ content: "虚构复核文字", dataId: "case-review", env, client });

  assert.equal(passed.status, "pass");
  assert.equal(reviewed.status, "reject");
  assert.equal(Buffer.from(requests[0].Content, "base64").toString("utf8"), "虚构安全文字");
  assert.deepEqual(requests[0], {
    Content: requests[0].Content,
    DataId: "case-pass",
    SourceLanguage: "zh",
    Type: "TEXT",
    BizType: "shiguang-text",
  });
});

test("Tencent paid moderation keeps dedicated credentials as one credential set", () => {
  assert.deepEqual(moderation.credentialsFromEnv({
    AI_MODERATION_TENCENT_SECRET_ID: "dedicated-id",
    AI_MODERATION_TENCENT_SECRET_KEY: "dedicated-key",
    TENCENTCLOUD_SESSION_TOKEN: "unrelated-runtime-token",
  }), { secretId: "dedicated-id", secretKey: "dedicated-key", token: "" });
  assert.deepEqual(moderation.credentialsFromEnv({
    TENCENTCLOUD_SECRETID: "runtime-id",
    TENCENTCLOUD_SECRETKEY: "runtime-key",
    TENCENTCLOUD_SESSIONTOKEN: "runtime-token",
  }), { secretId: "runtime-id", secretKey: "runtime-key", token: "runtime-token" });
});
