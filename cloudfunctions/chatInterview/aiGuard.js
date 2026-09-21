const crypto = require("node:crypto");

const OPENID = /^[0-9A-Za-z_-]{1,128}$/;
const APP_ID = /^wx[0-9A-Za-z_-]{1,80}$/;
const ACCOUNT_ID = /^account_[0-9a-f]{24}$/;
const FAMILY_ID = /^family_[0-9A-Za-z_-]{1,120}$/;
const DEFAULT_DAILY_LIMIT = 60;
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const MODERATION_CHUNK = 2_500;

function aiError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function accountDocumentIdFor(openid) {
  return `account_${crypto.createHash("sha256").update(openid).digest("hex").slice(0, 24)}`;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function chinaDayKey(nowMs) {
  return new Date(nowMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validateAccount(account, identity) {
  return Boolean(
    account &&
    account.status === "active" &&
    account.wxOpenId === identity.openid &&
    account.accountId === identity.accountId &&
    account.primaryFamilyId === identity.familyId,
  );
}

function assertServerReady() {
  if (process.env.AI_SERVER_RELEASE_READY !== "true") {
    throw aiError("AI_RELEASE_NOT_READY", "在线 AI 尚未完成发布验收");
  }
}

function assertExpectedApp(context) {
  const appId = String(context && context.APPID || "").trim();
  const openid = String(context && context.OPENID || "").trim();
  if (!APP_ID.test(appId) || !OPENID.test(openid)) throw aiError("AUTH_REQUIRED", "请重新登录");
  const expectedAppId = String(process.env.WECHAT_APP_ID || "").trim();
  if (!APP_ID.test(expectedAppId) || appId !== expectedAppId) {
    throw aiError("APP_ID_MISMATCH", "当前小程序没有获得在线 AI 权限");
  }
  return { appId, openid };
}

async function resolveActiveIdentity(db, context) {
  const { appId, openid } = assertExpectedApp(context);
  const accountDocumentId = accountDocumentIdFor(openid);
  let account;
  try {
    account = (await db.collection("user_accounts").doc(accountDocumentId).get()).data;
  } catch {
    throw aiError("IDENTITY_UNLINKED", "账号还没有关联到企业小程序");
  }
  const accountId = String(account && account.accountId || "");
  const familyId = String(account && account.primaryFamilyId || "");
  const identity = { appId, openid, accountDocumentId, accountId, familyId };
  if (!ACCOUNT_ID.test(accountId) || !FAMILY_ID.test(familyId) || !validateAccount(account, identity)) {
    throw aiError("IDENTITY_UNLINKED", "账号还没有关联到企业小程序");
  }
  let family;
  try {
    family = (await db.collection("families").doc(familyId).get()).data;
  } catch {
    throw aiError("IDENTITY_UNLINKED", "家庭数据还没有迁移完成");
  }
  if (!family || family.ownerAccountId !== accountId) {
    throw aiError("IDENTITY_UNLINKED", "家庭数据还没有迁移完成");
  }
  return identity;
}

async function assertIdentityStillActive(db, identity) {
  let account;
  try {
    account = (await db.collection("user_accounts").doc(identity.accountDocumentId).get()).data;
  } catch {
    throw aiError("IDENTITY_REVOKED", "账号权限已经变化，请重新登录");
  }
  if (!validateAccount(account, identity)) {
    throw aiError("IDENTITY_REVOKED", "账号权限已经变化，请重新登录");
  }
}

async function reserveAiRequest(db, identity, kind, nowMs = Date.now()) {
  const dailyLimit = positiveInteger(process.env.AI_DAILY_REQUEST_LIMIT, DEFAULT_DAILY_LIMIT, 500);
  const minIntervalMs = positiveInteger(process.env.AI_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS, 60_000);
  const dayKey = chinaDayKey(nowMs);
  await db.runTransaction(async transaction => {
    const ref = transaction.collection("user_accounts").doc(identity.accountDocumentId);
    let account;
    try {
      account = (await ref.get()).data;
    } catch {
      throw aiError("IDENTITY_REVOKED", "账号权限已经变化，请重新登录");
    }
    if (!validateAccount(account, identity)) throw aiError("IDENTITY_REVOKED", "账号权限已经变化，请重新登录");
    const previous = account.aiUsage && account.aiUsage.dayKey === dayKey ? account.aiUsage : {};
    const count = Number.isSafeInteger(previous.count) ? previous.count : 0;
    const lastAtMs = Number.isSafeInteger(previous.lastAtMs) ? previous.lastAtMs : 0;
    if (nowMs - lastAtMs < minIntervalMs) throw aiError("AI_RATE_LIMITED", "操作太频繁，请稍后再试");
    if (count >= dailyLimit) throw aiError("AI_DAILY_LIMIT", "今天的 AI 使用次数已达到上限");
    const byKind = previous.byKind && typeof previous.byKind === "object" ? previous.byKind : {};
    await ref.update({ data: { aiUsage: {
      dayKey,
      count: count + 1,
      lastAtMs: nowMs,
      byKind: { ...byKind, [kind]: (Number(byKind[kind]) || 0) + 1 },
    } } });
  });
}

async function moderateText(cloud, openid, value, title) {
  const content = Array.from(String(value || "").trim());
  if (!content.length) return;
  if (!cloud || !cloud.openapi || !cloud.openapi.security || typeof cloud.openapi.security.msgSecCheck !== "function") {
    throw aiError("AI_CONTENT_CHECK_UNAVAILABLE", "内容安全检查暂时不可用");
  }
  for (let offset = 0; offset < content.length; offset += MODERATION_CHUNK) {
    try {
      const response = await cloud.openapi.security.msgSecCheck({
        content: content.slice(offset, offset + MODERATION_CHUNK).join(""),
        version: 2,
        scene: 4,
        openid,
        ...(offset === 0 && title ? { title: Array.from(String(title)).slice(0, 100).join("") } : {}),
      });
      if (response && response.result && response.result.suggest === "pass") continue;
      throw aiError("AI_CONTENT_REJECTED", "这段内容暂时不能交给 AI 处理");
    } catch (error) {
      if (error && error.code === "AI_CONTENT_REJECTED") throw error;
      throw aiError("AI_CONTENT_CHECK_UNAVAILABLE", "内容安全检查暂时不可用");
    }
  }
}

function diagnoseAuthorized(event) {
  const expected = String(process.env.AI_DIAGNOSE_TOKEN || "");
  return expected.length >= 24 && typeof event?.diagnoseToken === "string" && event.diagnoseToken === expected;
}

module.exports = {
  accountDocumentIdFor,
  aiError,
  assertIdentityStillActive,
  assertServerReady,
  chinaDayKey,
  diagnoseAuthorized,
  moderateText,
  reserveAiRequest,
  resolveActiveIdentity,
};
