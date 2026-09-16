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

test("建立邀请与生成小程序码分成两次短云调用", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../cloudfunctions/familyInvite/index.js"),
    "utf8",
  );
  const createBody = source.slice(source.indexOf("async function createInvite"), source.indexOf("async function createInviteCode"));

  assert.doesNotMatch(createBody, /wxacode\.getUnlimited/);
  assert.match(source, /async function createInviteCode/);
  assert.match(source, /case "code": return createInviteCode/);
  assert.doesNotMatch(source, /await ensureCollections\(\)/);
});

test("被邀请人看不到其他亲友姓名，主人仍能看到完整名单", () => {
  const members = [
    { memberId: "owner", accountId: "account-owner", name: "岱", role: "owner" },
    { memberId: "friend-a", accountId: "account-a", name: "承", role: "contributor" },
    { memberId: "friend-b", accountId: "account-b", name: "珂", role: "contributor" },
  ];

  assert.deepEqual(
    invite.visibleMembersForAccess(
      members,
      { role: "contributor", memberId: "friend-a" },
      "account-owner",
    ).map(member => member.name),
    ["岱", "承"],
  );
  assert.equal(invite.visibleMembersForAccess(members, { role: "owner", memberId: "owner" }).length, 3);
});

test("被邀请人只看到自己写的或明确分享给自己的个人记忆", () => {
  const memories = [
    { id: "private", authorMemberId: "owner", scope: "personal", sharedWithMemberIds: [] },
    { id: "shared-a", authorMemberId: "owner", scope: "personal", sharedWithMemberIds: ["friend-a"] },
    { id: "shared-b", authorMemberId: "owner", scope: "personal", sharedWithMemberIds: ["friend-b"] },
    { id: "family-confirmed", authorMemberId: "owner", scope: "family", visibility: "family", reviewStatus: "confirmed" },
    { id: "own", authorMemberId: "friend-a", scope: "family", visibility: "family", reviewStatus: "pending" },
  ];

  assert.deepEqual(
    invite.visibleMemoriesForAccess(memories, { role: "contributor", memberId: "friend-a" })
      .map(memory => memory.id),
    ["shared-a", "own"],
  );
  assert.equal(invite.visibleMemoriesForAccess(memories, { role: "owner", memberId: "owner" }).length, 5);
});

test("提交进主人待确认列表前先过内容安全检测，不通过就不写库", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../cloudfunctions/familyInvite/index.js"),
    "utf8",
  );
  const submitBody = source.slice(
    source.indexOf("async function submitContribution"),
    source.indexOf("async function main"),
  );

  assert.match(submitBody, /passesContentSecurity\(input\.text, input\.title\)/);
  // 检测必须发生在写入 memories / source_records 之前。
  assert.ok(
    submitBody.indexOf("passesContentSecurity(input.text") <
      submitBody.indexOf('.collection("source_records")'),
  );
  assert.match(source, /name:\s*"contentSecurityCheck"/);
  assert.match(source, /return false;\s*\n\s*}\s*\n\s*}\s*\n\s*async function submitContribution/);
});

test("共享页面隐藏被邀请人的名单管理入口", () => {
  const markup = fs.readFileSync(
    path.join(__dirname, "../miniprogram/pages/room/room.wxml"),
    "utf8",
  );
  assert.match(markup, /room-manage[^>]+wx:if="\{\{canInvite\}\}"/);
});

test("邀请页为系统顶部留出空间并允许小屏滚动", () => {
  const styles = fs.readFileSync(
    path.join(__dirname, "../miniprogram/pages/invite/invite.wxss"),
    "utf8",
  );
  assert.match(styles, /env\(safe-area-inset-top\)/);
  assert.match(styles, /overflow-y:\s*auto/);
  const pageRule = styles.slice(0, styles.indexOf("}\n") + 1);
  assert.doesNotMatch(pageRule, /overflow:\s*hidden/);
});
