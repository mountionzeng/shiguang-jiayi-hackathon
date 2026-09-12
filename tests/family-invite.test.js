const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const invite = require("../cloudfunctions/familyInvite/core.js");

test("亲友邀请令牌适合放进小程序码且默认七天有效", () => {
  const token = invite.inviteToken(size => Buffer.alloc(size, 255));
  assert.equal(token, "________________________");
  assert.match(token, /^[0-9A-Za-z_-]{24}$/);
  const now = Date.parse("2026-09-12T00:00:00.000Z");
  assert.equal(invite.expiresAtFrom(now).getTime(), now + invite.INVITE_TTL_MS);
});

test("邀请称呼和关系必须简短明确", () => {
  assert.deepEqual(invite.normalizeInviteInput({ inviteeName: " 妈 ", relation: " 母 女 " }), {
    inviteeName: "妈",
    relation: "母 女",
  });
  assert.throws(() => invite.normalizeInviteInput({ inviteeName: "", relation: "朋友" }), /填写对方的称呼/);
  assert.throws(() => invite.normalizeInviteInput({ inviteeName: "一二三四五六七八九", relation: "朋友" }), /最多 8 个字/);
});

test("未接受邀请不泄露记忆之家和成员标识", () => {
  const record = {
    _id: "safe-token",
    inviterName: "岱",
    inviteeName: "妈",
    relation: "母女",
    roomName: "我们的记忆之家",
    familyId: "family-secret",
    memberId: "member-secret",
    status: "pending",
    expiresAt: new Date(Date.now() + 1000),
  };
  const publicView = invite.publicInvitation(record, "another-account");
  assert.equal(publicView.familyId, "");
  assert.equal(publicView.memberId, "");
  assert.equal(publicView.acceptedByMe, false);
});

test("邀请只允许原接受账号幂等重试，其他账号不能接手", () => {
  const accepted = {
    status: "accepted",
    acceptedByAccountId: "account-a",
    expiresAt: new Date(Date.now() + 1000),
  };
  assert.equal(invite.assertInvitationUsable(accepted, "account-a", Date.now()), accepted);
  assert.throws(
    () => invite.assertInvitationUsable(accepted, "account-b", Date.now()),
    /已经被其他微信接受/,
  );
  assert.throws(
    () => invite.assertInvitationUsable({ status: "pending", expiresAt: new Date(0) }, "account-a", Date.now()),
    /已经过期/,
  );
});

test("共享投稿只接受当前客户端生成的短文本记忆", () => {
  const normalized = invite.normalizeContributionInput({
    contribution: {
      id: "memory-1720000000000-abc123",
      text: "  那 天   我们一起回家。 ",
      storyTitle: "回家的路",
    },
  });
  assert.equal(normalized.text, "那 天 我们一起回家。");
  assert.equal(normalized.storyTitle, "回家的路");
  assert.equal(normalized.createdAt, undefined);
  assert.throws(
    () => invite.normalizeContributionInput({ contribution: { id: "bad", text: "故事" } }),
    /INVALID_MEMORY_ID/,
  );
});

test("清空空间撤销旧访问与邀请，读取空间复核成员身份", () => {
  const resetSource = fs.readFileSync(
    path.join(__dirname, "../cloudfunctions/resetCurrentUserRoom/index.js"),
    "utf8",
  );
  const inviteSource = fs.readFileSync(
    path.join(__dirname, "../cloudfunctions/familyInvite/index.js"),
    "utf8",
  );

  assert.match(resetSource, /familyInvitations:\s*"family_invitations"/);
  assert.match(resetSource, /familyAccess:\s*"family_access"/);
  assert.match(inviteSource, /member\.accountId\s*!==\s*accountId/);
  assert.match(inviteSource, /member\.memberId\s*!==\s*access\.memberId/);
});

test("共同投稿时间由云函数生成且幂等重试保留原时间", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../cloudfunctions/familyInvite/index.js"),
    "utf8",
  );

  assert.match(source, /createdAt:\s*existing && existing\.createdAt \? existing\.createdAt : db\.serverDate\(\)/);
  assert.doesNotMatch(source, /createdAt:\s*input\.createdAt/);
});
