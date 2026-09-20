const cloud = require("wx-server-sdk");
const {
  accountIdFor,
  assertInvitationUsable,
  avatarTextFor,
  currentMemoryAttribution,
  expiresAtFrom,
  inviteToken,
  normalizeContributionInput,
  normalizeInviteInput,
  publicInvitation,
  visibleMemoriesForAccess,
  visibleMembersForAccess,
} = require("./core");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = ["user_accounts", "family_invitations", "family_access"];

function errorMessage(error) {
  return String(error && error.errMsg ? error.errMsg : error);
}

function isExisting(error) {
  return /already exists|ResourceExist|COLLECTION_(ALREADY_)?EXIST|Table exist/i.test(errorMessage(error));
}

function isMissing(error) {
  return /does not exist|not found|cannot find document|Table not exist/i.test(errorMessage(error));
}

async function ensureCollections() {
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
    } catch (error) {
      if (!isExisting(error)) throw error;
    }
  }
}

function identity() {
  const context = cloud.getWXContext();
  const openid = String(context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");
  return { context, openid, accountId: accountIdFor(openid) };
}

async function getDoc(collectionName, id) {
  try {
    const response = await db.collection(collectionName).doc(id).get();
    return response.data;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function requireAccount(accountId) {
  const account = await getDoc("user_accounts", accountId);
  if (!account) throw new Error("请先完成拾光称呼设置");
  return account;
}

async function loadAll(collectionName, familyId) {
  const rows = [];
  for (let offset = 0; ; offset += 20) {
    const response = await db.collection(collectionName).where({ familyId })
      .orderBy("_id", "asc").skip(offset).limit(20).get();
    rows.push(...response.data);
    if (response.data.length < 20) return rows;
  }
}

async function createInvite(event, accountId) {
  const account = await requireAccount(accountId);
  if (!account.displayName) throw new Error("请先在“我的”里设置称呼");
  const input = normalizeInviteInput(event);
  const familyId = String(account.primaryFamilyId || "");
  if (!familyId) throw new Error("没有找到你的记忆之家");
  const family = await getDoc("families", familyId);
  if (!family) throw new Error("请先创建自己的记录档案");
  if (family.ownerAccountId && family.ownerAccountId !== accountId) {
    throw new Error("只有记忆之家的主人可以邀请成员");
  }
  if (!family.ownerAccountId) {
    await db.collection("families").doc(familyId).update({
      data: { ownerAccountId: accountId, updatedAt: db.serverDate() },
    });
  }

  // Older rooms predate WeChat account binding. Bind the creator's original
  // member record now so shared-room reads never have to guess who the owner is.
  const familyMembers = await loadAll("family_members", familyId);
  const ownerMember = familyMembers.find(member => member.accountId === accountId) ||
    familyMembers.find(member => member.memberId === "owner") ||
    familyMembers.find(member => member.role === "owner");
  if (ownerMember && ownerMember.accountId !== accountId) {
    await db.collection("family_members").doc(ownerMember._id || `${familyId}_${ownerMember.memberId}`).update({
      data: { accountId, updatedAt: db.serverDate() },
    });
  }

  const token = inviteToken();
  const expiresAt = expiresAtFrom(Date.now());
  const invitation = {
    token,
    familyId,
    inviterAccountId: accountId,
    inviterName: account.displayName,
    inviteeName: input.inviteeName,
    relation: input.relation,
    roomName: family.roomName || "我们的记忆之家",
    status: "pending",
    expiresAt,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate(),
  };
  await db.collection("family_invitations").doc(token).set({ data: invitation });

  return { invitation: publicInvitation(invitation) };
}

async function createInviteCode(event, accountId) {
  const token = String(event.token || "").trim();
  if (!token) throw new Error("邀请信息不完整");
  const invitation = await getDoc("family_invitations", token);
  if (!invitation || invitation.inviterAccountId !== accountId) {
    throw new Error("只能为自己建立的邀请生成图片");
  }

  let codeBase64 = "";
  try {
    const response = await cloud.openapi.wxacode.getUnlimited({
      scene: token,
      page: "pages/invite/invite",
      checkPath: false,
      envVersion: ["develop", "trial", "release"].includes(event.envVersion)
        ? event.envVersion
        : "release",
      width: 360,
    });
    const buffer = response && response.buffer ? response.buffer : response;
    if (Buffer.isBuffer(buffer)) codeBase64 = buffer.toString("base64");
  } catch (error) {
    console.error("邀请小程序码生成失败", error);
    throw new Error("小程序码暂时生成失败，请稍后重试");
  }
  if (!codeBase64) throw new Error("小程序码返回格式异常，请稍后重试");
  return { codeBase64 };
}

async function getInvite(event, accountId) {
  const token = String(event.token || "").trim();
  if (!token) throw new Error("邀请信息不完整");
  const invitation = assertInvitationUsable(
    await getDoc("family_invitations", token),
    accountId,
    Date.now(),
  );
  return { invitation: publicInvitation(invitation, accountId) };
}

async function acceptInvite(event, accountId) {
  const token = String(event.token || "").trim();
  if (!token) throw new Error("邀请信息不完整");
  const account = await requireAccount(accountId);
  const nowMs = Date.now();

  return db.runTransaction(async (transaction) => {
    const inviteRef = transaction.collection("family_invitations").doc(token);
    const response = await inviteRef.get();
    const invitation = assertInvitationUsable(response.data, accountId, nowMs);
    const memberId = invitation.memberId || `wx_${accountId}`;
    const familyId = invitation.familyId;
    const now = db.serverDate();

    await transaction.collection("family_access").doc(`${familyId}_${accountId}`).set({
      data: {
        familyId,
        accountId,
        memberId,
        role: "contributor",
        status: "active",
        joinedAt: now,
        updatedAt: now,
      },
    });
    await transaction.collection("family_members").doc(`${familyId}_${memberId}`).set({
      data: {
        familyId,
        memberId,
        id: memberId,
        accountId,
        name: invitation.inviteeName,
        relation: invitation.relation,
        avatarText: avatarTextFor(invitation.inviteeName),
        role: "contributor",
        kind: "person",
        updatedAt: now,
      },
    });
    await inviteRef.update({
      data: {
        status: "accepted",
        acceptedByAccountId: accountId,
        memberId,
        acceptedAt: now,
        updatedAt: now,
      },
    });
    if (!account.displayName) {
      await transaction.collection("user_accounts").doc(accountId).update({
        data: {
          displayName: invitation.inviteeName,
          avatarText: avatarTextFor(invitation.inviteeName),
          profileCompletedAt: now,
          updatedAt: now,
        },
      });
    }

    return {
      invitation: publicInvitation({
        ...invitation,
        status: "accepted",
        acceptedByAccountId: accountId,
        memberId,
      }, accountId),
    };
  });
}

async function requireFamilyAccess(familyId, accountId) {
  if (!familyId) throw new Error("记忆之家信息不完整");
  const account = await requireAccount(accountId);
  if (account.primaryFamilyId === familyId) {
    const members = await loadAll("family_members", familyId);
    const owner = members.find(member => member.accountId === accountId) ||
      members.find(member => member.memberId === "owner") ||
      members.find(member => member.role === "owner");
    if (!owner) throw new Error("请先创建自己的记录档案");
    return { role: "owner", memberId: owner.memberId };
  }
  const access = await getDoc("family_access", `${familyId}_${accountId}`);
  if (!access || access.status !== "active") throw new Error("你还没有加入这个记忆之家");
  const member = await getDoc("family_members", `${familyId}_${access.memberId}`);
  if (!member || member.accountId !== accountId || member.memberId !== access.memberId) {
    throw new Error("成员身份已失效，请重新接受邀请");
  }
  return access;
}

async function loadRoom(event, accountId) {
  const familyId = String(event.familyId || "").trim();
  const access = await requireFamilyAccess(familyId, accountId);
  const family = await getDoc("families", familyId);
  if (!family) throw new Error("这个记忆之家已不存在");
  const [members, allMemories] = await Promise.all([
    loadAll("family_members", familyId),
    loadAll("memories", familyId),
  ]);
  const memberId = access.memberId;
  const memories = visibleMemoriesForAccess(allMemories, access);
  const visibleMembers = visibleMembersForAccess(members, access, family.ownerAccountId);
  const visibleMemberIds = new Set(visibleMembers.map(member => member.memberId));
  const membersById = new Map(members.map(member => [member.memberId || member.id, member]));

  return {
    familyId,
    viewerMemberId: memberId,
    viewerRole: access.role,
    state: {
      roomName: family.roomName || "我们的记忆之家",
      protagonistName: family.protagonistName || "",
      members: visibleMembers.map(member => ({
        id: member.memberId,
        name: member.name,
        relation: member.relation,
        avatarText: member.avatarText,
        role: member.role,
        kind: member.kind,
      })),
      contributions: memories.map(memory => ({
        id: memory.frontendContributionId || memory._id,
        authorMemberId: memory.authorMemberId,
        ...currentMemoryAttribution(memory, membersById.get(memory.authorMemberId)),
        text: memory.text,
        title: memory.title,
        summary: memory.summary,
        memoryType: memory.memoryType,
        storyTitle: memory.storyTitle,
        relatedMemberIds: Array.isArray(memory.relatedMemberIds)
          ? memory.relatedMemberIds.filter(id => visibleMemberIds.has(id))
          : [],
        scope: memory.scope,
        sharedWithMemberIds: access.role === "owner"
          ? memory.sharedWithMemberIds
          : (Array.isArray(memory.sharedWithMemberIds) && memory.sharedWithMemberIds.includes(memberId)
            ? [memberId]
            : []),
        visibility: memory.visibility,
        reviewStatus: memory.reviewStatus,
        createdAt: memory.createdAt,
      })),
      personalDrafts: {},
      manuscriptRevisions: [],
    },
  };
}

async function listRooms(accountId) {
  await requireAccount(accountId);
  const response = await db.collection("family_access").where({ accountId }).limit(20).get();
  const accessRecords = response.data.filter(access => access.status === "active");
  const rooms = await Promise.all(accessRecords.map(async (access) => {
    const [family, member] = await Promise.all([
      getDoc("families", access.familyId),
      getDoc("family_members", `${access.familyId}_${access.memberId}`),
    ]);
    if (!family || !member) return undefined;
    return {
      familyId: access.familyId,
      roomName: family.roomName || "记忆之家",
      memberName: member.name || "家人",
      relation: member.relation || "亲友",
      avatarText: member.avatarText || avatarTextFor(member.name),
    };
  }));
  return { rooms: rooms.filter(Boolean) };
}

/**
 * 内容安全检测：调用 contentSecurityCheck 云函数（云函数之间调用会透传原始用户的
 * OPENID，不需要单独传递）。检测没通过、或者调用失败（网络、配额等）一律按未通过
 * 处理——这段提交在进入主人的待确认列表之前就被拒绝，不写进数据库。
 */
async function passesContentSecurity(content, title) {
  try {
    const response = await cloud.callFunction({
      name: "contentSecurityCheck",
      data: { content, title },
    });
    return Boolean(response && response.result && response.result.ok);
  } catch (error) {
    console.warn("内容安全检测调用失败，按未通过处理", error);
    return false;
  }
}

async function submitContribution(event, accountId) {
  const familyId = String(event.familyId || "").trim();
  const access = await requireFamilyAccess(familyId, accountId);
  if (access.role === "owner") throw new Error("请从自己的首页记录故事");
  const member = await getDoc("family_members", `${familyId}_${access.memberId}`);
  if (!member || member.accountId !== accountId) throw new Error("成员身份已失效，请重新接受邀请");
  const input = normalizeContributionInput(event);
  if (!(await passesContentSecurity(input.text, input.title))) {
    throw new Error("这段内容没有通过内容安全检测，请修改后重试");
  }
  // Namespace client-generated ids by the authenticated member. A contributor
  // must never be able to guess another person's id and overwrite their story.
  const sourceRecordId = `src_${familyId}_${member.memberId}_${input.id}`;
  const memoryId = `${familyId}_${member.memberId}_${input.id}`;
  const baseData = {
    familyId,
    sourceRecordId,
    frontendContributionId: input.id,
    authorMemberId: member.memberId,
    authorName: member.name,
    relation: member.relation,
    text: input.text,
    title: input.title,
    summary: input.summary,
    memoryType: input.memoryType,
    storyTitle: input.storyTitle,
    scope: "family",
    visibility: "family",
    reviewStatus: "pending",
    updatedAt: db.serverDate(),
  };
  return db.runTransaction(async (transaction) => {
    const memoryRef = transaction.collection("memories").doc(memoryId);
    let existing;
    try {
      const response = await memoryRef.get();
      existing = response.data;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (existing && existing.authorMemberId !== member.memberId) {
      throw new Error("这段故事的作者身份不一致");
    }
    if (existing && existing.reviewStatus !== "pending") {
      throw new Error("这段故事已经处理，不能从聊天页覆盖");
    }
    const data = {
      ...baseData,
      // Creation time is authoritative server data. Preserve it on an
      // idempotent retry so clients cannot reorder the shared timeline.
      createdAt: existing && existing.createdAt ? existing.createdAt : db.serverDate(),
    };
    await transaction.collection("source_records").doc(sourceRecordId).set({
      data: { ...data, contributorMemberId: member.memberId, contributorName: member.name, rawText: input.text, sourceType: "text" },
    });
    await memoryRef.set({ data });
    return { ok: true, contributionId: input.id, reviewStatus: "pending" };
  });
}

async function main(event = {}) {
  const { accountId } = identity();
  switch (event.action) {
    case "create": return createInvite(event, accountId);
    case "code": return createInviteCode(event, accountId);
    case "get": return getInvite(event, accountId);
    case "accept": return acceptInvite(event, accountId);
    case "loadRoom": return loadRoom(event, accountId);
    case "listRooms": return listRooms(accountId);
    case "submitContribution": return submitContribution(event, accountId);
    default: throw new Error("UNKNOWN_INVITE_ACTION");
  }
}

module.exports = { main };
