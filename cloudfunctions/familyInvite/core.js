const crypto = require("node:crypto");

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function accountIdFor(openid) {
  return `account_${crypto.createHash("sha256").update(openid).digest("hex").slice(0, 24)}`;
}

function normalizeShortText(value, label, maxLength) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) throw new Error(`请填写${label}`);
  if (Array.from(text).length > maxLength) throw new Error(`${label}最多 ${maxLength} 个字`);
  return text;
}

function normalizeInviteInput(event) {
  return {
    inviteeName: normalizeShortText(event && event.inviteeName, "对方的称呼", 8),
    relation: normalizeShortText(event && event.relation, "你们的关系", 12),
  };
}

function avatarTextFor(name) {
  return Array.from(String(name || "").trim())[0] || "忆";
}

function inviteToken(randomBytes = crypto.randomBytes) {
  return randomBytes(18).toString("base64url");
}

function expiresAtFrom(nowMs) {
  return new Date(nowMs + INVITE_TTL_MS);
}

function dateValue(value) {
  if (value instanceof Date) return value;
  if (value && typeof value.toDate === "function") return value.toDate();
  return new Date(value);
}

function assertInvitationUsable(invitation, accountId, nowMs) {
  if (!invitation) throw new Error("邀请不存在或已失效");
  const expiresAt = dateValue(invitation.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= nowMs) {
    throw new Error("这份邀请已经过期，请让好友重新生成");
  }
  if (invitation.status === "accepted" && invitation.acceptedByAccountId !== accountId) {
    throw new Error("这份邀请已经被其他微信接受");
  }
  if (invitation.status !== "pending" && invitation.status !== "accepted") {
    throw new Error("这份邀请已经失效");
  }
  return invitation;
}

function publicInvitation(invitation, viewerAccountId = "") {
  const acceptedByMe = Boolean(
    viewerAccountId && invitation.acceptedByAccountId === viewerAccountId,
  );
  return {
    token: invitation._id || invitation.token,
    inviterName: invitation.inviterName,
    inviteeName: invitation.inviteeName,
    relation: invitation.relation,
    roomName: invitation.roomName,
    familyId: acceptedByMe ? invitation.familyId : "",
    memberId: acceptedByMe ? invitation.memberId || "" : "",
    status: invitation.status,
    acceptedByMe,
    expiresAt: dateValue(invitation.expiresAt).toISOString(),
  };
}

function normalizeContributionInput(event) {
  const contribution = event && event.contribution || {};
  const id = String(contribution.id || "").trim();
  const text = String(contribution.text || "").trim().replace(/\s+/g, " ");
  if (!/^memory-[0-9]+-[0-9a-z]{4,12}$/i.test(id)) throw new Error("INVALID_MEMORY_ID");
  if (!text || text.length > 500) throw new Error("请保留 1—500 字的记忆");
  const storyTitle = String(contribution.storyTitle || "").trim().slice(0, 30);
  return {
    id,
    text,
    title: String(contribution.title || "").trim().slice(0, 40) || undefined,
    summary: String(contribution.summary || "").trim().slice(0, 60) || undefined,
    memoryType: contribution.memoryType === "memoir" ? "memoir" : "note",
    storyTitle: storyTitle || undefined,
  };
}

module.exports = {
  INVITE_TTL_MS,
  accountIdFor,
  assertInvitationUsable,
  avatarTextFor,
  expiresAtFrom,
  inviteToken,
  normalizeContributionInput,
  normalizeInviteInput,
  publicInvitation,
};
