const cloud = require("wx-server-sdk");
const {
  accountIdFor,
  familyIdFor,
  linkCurrentAccount,
  updateCurrentProfile,
} = require("./account");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

async function main(event = {}) {
  const context = cloud.getWXContext();
  const openid = String(context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");

  const fallbackIdentity = {
    accountId: accountIdFor(openid),
    primaryFamilyId: familyIdFor(openid),
  };
  let identity = fallbackIdentity;
  let accountLinked = false;

  try {
    identity = event.action === "updateProfile"
      ? await updateCurrentProfile(cloud.database(), context, event.displayName)
      : await linkCurrentAccount(cloud.database(), context);
    accountLinked = true;
  } catch (error) {
    // Account metadata must never block access to existing memories. The client
    // still receives OPENID and can retry linking the next time it launches.
    console.error("微信账号关联暂未完成", error);
  }

  return {
    openid,
    account: identity,
    accountLinked,
  };
}

module.exports = { main };
