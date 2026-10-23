const crypto = require("node:crypto");

const ACCOUNT_COLLECTION = "user_accounts";
const WELCOME_COMPUTE_MICROS = 10_000_000;

/*
 * familyId 由 openid 推导。原先用 replace 把非法字符悄悄换成下划线，
 * 这意味着两个不同的 openid 可能被洗成同一个 familyId——两个用户共用一个房间，
 * 故事互相串门。微信 openid 实际就是 [0-9A-Za-z_-]{28}，永远不触发替换，
 * 所以这是一个没有守卫的假设，正是用户变多以后才会咬人的那种。
 * 改为校验：不合规就报错，把一次静默的房间合并换成一声响亮的失败。
 * 与 drinkingTimeBridge/egress.js 已有的做法保持一致。
 */
function assertOpenid(openid) {
  if (typeof openid !== "string" || !/^[0-9A-Za-z_-]{1,128}$/.test(openid)) throw new Error("INVALID_OPENID");
  return openid;
}

function accountIdFor(openid) {
  return `account_${crypto.createHash("sha256").update(openid).digest("hex").slice(0, 24)}`;
}

function familyIdFor(openid) {
  return `family_${assertOpenid(openid)}`;
}

function normalizeDisplayName(value) {
  const displayName = String(value || "").trim().replace(/\s+/g, " ");
  if (!displayName) throw new Error("请告诉我们怎么称呼你");
  if (Array.from(displayName).length > 8) throw new Error("称呼最多 8 个字");
  return displayName;
}

function avatarTextFor(displayName) {
  return Array.from(String(displayName || "").trim())[0] || "忆";
}

function isAlreadyExistsError(error) {
  return /already exists|ResourceExist|COLLECTION_(ALREADY_)?EXIST|Table exist/i.test(
    String(error && error.errMsg ? error.errMsg : error),
  );
}

function isNotFoundError(error) {
  return /does not exist|not found|cannot find document/i.test(
    String(error && error.errMsg ? error.errMsg : error),
  );
}

async function ensureAccountCollection(db) {
  try {
    await db.createCollection(ACCOUNT_COLLECTION);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

async function linkCurrentAccount(db, context) {
  const openid = String(context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");

  await ensureAccountCollection(db);

  const accountDocumentId = accountIdFor(openid);
  const accountRef = db.collection(ACCOUNT_COLLECTION).doc(accountDocumentId);
  const now = db.serverDate();
  let exists = false;

  let existingAccount;
  try {
    const response = await accountRef.get();
    existingAccount = response.data || {};
    exists = true;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const accountId=String(existingAccount?.accountId||accountDocumentId);
  const primaryFamilyId=String(existingAccount?.primaryFamilyId||familyIdFor(openid));

  const accountData = {
    accountId,
    wxOpenId: openid,
    primaryFamilyId,
    status: "active",
    lastSeenAt: now,
    updatedAt: now,
    ...(context.UNIONID ? { wxUnionId: context.UNIONID } : {}),
  };

  // 10 算力是微信账号的一次性注册赠送。旧账号没有该字段时补领；这里写入
  // 固定余额而不是做增量，因此并发首次登录和重复登录都不会重复赠送。
  if (!Number.isSafeInteger(existingAccount && existingAccount.computeBalanceMicros)) {
    accountData.computeBalanceMicros = WELCOME_COMPUTE_MICROS;
    accountData.welcomeComputeGrantedAt = now;
  }

  if (exists) {
    await accountRef.update({ data: accountData });
  } else {
    await accountRef.set({ data: { ...accountData, createdAt: now } });
  }

  // Existing users already have this family document. New users may create it
  // immediately after this function returns, so the account record remains the
  // authoritative link even when this best-effort annotation updates zero rows.
  try {
    await db.collection("families").doc(primaryFamilyId).update({
      data: { ownerAccountId: accountId, updatedAt: now },
    });
  } catch (error) {
    if (!isNotFoundError(error)) console.warn("家庭空间账号标记暂未更新", error);
  }

  return {
    accountId,
    primaryFamilyId,
    displayName: String(existingAccount && existingAccount.displayName || ""),
    avatarText: String(existingAccount && existingAccount.avatarText || ""),
    profileComplete: Boolean(existingAccount && existingAccount.displayName),
    computeBalanceMicros: Number.isSafeInteger(accountData.computeBalanceMicros)
      ? accountData.computeBalanceMicros
      : Math.max(0, Number(existingAccount && existingAccount.computeBalanceMicros) || 0),
    computeRate: "",
  };
}

const PROFILE_NAME_REJECTED = "PROFILE_NAME_REJECTED";
const PROFILE_CHECK_UNAVAILABLE = "PROFILE_CHECK_UNAVAILABLE";

function profileError(code) {
  const message = code === PROFILE_NAME_REJECTED ? "这个称呼暂时不能使用" : "暂时无法检查这个称呼，请稍后再试";
  return Object.assign(new Error(message), { code });
}

/*
 * 称呼会展示给其他用户，保存前必须过内容安全检查。
 * checkName 返回 "pass" 或 "reject"；抛出异常、返回其他值、没有提供检查函数，一律按
 * “检查不可用”处理——不保存，绝不放行。
 */
async function assertNameAllowed(checkName, displayName) {
  let verdict;
  try {
    if (typeof checkName !== "function") throw new Error("NAME_CHECK_NOT_CONFIGURED");
    verdict = await checkName(displayName);
  } catch (error) {
    console.warn("称呼内容安全检查不可用，按未通过处理", error);
    throw profileError(PROFILE_CHECK_UNAVAILABLE);
  }
  if (verdict === "pass") return;
  throw profileError(verdict === "reject" ? PROFILE_NAME_REJECTED : PROFILE_CHECK_UNAVAILABLE);
}

/*
 * 微信 msgSecCheck（version 2，scene 1 = 资料类）。openid 取当前云函数确认的调用者。
 * pass -> "pass"；suggest 为 review/risky 或接口返回 87014 -> "reject"；
 * 其余（调用失败、返回缺少结果）-> 抛出，由 assertNameAllowed 按“检查不可用”处理。
 */
async function checkDisplayNameWith(security, displayName, openid) {
  let response;
  try {
    response = await security.msgSecCheck({ content: displayName, version: 2, scene: 1, openid });
  } catch (error) {
    if (error && (error.errCode === 87014 || /\b87014\b/.test(String(error.errMsg || error.message || "")))) return "reject";
    throw error;
  }
  const suggest = response && response.result && response.result.suggest;
  if (suggest === "pass") return "pass";
  if (suggest === "review" || suggest === "risky") return "reject";
  throw new Error("MSG_SEC_CHECK_NO_RESULT");
}

async function updateCurrentProfile(db, context, requestedName, checkName) {
  const identity = await linkCurrentAccount(db, context);
  const displayName = normalizeDisplayName(requestedName);
  await assertNameAllowed(checkName, displayName);
  const avatarText = avatarTextFor(displayName);
  const now = db.serverDate();
  await db.collection(ACCOUNT_COLLECTION).doc(identity.accountId).update({
    data: { displayName, avatarText, profileCompletedAt: now, updatedAt: now },
  });
  await syncMembershipProfiles(db, identity, displayName, avatarText, now);
  return { ...identity, displayName, avatarText, profileComplete: true };
}

/*
 * 只同步自己主家里的「自己」这个成员：那是自己给自己起的名字。
 * 别人记忆之家里代表我的成员文档，name 是对方邀请时写的备注，不能被我的新称呼覆盖；
 * 别人看到我发出的内容时，由读取方按 accountId 现查 user_accounts.displayName。
 * 旧版个人房间的第一个成员一直用固定的 `owner` 编号，早期没有 accountId，这里一并补上。
 */
async function syncMembershipProfiles(db, identity, displayName, avatarText, now) {
  try {
    await db.collection("family_members").doc(`${identity.primaryFamilyId}_owner`).update({
      data: { accountId: identity.accountId, name: displayName, avatarText, updatedAt: now },
    });
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

module.exports = {
  ACCOUNT_COLLECTION,
  WELCOME_COMPUTE_MICROS,
  accountIdFor,
  avatarTextFor,
  familyIdFor,
  linkCurrentAccount,
  PROFILE_CHECK_UNAVAILABLE,
  PROFILE_NAME_REJECTED,
  checkDisplayNameWith,
  normalizeDisplayName,
  syncMembershipProfiles,
  updateCurrentProfile,
};
