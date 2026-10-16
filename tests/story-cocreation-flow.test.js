const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const core = require('../cloudfunctions/storyBooks/core');

/*
 * 共创整条链路，只通过真实 dispatcher（和线上同一入口）走一遍：
 * 主人邀请 → 朋友申请 → 主人核对放行 → 朋友阅读 → 收成自己的故事 → 写补充
 * → 发回主人 → 主人看到回应 → 收录/拒绝。
 * 每一步都不直接调用内部模块，缺口会在这里暴露。
 */
async function setup() {
  const f = fixture();
  f.account('owner'); f.account('friend');
  const service = createStoryService(f.repo, {
    accessEnabled: true, rulesReady: true, invitationsEnabled: true, copyReceiveEnabled: true,
    bootstrapAppId: 'wx-original', sharedReadFamilyIds: ['family_owner', 'family_friend'],
  });
  const call = (who, action, input = {}) => service({ APPID: 'wx-original', OPENID: who }, { action, ...input });
  await call('owner', 'create', { storyId: 'story-a', title: '外婆家的夏天', writingMode: 'objective', memoryIds: [], requestId: 'create-story-a' });
  f.tables.get('stories:family_owner_story-a').currentRevisionId = 'revision-a';
  const chapters = [
    { id: 'chapter-one', title: '不公开', memoryIds: [], content: [{ text: '没有分享的秘密' }] },
    { id: 'chapter-three', title: '井水西瓜', memoryIds: [], content: [{ text: '井水里的西瓜很凉。' }] },
  ];
  f.tables.set('biography_drafts:family_owner_revision-a', { familyId: 'family_owner', storyId: 'story-a', revision: { id: 'revision-a', storyId: 'story-a', draft: {
    title: '外婆家的夏天', chapters, ...core.flatten(chapters), sourceCount: 0, generatedAt: '', generationMode: 'local-demo',
  } } });
  return { ...f, call };
}

async function invite(f) {
  const created = await f.call('owner', 'inviteCreate', {
    familyId: 'family_owner', storyId: 'story-a', chapterIds: ['chapter-three'],
    permissions: { read: true, forward: false, copy: true }, inviteeName: '小岚',
  });
  await f.call('friend', 'inviteAccept', { token: created.token });
  return created;
}

async function receiveCopy(f) {
  const read = await f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' });
  const received = await f.call('friend', 'copyReceive', {
    sourceFamilyId: 'family_owner', sourceStoryId: 'story-a', sourceRevisionId: read.revisionId,
    chapterIds: ['chapter-three'], requestId: 'receive-flow-001',
    target: { mode: 'new', storyId: 'story-friend-copy', title: '我的夏天' },
  });
  return { read, received };
}

async function appendAndReturn(f, text, suffix) {
  const story = f.tables.get('stories:family_friend_story-friend-copy');
  const revision = f.tables.get(`biography_drafts:family_friend_${story.currentRevisionId}`).revision;
  const chapterId = revision.draft.chapters[0].id;
  await f.call('friend', 'copyAppendOwn', {
    storyId: story.id, revisionId: story.currentRevisionId, expectedVersion: story.version,
    chapterId, text, requestId: `append-flow-${suffix}`,
  });
  const after = f.tables.get('stories:family_friend_story-friend-copy');
  return f.call('friend', 'copyReturnOwn', {
    storyId: after.id, revisionId: after.currentRevisionId, expectedVersion: after.version,
    chapterId, requestId: `return-flow-${suffix}`,
  });
}

test('朋友只读到被分享的章节，收成自己的故事后原稿不变', async () => {
  const f = await setup();
  await invite(f);
  const { read, received } = await receiveCopy(f);
  assert.deepEqual(read.chapters.map(c => c.id), ['chapter-three']);
  assert.equal(JSON.stringify(read).includes('没有分享的秘密'), false);
  assert.equal(received.storyId, 'story-friend-copy');
  const friendStory = f.tables.get('stories:family_friend_story-friend-copy');
  assert.equal(friendStory.sourcePolicyRequired, true);
  assert.equal(f.tables.get('stories:family_owner_story-a').version, 1);
});

test('朋友的回应在主人书里以待处理出现，收录前原稿不变，收录后新增一版', async () => {
  const f = await setup();
  await invite(f);
  await receiveCopy(f);
  const sent = await appendAndReturn(f, '我记得你当时还带着一把蓝伞', 'accept');
  assert.equal(sent.status, 'pending');

  const before = structuredClone(f.tables.get('stories:family_owner_story-a'));
  const list = await f.call('owner', 'copyReturns');
  assert.equal(list.returns.length, 1);
  assert.equal(list.returns[0].sourceStoryId, 'story-a');
  assert.equal(list.returns[0].sourceChapterId, 'chapter-three');
  assert.equal(list.returns[0].senderName, '小岚', '回信署名是朋友申请时填的称呼');
  assert.deepEqual(list.returns[0].blocks.map(b => b.text), ['我记得你当时还带着一把蓝伞']);
  assert.equal(JSON.stringify(list).includes('井水里的西瓜很凉'), false, '回应里不重复带出原文');
  assert.deepEqual(f.tables.get('stories:family_owner_story-a'), before, '待处理阶段不改原稿');

  const decided = await f.call('owner', 'copyReturnDecision', { returnId: sent.returnId, decision: 'accept', requestId: 'accept-flow-001' });
  assert.equal(decided.status, 'accepted');
  const story = f.tables.get('stories:family_owner_story-a');
  assert.equal(story.version, before.version + 1);
  const accepted = f.tables.get(`biography_drafts:family_owner_${story.currentRevisionId}`).revision.draft;
  const texts = accepted.chapters.find(c => c.id === 'chapter-three').content.map(b => b.text);
  assert.deepEqual(texts, ['井水里的西瓜很凉。', '我记得你当时还带着一把蓝伞']);
  assert.equal(f.tables.get('biography_drafts:family_owner_revision-a').revision.draft.chapters[1].content.length, 1, '旧版本保留');
});

test('拒绝回应不改主人的书，同一段补充不会被重复发回', async () => {
  const f = await setup();
  await invite(f);
  await receiveCopy(f);
  const sent = await appendAndReturn(f, '一段我自己的看法', 'reject');
  const before = structuredClone(f.tables.get('stories:family_owner_story-a'));
  const decided = await f.call('owner', 'copyReturnDecision', { returnId: sent.returnId, decision: 'reject', requestId: 'reject-flow-001' });
  assert.equal(decided.status, 'rejected');
  assert.deepEqual(f.tables.get('stories:family_owner_story-a'), before);
  const story = f.tables.get('stories:family_friend_story-friend-copy');
  const chapterId = f.tables.get(`biography_drafts:family_friend_${story.currentRevisionId}`).revision.draft.chapters[0].id;
  await assert.rejects(f.call('friend', 'copyReturnOwn', {
    storyId: story.id, revisionId: story.currentRevisionId, expectedVersion: story.version,
    chapterId, requestId: 'return-flow-again',
  }), { code: 'STORY_RETURN_EMPTY' });
});

test('撤销邀请后朋友读不到原稿，但已存的副本仍可用', async () => {
  const f = await setup();
  const created = await invite(f);
  await receiveCopy(f);
  await f.call('owner', 'inviteRevoke', { familyId: 'family_owner', storyId: 'story-a', invitationId: created.invitationId });
  await assert.rejects(f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' }), { code: 'STORY_FORBIDDEN' });
  const copy = f.tables.get('stories:family_friend_story-friend-copy');
  assert.ok(copy && !copy.deletedAt);
});

test('第三方看不到主人的回应列表', async () => {
  const f = await setup();
  f.account('stranger');
  const strangerService = createStoryService(f.repo, {
    accessEnabled: true, rulesReady: true, invitationsEnabled: true, copyReceiveEnabled: true,
    bootstrapAppId: 'wx-original', sharedReadFamilyIds: ['family_owner', 'family_friend', 'family_stranger'],
  });
  await invite(f);
  await receiveCopy(f);
  await appendAndReturn(f, '只给主人看的补充', 'private');
  const list = await strangerService({ APPID: 'wx-original', OPENID: 'stranger' }, { action: 'copyReturns' });
  assert.deepEqual(list.returns, []);
});

test('取不到朋友称呼时回信署名退回「一位亲友」，不让发回失败', async () => {
  const f = await setup();
  await invite(f);
  await receiveCopy(f);
  const copy = f.tables.get('stories:family_friend_story-friend-copy');
  copy.receivedSources = copy.receivedSources.map(({ senderName, ...rest }) => rest);
  const sent = await appendAndReturn(f, '没有称呼也能发回', 'fallback');
  assert.equal(sent.status, 'pending');
  const list = await f.call('owner', 'copyReturns');
  assert.equal(list.returns[0].senderName, '一位亲友');
});

test('回信带着这位家人在主人名单里的成员编号，记忆之家据此把信归到 ta 名下', async () => {
  const f = await setup();
  await invite(f);
  await receiveCopy(f);
  await appendAndReturn(f, '我记得你当时还带着一把蓝伞', 'member');
  const list = await f.call('owner', 'copyReturns');
  const memberId = list.returns[0].senderMemberId;
  assert.match(memberId, /^wx_[a-f0-9]{24}$/);
  const member = f.tables.get(`family_members:family_owner_${memberId}`);
  assert.equal(member.name, '小岚');
});
