const crypto = require("node:crypto");

const ACCOUNT_COLLECTION = "user_accounts";
const WELCOME_COMPUTE_MICROS = 10_000_000;

function sanitizeDocumentPart(value) {
  return value.replace(/[^0-9A-Za-z_-]/g, "_");
}

function accountIdFor(openid) {
  return `account_${crypto.createHash("sha256").update(openid).digest("hex").slice(0, 24)}`;
}

function familyIdFor(openid) {
  return `family_${sanitizeDocumentPart(openid)}`;
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
    computeRate: "¥1 = 2 算力",
  };
}

async function updateCurrentProfile(db, context, requestedName) {
  const identity = await linkCurrentAccount(db, context);
  const displayName = normalizeDisplayName(requestedName);
  const avatarText = avatarTextFor(displayName);
  const now = db.serverDate();
  await db.collection(ACCOUNT_COLLECTION).doc(identity.accountId).update({
    data: { displayName, avatarText, profileCompletedAt: now, updatedAt: now },
  });
  await syncMembershipProfiles(db, identity, displayName, avatarText, now);
  return { ...identity, displayName, avatarText, profileComplete: true };
}

async function syncMembershipProfiles(db, identity, displayName, avatarText, now) {
  const memberIds = new Set();
  try {
    const response = await db.collection("family_members")
      .where({ accountId: identity.accountId }).limit(20).get();
    response.data.forEach(member => member._id && memberIds.add(member._id));
  } catch (error) {
    console.warn("已加入记忆之家的称呼暂未同步", error);
  }

  // The first member in legacy personal rooms has always used the stable
  // `owner` id, but did not carry accountId until account binding was added.
  memberIds.add(`${identity.primaryFamilyId}_owner`);
  await Promise.all(Array.from(memberIds).map(async (documentId) => {
    try {
      await db.collection("family_members").doc(documentId).update({
        data: { accountId: identity.accountId, name: displayName, avatarText, updatedAt: now },
      });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }));
}

module.exports = {
  ACCOUNT_COLLECTION,
  WELCOME_COMPUTE_MICROS,
  accountIdFor,
  avatarTextFor,
  familyIdFor,
  linkCurrentAccount,
  normalizeDisplayName,
  syncMembershipProfiles,
  updateCurrentProfile,
};
