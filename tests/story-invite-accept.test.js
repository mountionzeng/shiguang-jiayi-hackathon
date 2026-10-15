const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const core = require('../cloudfunctions/storyBooks/core');

/*
 * 一键邀请：朋友点开链接就成为家人，不再填称呼、不再输核对码。
 * 安全边界：链接只认第一个点开的微信；主人随时撤销；灰度名单只管发邀请的主人，
 * 受邀者只凭一份有效邀请通行，且只能做「看邀请、接受邀请」两件事。
 */
async function setup(extra = {}) {
  const f = fixture();
  f.account('owner'); f.account('friend'); f.account('other');
  // 朋友的家庭不在灰度名单里：这正是新朋友的真实处境。
  const options = {
    accessEnabled: true, rulesReady: true, invitationsEnabled: true, copyReceiveEnabled: true, sharedEditEnabled: true,
    bootstrapAppId: 'wx-original', sharedReadFamilyIds: ['family_owner'], ...extra,
  };
  const service = createStoryService(f.repo, options);
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
  const invite = (input = {}) => call('owner', 'inviteCreate', {
    familyId: 'family_owner', storyId: 'story-a', chapterIds: ['chapter-three'], inviteeName: '小岚',
    permissions: { read: true, forward: false, edit: false, copy: true }, ...input,
  });
  return { ...f, call, invite, options, service };
}

test('朋友点开邀请就成为家人：没有核对码，称呼沿用主人给的名字，只读到被分享的章节', async () => {
  const f = await setup();
  const inv = await f.invite();
  const seen = await f.call('friend', 'inviteGet', { token: inv.token });
  assert.equal(seen.inviteeName, '小岚', '朋友第一眼看到主人起的称呼');
  assert.equal(seen.status, 'unrequested');

  const accepted = await f.call('friend', 'inviteAccept', { token: inv.token });
  assert.equal(accepted.status, 'approved');
  assert.equal(accepted.familyId, 'family_owner');
  assert.equal(accepted.storyId, 'story-a');
  assert.equal(accepted.displayName, '小岚');

  const read = await f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' });
  assert.deepEqual(read.chapters.map(c => c.id), ['chapter-three']);
  assert.equal(JSON.stringify(read).includes('没有分享的秘密'), false);
});

test('重复点开是同一个人，幂等；第二个微信不能再绑定同一份邀请', async () => {
  const f = await setup();
  const inv = await f.invite();
  const first = await f.call('friend', 'inviteAccept', { token: inv.token });
  const again = await f.call('friend', 'inviteAccept', { token: inv.token });
  assert.deepEqual(again, first);
  await assert.rejects(f.call('other', 'inviteAccept', { token: inv.token }), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.call('other', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' }), { code: 'STORY_ACCESS_DISABLED' });
});

test('撤销后立即失效：已接受的朋友读不到，没接受的人也点不开', async () => {
  const f = await setup();
  const accepted = await f.invite(), pending = await f.invite({ chapterIds: ['chapter-one'], inviteeName: '阿远' });
  await f.call('friend', 'inviteAccept', { token: accepted.token });
  await f.call('owner', 'inviteRevoke', { familyId: 'family_owner', storyId: 'story-a', invitationId: accepted.invitationId });
  await assert.rejects(f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' }), { code: 'STORY_FORBIDDEN' });
  await f.call('owner', 'inviteRevoke', { familyId: 'family_owner', storyId: 'story-a', invitationId: pending.invitationId });
  await assert.rejects(f.call('other', 'inviteAccept', { token: pending.token }), { code: 'STORY_FORBIDDEN' });
});

test('过期的邀请不能接受', async () => {
  let clock = 1_000_000;
  const f = await setup({ now: () => clock });
  const inv = await f.invite();
  clock += 25 * 60 * 60 * 1000;
  await assert.rejects(f.call('friend', 'inviteAccept', { token: inv.token }), { code: 'STORY_FORBIDDEN' });
});

test('接纳只通过灰度检查，不授予主人才有的能力', async () => {
  const f = await setup();
  const inv = await f.invite();
  await f.call('friend', 'inviteAccept', { token: inv.token });
  // 朋友不能管理邀请，也不能凭此发邀请（没有「再邀请」授权）。
  await assert.rejects(f.call('friend', 'inviteManage', { familyId: 'family_owner', storyId: 'story-a' }), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.call('friend', 'inviteCreate', { familyId: 'family_owner', storyId: 'story-a', chapterIds: ['chapter-three'], permissions: { read: true } }), { code: 'STORY_FORBIDDEN' });
  // 朋友自己的空间里没有人回信给他。
  assert.deepEqual((await f.call('friend', 'copyReturns')).returns, []);
  // 朋友读不到邀请范围之外的章节。
  await assert.rejects(f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a', chapterIds: ['chapter-one'] }), { code: 'STORY_FORBIDDEN' });
  // 没有被接纳的第三方，连这些动作的大门都进不去。
  await assert.rejects(f.call('other', 'copyReturns'), { code: 'STORY_ACCESS_DISABLED' });
});

test('主人不在名单里时，没人能发邀请，朋友也点不开', async () => {
  const f = await setup({ sharedReadFamilyIds: [] });
  await assert.rejects(f.invite(), { code: 'STORY_ACCESS_DISABLED' });
});

test('没有邀请的陌生人拿不到任何东西；伪造的 token 一律拒绝', async () => {
  const f = await setup();
  await f.invite();
  await assert.rejects(f.call('other', 'inviteAccept', { token: 'f'.repeat(48) }), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.call('other', 'inviteAccept', { token: 'not-a-token' }), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.call('other', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' }), { code: 'STORY_ACCESS_DISABLED' });
});

test('主人自己不能接受自己的邀请', async () => {
  const f = await setup();
  const inv = await f.invite();
  await assert.rejects(f.call('owner', 'inviteAccept', { token: inv.token }), { code: 'STORY_FORBIDDEN' });
});

test('称呼缺失时退回邀请里的「亲友」，不抛错；超长或带控制字符的称呼被拒绝', async () => {
  const f = await setup();
  const unnamed = await f.invite({ inviteeName: undefined });
  const accepted = await f.call('friend', 'inviteAccept', { token: unnamed.token });
  assert.equal(accepted.displayName, '亲友');
  await assert.rejects(f.invite({ inviteeName: '字'.repeat(31) }), { code: 'STORY_FORBIDDEN' });
  await assert.rejects(f.invite({ inviteeName: '小\u202e岚' }), { code: 'STORY_FORBIDDEN' });
});

test('接受后得到的是章节授权，权限由邀请决定，朋友自己不能放大', async () => {
  const f = await setup();
  const inv = await f.invite({ permissions: { read: true, forward: false, edit: false, copy: false } });
  await f.call('friend', 'inviteAccept', { token: inv.token });
  const read = await f.call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' });
  assert.equal(read.capabilities.copy, false);
  assert.equal(read.capabilities.sharedEdit, false);
});
