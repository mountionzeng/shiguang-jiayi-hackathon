const { accountDocumentIdFor, aiError, assertExpectedApp } = require("./aiGuard.js");

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function main(event, dependencies = {}) {
  const version = positiveInteger(event && event.version);
  if (!version) throw new Error("CONSENT_VERSION_REQUIRED");

  let cloud = dependencies.cloud;
  let db = dependencies.db;
  let openid = dependencies.openid;
  if (!dependencies.skipGuard) {
    cloud = cloud || require("wx-server-sdk");
    if (cloud.init) cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
    db = db || cloud.database();
    openid = assertExpectedApp(cloud.getWXContext()).openid;
  }

  const accountDocumentId = accountDocumentIdFor(openid);
  const acceptedAt = new Date().toISOString();
  try {
    await db.collection("user_accounts").doc(accountDocumentId).update({
      data: { aiConsent: { version, acceptedAt } },
    });
  } catch {
    throw aiError("IDENTITY_UNLINKED", "账号还没有关联到企业小程序");
  }
  return { version, acceptedAt };
}

module.exports = { main };
