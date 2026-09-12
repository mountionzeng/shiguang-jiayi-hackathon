const COLLECTION = "user_consents";
let cloudRuntime;

function cloud() {
  if (!cloudRuntime) {
    cloudRuntime = require("wx-server-sdk");
    cloudRuntime.init({ env: cloudRuntime.DYNAMIC_CURRENT_ENV });
  }
  return cloudRuntime;
}

function database() {
  return cloud().database();
}

function sanitizeDocumentPart(value) {
  return String(value || "").replace(/[^0-9A-Za-z_-]/g, "_");
}

function consentDocId(openid, version) {
  return `${sanitizeDocumentPart(openid)}_${sanitizeDocumentPart(version)}`;
}

function sanitizeText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeScopes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((scope) => sanitizeText(scope, 60))
    .filter(Boolean)
    .slice(0, 20);
}

function collectionMissing(error) {
  const message = String(error && error.errMsg ? error.errMsg : error);
  return (
    message.includes("collection not exists") ||
    message.includes("Db or Table not exist") ||
    message.includes("DATABASE_COLLECTION_NOT_EXIST")
  );
}

async function getConsent(openid, version) {
  const db = database();
  try {
    const response = await db.collection(COLLECTION).doc(consentDocId(openid, version)).get();
    return response.data || null;
  } catch (error) {
    if (collectionMissing(error)) return null;
    const message = String(error && error.errMsg ? error.errMsg : error);
    if (message.includes("does not exist") || message.includes("document.get:fail")) {
      return null;
    }
    throw error;
  }
}

async function saveConsent(openid, event) {
  const db = database();
  const termsVersion = sanitizeText(event.termsVersion, 40);
  if (!termsVersion) throw new Error("TERMS_VERSION_REQUIRED");

  const record = {
    openid,
    termsVersion,
    termsTitle: sanitizeText(event.termsTitle, 80),
    privacyVersion: sanitizeText(event.privacyVersion || event.termsVersion, 40),
    aiTermsVersion: sanitizeText(event.aiTermsVersion || event.termsVersion, 40),
    consentScopes: normalizeScopes(event.consentScopes),
    source: sanitizeText(event.source || "first_launch", 40),
    appVersion: sanitizeText(event.appVersion, 40),
    platform: sanitizeText(event.platform, 40),
    createdAt: db.serverDate(),
    updatedAt: db.serverDate(),
  };

  await db.collection(COLLECTION).doc(consentDocId(openid, termsVersion)).set({
    data: record,
  });

  return record;
}

async function main(event = {}) {
  const cloudSdk = cloud();
  const context = cloudSdk.getWXContext();
  const openid = String(context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");

  const action = sanitizeText(event.action || "status", 20);
  if (action === "accept") {
    const consent = await saveConsent(openid, event);
    return {
      ok: true,
      openid,
      acceptedRequiredVersion: true,
      termsVersion: consent.termsVersion,
    };
  }

  const requiredVersion = sanitizeText(event.requiredVersion || event.termsVersion, 40);
  if (!requiredVersion) throw new Error("REQUIRED_VERSION_REQUIRED");
  const consent = await getConsent(openid, requiredVersion);
  return {
    ok: true,
    openid,
    requiredVersion,
    acceptedRequiredVersion: Boolean(consent),
    acceptedAt: consent?.createdAt,
  };
}

module.exports = {
  main,
  _test: {
    collectionMissing,
    consentDocId,
    normalizeScopes,
    sanitizeText,
  },
};
