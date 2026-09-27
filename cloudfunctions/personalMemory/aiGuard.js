const crypto = require("node:crypto");
const { moderateTextWithTencent } = require("./tencentModeration");

const OPENID = /^[0-9A-Za-z_-]{1,128}$/;
const APP_ID = /^wx[0-9A-Za-z_-]{1,80}$/;
const ACCOUNT_ID = /^account_[0-9a-f]{24}$/;
const FAMILY_ID = /^family_[0-9A-Za-z_-]{1,120}$/;
const DEFAULT_DAILY_LIMIT = 60;
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const MODERATION_CHUNK = 2_500;
const MODERATION_CACHE_COLLECTION = "ai_moderation_checks";
const AI_CONSENT_VERSION = 1;

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
  return { ...identity, account };
}

function assertConsentVersion(account, requiredVersion) {
  const version = Number(account && account.aiConsent && account.aiConsent.version);
  if (!Number.isSafeInteger(version) || version < requiredVersion) throw aiError("AI_CONSENT_REQUIRED", "请先同意在线 AI 使用授权");
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

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function moderationCacheId(openid, dayKey, scene, chunk, title) {
  return `mod_${hashText(["v1", openid, dayKey, scene, title || "", chunk].join("\0")).slice(0, 48)}`;
}

async function readModerationCache(db, cacheId, dayKey) {
  if (!db || !cacheId) return "miss";
  try {
    const data = (await db.collection(MODERATION_CACHE_COLLECTION).doc(cacheId).get()).data;
    if (!data || data.dayKey !== dayKey) return "miss";
    if (data.status === "pass") return "pass";
    if (data.status === "reject") return "reject";
  } catch {}
  return "miss";
}

async function writeModerationCache(db, cacheId, data) {
  if (!db || !cacheId) return;
  try {
    const ref = db.collection(MODERATION_CACHE_COLLECTION).doc(cacheId);
    if (typeof ref.set === "function") await ref.set({ data });
    else if (typeof ref.update === "function") await ref.update({ data });
  } catch {}
}

async function tryPaidModeration(chunk, title, cacheId, dayKey, nowMs, options) {
  const paidModeration = options && typeof options.paidModeration === "function"
    ? options.paidModeration
    : moderateTextWithTencent;
  try {
    const content = title ? `${title}\n${chunk}` : chunk;
    const result = await paidModeration({ content, dataId: cacheId, env: options && options.env });
    if (!result || result.available !== true) return { handled: false };
    if (result.status === "pass") {
      await writeModerationCache(options && options.db, cacheId, {
        dayKey,
        status: "pass",
        suggest: "pass",
        provider: "tencent-tms",
        checkedAtMs: nowMs,
      });
      return { handled: true, passed: true };
    }
    await writeModerationCache(options && options.db, cacheId, {
      dayKey,
      status: "reject",
      suggest: String(result.suggestion || "review").slice(0, 24),
      provider: "tencent-tms",
      checkedAtMs: nowMs,
    });
    throw aiError("AI_CONTENT_REJECTED", "这段内容暂时不能交给 AI 处理");
  } catch (error) {
    if (error && error.code === "AI_CONTENT_REJECTED") throw error;
    console.warn("[ai-moderation]", {
      reason: "paid-provider-unavailable",
      ...(typeof error?.code === "string" ? { providerCode: error.code.slice(0, 80) } : {}),
    });
    return { handled: false };
  }
}


async function moderateText(cloud, openid, value, title, options = {}) {
  const content = Array.from(String(value || "").trim());
  if (!content.length) return;
  const wechatModeration = cloud && cloud.openapi && cloud.openapi.security &&
    typeof cloud.openapi.security.msgSecCheck === "function"
    ? cloud.openapi.security.msgSecCheck.bind(cloud.openapi.security)
    : null;
  const db = options && options.db;
  const nowMs = Number.isSafeInteger(options && options.nowMs) ? options.nowMs : Date.now();
  const dayKey = chinaDayKey(nowMs);
  for (let offset = 0; offset < content.length; offset += MODERATION_CHUNK) {
    const chunk = content.slice(offset, offset + MODERATION_CHUNK).join("");
    const safeTitle = offset === 0 && title ? Array.from(String(title)).slice(0, 100).join("") : "";
    const cacheId = db ? moderationCacheId(openid, dayKey, 4, chunk, safeTitle) : "";
    const cached = await readModerationCache(db, cacheId, dayKey);
    if (cached === "pass") continue;
    if (cached === "reject") throw aiError("AI_CONTENT_REJECTED", "这段内容暂时不能交给 AI 处理");
    try {
      if (!wechatModeration) throw Object.assign(new Error("WECHAT_MODERATION_UNAVAILABLE"), { code: "WECHAT_MODERATION_UNAVAILABLE" });
      const response = await wechatModeration({
        content: chunk,
        version: 2,
        scene: 4,
        openid,
        ...(safeTitle ? { title: safeTitle } : {}),
      });
      const result = response && response.result ? response.result : {};
      if (result.suggest === "pass") {
        await writeModerationCache(db, cacheId, { dayKey, status: "pass", suggest: "pass", checkedAtMs: nowMs });
        continue;
      }
      await writeModerationCache(db, cacheId, {
        dayKey,
        status: "reject",
        suggest: String(result.suggest || "review").slice(0, 24),
        checkedAtMs: nowMs,
      });
      throw aiError("AI_CONTENT_REJECTED", "这段内容暂时不能交给 AI 处理");
    } catch (error) {
      if (error && error.code === "AI_CONTENT_REJECTED") throw error;
      const providerCode = Number(error && (error.errCode ?? error.errcode));
      const quotaExhausted = providerCode === 45009 || /reach max api daily quota limit/i.test(String(error && (error.errMsg || error.message) || ""));
      const paid = await tryPaidModeration(chunk, safeTitle, cacheId, dayKey, nowMs, { ...options, db });
      if (paid.handled && paid.passed) continue;
      // Record only a category and numeric code; SDK errors can contain private request data.
      console.warn("[ai-moderation]", {
        reason: quotaExhausted ? "daily-quota-exhausted" : "service-unavailable",
        ...(Number.isSafeInteger(providerCode) ? { providerCode } : {}),
      });
      if (quotaExhausted) throw aiError("AI_CONTENT_CHECK_QUOTA_EXHAUSTED", "今日内容安全检查额度已用完，请稍后再试");
      throw aiError("AI_CONTENT_CHECK_UNAVAILABLE", "内容安全检查暂时不可用");
    }
  }
}
function diagnoseAuthorized(event) {
  const expected = String(process.env.AI_DIAGNOSE_TOKEN || "");
  return expected.length >= 24 && typeof event?.diagnoseToken === "string" && event.diagnoseToken === expected;
}

module.exports = {
  AI_CONSENT_VERSION,
  accountDocumentIdFor,
  aiError,
  assertConsentVersion,
  assertExpectedApp,
  assertIdentityStillActive,
  assertServerReady,
  chinaDayKey,
  diagnoseAuthorized,
  moderateText,
  reserveAiRequest,
  resolveActiveIdentity,
};
