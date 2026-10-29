const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const { diffBlocks } = require('../cloudfunctions/storyBooks/changes');
const core = require('../cloudfunctions/storyBooks/core');

/*
 * 主人在章节里看到“谁改了哪几段”。用真实的共编动作产生版本，再读改动列表。
 */
async function setup() {
  const f = fixture();
  f.account('owner'); f.account('friend'); f.account('other');
  const service = createStoryService(f.repo, {
    accessEnabled: true, rulesReady: true, invitationsEnabled: true, sharedEditEnabled: true, copyReceiveEnabled: true,
    bootstrapAppId: 'wx-original', sharedReadFamilyIds: ['family_owner'], approveSharedEdit: async () => true,
  });
  const call = (who, action, input = {}) => service({ APPID: 'wx-original', OPENID: who }, { action, ...input });
  await call('owner', 'create', { storyId: 'story-a', title: '外婆家的夏天', writingMode: 'objective', memoryIds: [], requestId: 'create-story-a' });
  f.tables.get('stories:family_owner_story-a').currentRevisionId = 'revision-a';
  const chapters = [
    { id: 'chapter-one', title: '不公开', memoryIds: [], content: [{ text: '没有分享的秘密' }] },
    { id: 'chapter-three', title: '井水西瓜', memoryIds: [], content: [{ text: '井水里的西瓜很凉。' }, { text: '外婆笑着递给我。' }] },
  ];
  f.tables.set('biography_drafts:family_owner_revision-a', { familyId: 'family_owner', storyId: 'story-a', revision: { id: 'revision-a', storyId: 'story-a', savedAt: '2026-10-15T08:00:00.000Z', draft: {
    title: '外婆家的夏天', chapters, ...core.flatten(chapters), sourceCount: 0, generatedAt: '', generationMode: 'local-demo',
  } } });
  const inv = await call('owner', 'inviteCreate', {
    familyId: 'family_owner', storyId: 'story-a', chapterIds: ['chapter-three'], inviteeName: '小岚',
    permissions: { read: true, forward: false, edit: true, copy: false },
  });
  await call('friend', 'inviteAccept', { token: inv.token });
  const edit = async (title, texts, suffix) => {
    const read = await call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' });
    return call('friend', 'sharedEdit', { familyId: 'family_owner', storyId: 'story-a', chapterId: 'chapter-three', revisionId: read.revisionId,
      expectedVersion: read.story.version, requestId: `edit-flow-${suffix}`, title,
      textBlocks: texts.map((text, index) => ({ index, text })) });
  };
  const changes = () => call('owner', 'chapterChanges', { familyId: 'family_owner', storyId: 'story-a', chapterId: 'chapter-three' });
  return { ...f, call, edit, changes };
}

test('朋友改了哪几段，主人能看到：谁改的、改前改后、什么时候', async () => {
  const f = await setup();
  await f.edit('井水西瓜', ['井水里的西瓜很凉，很甜。', '外婆笑着递给我。'], 'one');
  const { changes } = await f.changes();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].by, '小岚');
  assert.deepEqual(changes[0].blocks, [{ index: 0, before: '井水里的西瓜很凉。', after: '井水里的西瓜很凉，很甜。' }]);
  assert.equal(changes[0].title, undefined, '标题没改就不出现');
  assert.ok(changes[0].savedAt);
});

test('多次修改按时间从新到旧列出，标题改动单独标出', async () => {
  const f = await setup();
  await f.edit('井水西瓜', ['井水里的西瓜很凉，很甜。', '外婆笑着递给我。'], 'one');
  await f.edit('井边的西瓜', ['井水里的西瓜很凉，很甜。', '外婆笑着递给我，说慢点吃。'], 'two');
  const { changes } = await f.changes();
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[0].title, { before: '井水西瓜', after: '井边的西瓜' });
  assert.deepEqual(changes[0].blocks.map(block => block.index), [1]);
  assert.deepEqual(changes[1].blocks.map(block => block.index), [0]);
});

test('主人自己的版本不算家人的改动，没有改动时是空列表', async () => {
  const f = await setup();
  assert.deepEqual((await f.changes()).changes, []);
});

test('只有主人能看；朋友和陌生人都看不到', async () => {
  const f = await setup();
  await f.edit('井水西瓜', ['被改过的第一段', '外婆笑着递给我。'], 'one');
  await assert.rejects(f.call('friend', 'chapterChanges', { familyId: 'family_owner', storyId: 'story-a', chapterId: 'chapter-three' }), { code: 'STORY_ACCESS_DISABLED' }, '朋友不在主人才有的名单里，直接被挡');
  await assert.rejects(f.call('other', 'chapterChanges', { familyId: 'family_owner', storyId: 'story-a', chapterId: 'chapter-three' }), { code: 'STORY_ACCESS_DISABLED' });
});

test('没有被改过的章节不出现在列表里；只返回被问到的那一章', async () => {
  const f = await setup();
  await f.edit('井水西瓜', ['被改过的第一段', '外婆笑着递给我。'], 'one');
  const other = await f.call('owner', 'chapterChanges', { familyId: 'family_owner', storyId: 'story-a', chapterId: 'chapter-one' });
  assert.deepEqual(other.changes, []);
});

test('读不全历史时已找到的照样返回，不整体失败', async () => {
  const f = await setup();
  await f.edit('井水西瓜', ['被改过的第一段', '外婆笑着递给我。'], 'one');
  f.tables.delete('biography_drafts:family_owner_revision-a');
  const { changes } = await f.changes();
  assert.deepEqual(changes, [], '上一版丢失时无法比对，返回空而不是抛错');
});

test('入参不合法一律拒绝', async () => {
  const f = await setup();
  for (const bad of [{ familyId: 'family_friend' }, { storyId: 'x' }, { chapterId: 'x' }]) {
    await assert.rejects(f.call('owner', 'chapterChanges', { familyId: 'family_owner', storyId: 'story-a', chapterId: 'chapter-three', ...bad }), { code: 'STORY_FORBIDDEN' });
  }
});

test('比对只看文字段落，过长的段落被截断，新增和删除的段落都能看出', () => {
  const long = '字'.repeat(900);
  const diff = diffBlocks(['一', '二'], ['一', '二改', long]);
  assert.deepEqual(diff.map(item => item.index), [1, 2]);
  assert.equal(diff[1].before, '');
  assert.equal(Array.from(diff[1].after).length, 400);
  assert.deepEqual(diffBlocks(['一', '二'], ['一']), [{ index: 1, before: '二', after: '' }]);
  assert.deepEqual(diffBlocks(['一'], ['一']), []);
});
