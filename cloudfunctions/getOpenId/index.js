const cloud = require("wx-server-sdk");
const { loadComputeBalance } = require("./computeGateway");
const { readRecentTextUsage } = require("./textComputeUsage");
const {
  PROFILE_CHECK_UNAVAILABLE,
  PROFILE_NAME_REJECTED,
  accountIdFor,
  checkDisplayNameWith,
  familyIdFor,
  linkCurrentAccount,
  updateCurrentProfile,
} = require("./account");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

async function main(event = {}) {
  const context = cloud.getWXContext();
  const openid = String(context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");
  // This public action is read-only. Never expose caller-controlled reserve,
  // settlement, cost or identity fields through the client cloud-function API.
  if (event.action === "computeBalance") return loadComputeBalance(context);
  if (event.action === "textComputeUsage") return readRecentTextUsage(cloud.database(), context);

  const fallbackIdentity = {
    accountId: accountIdFor(openid),
    primaryFamilyId: familyIdFor(openid),
  };
  let identity = fallbackIdentity;
  let accountLinked = false;

  try {
    identity = event.action === "updateProfile"
      ? await updateCurrentProfile(
        cloud.database(),
        context,
        event.displayName,
        name => checkDisplayNameWith(cloud.openapi.security, name, openid),
      )
      : await linkCurrentAccount(cloud.database(), context);
    accountLinked = true;
  } catch (error) {
    // 只有「称呼被拒绝」和「检查不可用」两种情况结构化返回，让用户看到准确原因；
    // 其余失败（包括登录关联）仍保持原行为：记录日志，返回 accountLinked=false。
    if (event.action === "updateProfile" && error
      && (error.code === PROFILE_NAME_REJECTED || error.code === PROFILE_CHECK_UNAVAILABLE)) {
      return { openid, accountLinked: false, profileError: { code: error.code, message: error.message } };
    }
    // Account metadata must never block access to existing memories. The client
    // still receives OPENID and can retry linking the next time it launches.
    console.error("微信账号关联暂未完成", error);
  }

  // Provision the canonical gift on login once the bridge is explicitly enabled.
  // A wallet outage must not lock the user out of existing stories or photos.
  if (accountLinked && process.env.SHIGUANG_COMPUTE_ENABLED === "true") {
    try { await loadComputeBalance(context); }
    catch { console.warn("共享算力暂未同步，下次读取时重试"); }
  }

  return {
    openid,
    account: identity,
    accountLinked,
  };
}

module.exports = { main };
