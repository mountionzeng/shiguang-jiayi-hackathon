const crypto = require("node:crypto");

const clean = value => typeof value === "string" && value.trim() ? value.trim() : "";

function credentialsFromEnv(env = process.env) {
  const dedicated = {
    secretId: clean(env.AI_MODERATION_TENCENT_SECRET_ID),
    secretKey: clean(env.AI_MODERATION_TENCENT_SECRET_KEY),
    token: clean(env.AI_MODERATION_TENCENT_SESSION_TOKEN),
  };
  if (dedicated.secretId && dedicated.secretKey) return dedicated;
  return {
    secretId: clean(env.TENCENTCLOUD_SECRET_ID) || clean(env.TENCENTCLOUD_SECRETID),
    secretKey: clean(env.TENCENTCLOUD_SECRET_KEY) || clean(env.TENCENTCLOUD_SECRETKEY),
    token: clean(env.TENCENTCLOUD_SESSION_TOKEN) || clean(env.TENCENTCLOUD_SESSIONTOKEN),
  };
}

function moderationConfigFromEnv(env = process.env) {
  const credentials = credentialsFromEnv(env);
  return {
    enabled: env.AI_PAID_MODERATION_ENABLED === "true",
    credentials,
    credentialReady: Boolean(credentials.secretId && credentials.secretKey),
    region: clean(env.AI_MODERATION_TENCENT_REGION) || clean(env.TENCENTCLOUD_REGION) || "ap-guangzhou",
    bizType: clean(env.AI_MODERATION_TENCENT_BIZ_TYPE),
  };
}

function createTencentModerationClient(config) {
  const { Client } = require("tencentcloud-sdk-nodejs-tms").tms.v20201229;
  return new Client({
    credential: config.credentials,
    region: config.region,
    profile: { httpProfile: { endpoint: "tms.tencentcloudapi.com", reqTimeout: 15 } },
  });
}

async function moderateTextWithTencent({ content, dataId, env = process.env, client } = {}) {
  const config = moderationConfigFromEnv(env);
  if (!config.enabled) return { available: false, reason: "disabled" };
  if (!client && !config.credentialReady) return { available: false, reason: "credentials-unavailable" };
  const text = String(content || "");
  if (!text) return { available: true, status: "pass", suggestion: "Pass", provider: "tencent-tms" };
  const runtimeClient = client || createTencentModerationClient(config);
  const request = {
    Content: Buffer.from(text, "utf8").toString("base64"),
    DataId: String(dataId || crypto.createHash("sha256").update(text).digest("hex")).slice(0, 64),
    SourceLanguage: "zh",
    Type: "TEXT",
    ...(config.bizType ? { BizType: config.bizType } : {}),
  };
  const response = await runtimeClient.TextModeration(request);
  const suggestion = String(response && response.Suggestion || "Review");
  return {
    available: true,
    status: suggestion.toLowerCase() === "pass" ? "pass" : "reject",
    suggestion,
    provider: "tencent-tms",
  };
}

module.exports = {
  credentialsFromEnv,
  moderationConfigFromEnv,
  moderateTextWithTencent,
};
