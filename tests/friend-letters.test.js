const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const { flatten } = require('../cloudfunctions/storyBooks/core');

const source = { familyId: 'family_owner', storyId: 'story-summer' };
const publicId = 'chapter-lake';
const privateId = 'chapter-private';
const blockId = digit => 'block-' + digit.repeat(64);
const initialDraft = () => {
  const chapters = [
    { id: privateId, title: '家里的秘密', memoryIds: [], content: [{ blockId: blockId('a'), text: '仅家里可见' }] },
    { id: publicId, title: '湖边', memoryIds: [], content: [{ blockId: blockId('b'), text: '那年夏天，我们去看湖。' }] },
  ];
  return { title: '外婆家的夏天', chapters, ...flatten(chapters), sourceCount: 0, generatedAt: '', generationMode: 'local-demo' };
};

async function setup() {
  const { repo, tables, account } = fixture();
  for (const [id, name] of [['owner', '小禾'], ['friend', '小岚'], ['other', '路人']]) {
    tables.get('user_accounts:' + account(id).accountId).displayName = name;
  }
  const dispatch = createStoryService(repo, {
    accessEnabled: true, rulesReady: true, invitationsEnabled: true, sharedEditEnabled: true, copyReceiveEnabled: true,
    sharedReadFamilyIds: [source.familyId], bootstrapAppId: 'wx-original',
    approveChapterText: async text => !text.includes('审核拒绝'), approveSharedEdit: async () => true,
  });
  const call = (who, action, data = {}) => dispatch({ APPID: 'wx-original', OPENID: who }, { ...data, action });
  const draft = initialDraft();
  await call('owner', 'create', { storyId: source.storyId, title: draft.title, writingMode: 'objective', memoryIds: [], requestId: 'create-summer' });
  await call('owner', 'save', { storyId: source.storyId, expectedVersion: 1, expectedRevisionId: '', requestId: 'save-summer-original',
    revision: { id: 'revision-original', storyId: source.storyId, kind: 'draft', draft } });
  const invite = async (chapters = [publicId], accepted = true) => {
    const invitation = await call('owner', 'inviteCreate', { ...source, chapterIds: chapters, inviteeName: '小岚',
      permissions: { read: true, edit: true, copy: true } });
    if (accepted) await call('friend', 'inviteAccept', { token: invitation.token });
    return invitation;
  };
  function article(chapterId, requestId, text) {
    const story = tables.get('stories:' + source.familyId + '_' + source.storyId);
    const chapter = tables.get('biography_drafts:' + source.familyId + '_' + story.currentRevisionId)
      .revision.draft.chapters.find(item => item.id === chapterId);
    const content = [{ blockId: chapter.content[0].blockId, text }];
    const layout = chapter.layout || {
      canvas: { width: 900, height: 1200 },
      settings: { fontId: 'default', style: 'plain', texture: 'none', textureSeed: 1, includeCover: false, bodyTextureAssetId: null },
      pages: [{ label: '1', modules: [{ id: 'm1', kind: 'text', bind: { blockId: content[0].blockId },
        rect: { x: 40, y: 40, width: 800, height: 120 }, fontSize: 42, contentWidth: 800, contentHeight: 120, alignment: 'start' }] }],
    };
    return { requestId, storyId: source.storyId, revisionId: story.currentRevisionId, expectedVersion: story.version,
      chapter: { id: chapter.id, title: chapter.title, content, layout, packageAssets: {} } };
  }
  return { call, invite, article, tables };
}

test('already shared original: saves coalesce across families, the letter opens the latest permitted chapter, and the copy stays independent', async () => {
  const { call, invite, article } = await setup();
  const invitation = await invite();
  const read = () => call('friend', 'sharedRead', { ...source, chapterIds: [publicId] });
  const original = await read();
  const copy = await call('friend', 'copyReceive', {
    sourceFamilyId: source.familyId, sourceStoryId: source.storyId, sourceRevisionId: original.revisionId, chapterIds: [publicId],
    requestId: 'copy-before-update', target: { mode: 'new', storyId: 'story-personal-copy', title: '小岚留下的夏天' },
  });
  assert.deepEqual(await call('friend', 'friendLetters'), { letters: [] });

  await call('owner', 'articleSave', article(privateId, 'request-private-save', '只修改了秘密章节'));
  assert.deepEqual(await call('friend', 'friendLetters'), { letters: [] });
  const first = article(publicId, 'request-first-save', '我们沿着湖边走了一圈。');
  const saved = await call('owner', 'articleSave', first);
  const second = article(publicId, 'request-second-save', '我们沿着湖边走了一圈，还看见一对野鸭。');
  await call('owner', 'articleSave', second);
  assert.deepEqual(await call('owner', 'articleSave', first), saved, 'retrying an older receipt must not deliver it again');
  await call('owner', 'articleSave', article(publicId, 'request-unchanged', second.chapter.content[0].text));
  await call('owner', 'articleSave', article(publicId, 'request-rejected', '审核拒绝'));
  assert.deepEqual(await call('friend', 'friendLetters'), { letters: [] });
  await assert.rejects(read(), { code: 'CONTENT_REJECTED' });
  await call('owner', 'articleSave', article(publicId, 'request-allowed', second.chapter.content[0].text));

  const { letters } = await call('friend', 'friendLetters', { principalId: 'owner', familyId: source.familyId });
  assert.equal(letters.length, 1);
  assert.deepEqual(letters[0], { id: 'family_owner:story-summer', ...source, chapterId: publicId, editorName: '小禾',
    storyTitle: '外婆家的夏天', chapterTitle: '湖边', summary: '修改 1 段文字' });
  assert.deepEqual(await call('owner', 'friendLetters'), { letters: [] });
  assert.deepEqual(await call('other', 'friendLetters', { ...source }), { letters: [] });
  assert.deepEqual((await read()).chapters.map(chapter => [chapter.id, chapter.content[0].text]), [[publicId, second.chapter.content[0].text]]);
  await assert.rejects(call('friend', 'sharedRead', { ...source, chapterIds: [privateId] }), { code: 'STORY_FORBIDDEN' });

  await call('owner', 'inviteRevoke', { ...source, invitationId: invitation.invitationId });
  assert.deepEqual(await call('friend', 'friendLetters'), { letters: [] });
  await assert.rejects(read(), { code: 'STORY_FORBIDDEN' });
  const { manuscriptRevisions } = await call('friend', 'state', { view: 'home' });
  assert.equal(manuscriptRevisions.find(revision => revision.storyId === copy.storyId).draft.chapters[0].content[0].text,
    original.chapters[0].content[0].text);
});

test('owner manuscript saves and collaborator saves use trusted diffs and current chapter scope', async () => {
  const { call, invite } = await setup();
  const invitation = await invite([publicId, privateId]);
  const draft = initialDraft();
  draft.chapters[0].content[0].text = '这是更新后的秘密';
  draft.chapters[1].title = '雨后的湖边';
  Object.assign(draft, flatten(draft.chapters));
  await call('owner', 'save', { storyId: source.storyId, expectedVersion: 2, expectedRevisionId: 'revision-original', requestId: 'save-summer-second',
    revision: { id: 'revision-second', kind: 'draft', storyId: source.storyId, draft, editorName: '伪造称呼', changeSummary: '伪造说明' } });
  const replaceScope = { ...source, invitationId: invitation.invitationId, chapterIds: [publicId], permissions: { read: true, edit: true, copy: true } };
  await call('owner', 'inviteSetAccess', replaceScope);
  const { letters } = await call('friend', 'friendLetters');
  assert.equal(letters.length, 1);
  assert.equal(letters[0].chapterId, publicId);
  assert.equal(letters[0].chapterTitle, '雨后的湖边');
  assert.equal(letters[0].editorName, '小禾');
  assert.match(letters[0].summary, /标题/);
  assert.doesNotMatch(JSON.stringify(letters), /秘密|伪造/);

  const shared = await call('friend', 'sharedRead', source);
  const edit = { ...source, chapterId: publicId, revisionId: shared.revisionId, expectedVersion: shared.story.version,
    requestId: 'collab-summer-second', title: shared.chapters[0].title, textBlocks: [{ index: 0, text: '小岚记得那天下了雨。' }] };
  await call('friend', 'sharedEdit', edit);
  const received = (await call('owner', 'friendLetters')).letters;
  assert.equal(received.length, 1);
  assert.equal(received[0].editorName, '小岚');
  assert.equal(received[0].summary, '修改 1 段文字');
  assert.deepEqual((await call('friend', 'friendLetters')).letters, letters, 'the editor keeps the earlier incoming letter without receiving their own edit');
});

test('pending and newly reissued invitations do not inherit notifications from prior access', async () => {
  const { call, invite, article } = await setup();
  const invitation = await invite([publicId], false);
  await call('owner', 'articleSave', article(publicId, 'request-before-accept', '加入前更新'));
  await call('friend', 'inviteAccept', { token: invitation.token });
  assert.deepEqual(await call('friend', 'friendLetters'), { letters: [] });
  await call('owner', 'articleSave', article(publicId, 'request-after-accept', '加入后更新'));
  assert.equal((await call('friend', 'friendLetters')).letters.length, 1);
  await call('owner', 'inviteRevoke', { ...source, invitationId: invitation.invitationId });
  const replacement = await call('owner', 'inviteCreate', { ...source, chapterIds: [publicId], inviteeName: '小岚（再次加入）',
    permissions: { read: true } });
  await call('friend', 'inviteAccept', { token: replacement.token });
  assert.deepEqual(await call('friend', 'friendLetters'), { letters: [] });
});
