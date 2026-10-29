const crypto = require("node:crypto");
const http = require("node:http");

const ROLE_CREDENTIAL_HOST = "metadata.tencentyun.com";
const ROLE_CREDENTIAL_PATH = "/meta-data/cam/security-credentials/TCB_QcsRole";
const ROLE_CREDENTIAL_MAX_BYTES = 16 * 1024;
const ROLE_CREDENTIAL_TIMEOUT_MS = 1_500;
let cachedRoleCredentials = null;

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

function roleCredentialsFromPayload(payload) {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  return {
    secretId: clean(parsed && parsed.TmpSecretId),
    secretKey: clean(parsed && parsed.TmpSecretKey),
    token: clean(parsed && parsed.Token),
    expiresAtMs: Number(parsed && parsed.ExpiredTime) * 1000,
  };
}

function loadCloudBaseRoleCredentials({ request = http.get, nowMs = Date.now() } = {}) {
  if (cachedRoleCredentials && cachedRoleCredentials.expiresAtMs > nowMs + 5 * 60 * 1000) {
    return Promise.resolve(cachedRoleCredentials);
  }
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: ROLE_CREDENTIAL_HOST,
      path: ROLE_CREDENTIAL_PATH,
      method: "GET",
      timeout: ROLE_CREDENTIAL_TIMEOUT_MS,
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(Object.assign(new Error("CLOUDBASE_ROLE_CREDENTIALS_UNAVAILABLE"), { code: "CLOUDBASE_ROLE_CREDENTIALS_UNAVAILABLE" }));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("error", reject);
      response.on("aborted", () => reject(Object.assign(new Error("CLOUDBASE_ROLE_CREDENTIALS_UNAVAILABLE"), { code: "CLOUDBASE_ROLE_CREDENTIALS_UNAVAILABLE" })));
      response.on("data", chunk => {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > ROLE_CREDENTIAL_MAX_BYTES) {
          response.destroy(Object.assign(new Error("CLOUDBASE_ROLE_CREDENTIALS_INVALID"), { code: "CLOUDBASE_ROLE_CREDENTIALS_INVALID" }));
        }
      });
      response.on("end", () => {
        try {
          const credentials = roleCredentialsFromPayload(body);
          if (!credentials.secretId || !credentials.secretKey || !credentials.token || !Number.isFinite(credentials.expiresAtMs)) {
            throw Object.assign(new Error("CLOUDBASE_ROLE_CREDENTIALS_INVALID"), { code: "CLOUDBASE_ROLE_CREDENTIALS_INVALID" });
          }
          if (credentials.expiresAtMs <= Date.now() + 60 * 1000) {
            throw Object.assign(new Error("CLOUDBASE_ROLE_CREDENTIALS_EXPIRED"), { code: "CLOUDBASE_ROLE_CREDENTIALS_EXPIRED" });
          }
          cachedRoleCredentials = credentials;
          resolve(credentials);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("CLOUDBASE_ROLE_CREDENTIALS_TIMEOUT"), { code: "CLOUDBASE_ROLE_CREDENTIALS_TIMEOUT" })));
    req.on("error", reject);
  });
}

async function resolveModerationCredentials({ env = process.env, loadRuntimeCredentials = loadCloudBaseRoleCredentials } = {}) {
  const configured = credentialsFromEnv(env);
  if (configured.secretId && configured.secretKey) return configured;
  const runtimeReady = Boolean(clean(env.TCB_ENV) || clean(env.SCF_NAMESPACE) || clean(env.TENCENTCLOUD_RUNENV));
  if (!runtimeReady || typeof loadRuntimeCredentials !== "function") return configured;
  const credential = await loadRuntimeCredentials();
  return {
    secretId: clean(credential.secretId || credential.id),
    secretKey: clean(credential.secretKey || credential.key),
    token: clean(credential.token),
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
  if (!client && !config.credentialReady) {
    config.credentials = await resolveModerationCredentials({ env });
    config.credentialReady = Boolean(config.credentials.secretId && config.credentials.secretKey);
  }
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
  loadCloudBaseRoleCredentials,
  moderationConfigFromEnv,
  moderateTextWithTencent,
  roleCredentialsFromPayload,
  resolveModerationCredentials,
};
