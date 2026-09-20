const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../cloudfunctions/storyBooks/core');
const { fixture } = require('./helpers/story-access-fixture');
const { resolveStoryIdentity } = require('../cloudfunctions/storyBooks/identity');
const { grantIdFor } = require('../cloudfunctions/storyBooks/access');
const { materializeOwnedDraft } = require('../cloudfunctions/storyBooks/provenance');
const { listShareCardSource, previewShareCard, exportShareCard } = require('../cloudfunctions/storyBooks/exports');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const { createTextModerator } = require('../cloudfunctions/storyBooks/moderation');

const sourceId = suffix => `source-${suffix.repeat(64)}`;

async function setup() {
  const f = fixture();
  f.account('owner'); f.account('reader');
  const identity = openid => resolveStoryIdentity(f.repo, { APPID: 'wx-original', OPENID: openid }, { bootstrapAppId: 'wx-original' });
  const owner = await identity('owner'), reader = await identity('reader');
  const chapters = [
    { id: 'chapter-one', title: '不能泄露', memoryIds: [], content: [{ text: '另一章的秘密' }] },
    { id: 'chapter-two', title: '夏天', memoryIds: [], content: [{ text: '外婆把西瓜放进井水里。' }, { photoId: 'photo-summer' }, { text: '傍晚有风。' }] },
  ];
  const legacy = { title: '旧院子的夏天', chapters, ...core.flatten(chapters), sourceCount: 0, generatedAt: '', generationMode: 'local-demo' };
  const draft = materializeOwnedDraft(legacy, { familyId: 'family_owner', storyId: 'story-summer', revisionId: 'revision-current' });
  f.tables.set('stories:family_owner_story-summer', { id: 'story-summer', familyId: 'family_owner', title: '旧院子的夏天', bookTitle: '旧院子的夏天', version: 4, currentRevisionId: 'revision-current' });
  f.tables.set('biography_drafts:family_owner_revision-current', { familyId: 'family_owner', storyId: 'story-summer', revision: { id: 'revision-current', storyId: 'story-summer', draft } });
  f.tables.set('photos:family_owner__photo-summer', { familyId: 'family_owner', photoId: 'photo-summer', _openid: 'owner', displayFileID: 'cloud://env/user-photos/family_owner/photo-summer/display.jpg', moderation: { ok: true, suggest: 'pass' } });
  return { ...f, owner, reader, draft };
}

test('server lists bounded selectable blocks and never returns an unselected chapter', async () => {
  const f = await setup();
  const result = await listShareCardSource(f.repo, f.owner, { familyId: 'family_owner', storyId: 'story-summer' });
  assert.equal(result.revisionId, 'revision-current');
  assert.equal(result.chapters.length, 2);
  assert.deepEqual(result.chapters[1].blocks.map(item => item.kind), ['text', 'photo', 'text']);
  assert.equal(JSON.stringify(result.chapters[1]).includes('另一章的秘密'), false);
  assert.equal(JSON.stringify(result).includes('cloud://'), false);
});

test('share-card dispatch and capability remain closed unless the dedicated canary flag is enabled', async () => {
  const f = await setup(), context = { APPID: 'wx-original', OPENID: 'owner' };
  const common = { accessEnabled: true, rulesReady: true, bootstrapAppId: 'wx-original', sharedReadFamilyIds: ['family_owner'] };
  const closed = createStoryService(f.repo, common);
  assert.equal((await closed(context, { action: 'capabilities' })).shareCard, false);
  await assert.rejects(closed(context, { action: 'shareCardSource', storyId: 'story-summer' }), { code: 'STORY_ACCESS_DISABLED' });
  const open = createStoryService(f.repo, { ...common, shareCardEnabled: true });
  assert.equal((await open(context, { action: 'capabilities' })).shareCard, true);
  assert.equal((await open(context, { action: 'shareCardSource', storyId: 'story-summer' })).story.id, 'story-summer');
  await assert.rejects(open(context, { action: 'shareCardSource', familyId: 'family_outside', storyId: 'story-summer' }), { code: 'STORY_ACCESS_DISABLED' });
});

test('preview rebuilds selected text from the current revision and rejects forged or empty selections', async () => {
  const f = await setup(), blocks = f.draft.chapters[1].content;
  const input = { familyId: 'family_owner', storyId: 'story-summer', revisionId: 'revision-current', chapterId: 'chapter-two', blockIds: [blocks[0].blockId, blocks[2].blockId], photoIds: [] };
  const result = await previewShareCard(f.repo, f.owner, input, { approve: async () => true });
  assert.deepEqual(result.descriptor.paragraphs, ['外婆把西瓜放进井水里。', '傍晚有风。']);
  assert.equal(JSON.stringify(result).includes('另一章的秘密'), false);
  assert.equal(JSON.stringify(result).includes('url'), false);
  await assert.rejects(previewShareCard(f.repo, f.owner, { ...input, blockIds: ['block-' + 'f'.repeat(64)] }, { approve: async () => true }), { code: 'STORY_SHARE_SELECTION_INVALID' });
  await assert.rejects(previewShareCard(f.repo, f.owner, { ...input, blockIds: [], photoIds: [] }, { approve: async () => true }), { code: 'INVALID_INPUT' });
});

test('share-card moderation receives only the verified WeChat identity, never a client-supplied openid', async () => {
  const f = await setup(), block = f.draft.chapters[1].content[0], seen = [];
  const service = createStoryService(f.repo, {
    accessEnabled: true, rulesReady: true, bootstrapAppId: 'wx-original', sharedReadFamilyIds: ['family_owner'], shareCardEnabled: true,
    approveShareCard: async (_text, openid) => { seen.push(openid); return true; },
  });
  const context = { APPID: 'wx-original', OPENID: 'owner' };
  const input = { action: 'shareCardPreview', familyId: 'family_owner', storyId: 'story-summer', revisionId: 'revision-current', chapterId: 'chapter-two',
    blockIds: [block.blockId], photoIds: [], openid: 'client-forged' };
  await service(context, input);
  assert.deepEqual(seen, ['owner']);
});

test('direct story moderation is bounded, fail-closed and uses the verified active openid', async () => {
  const calls=[];const moderate=createTextModerator({msgSecCheck:async input=>{calls.push(input);return {result:{suggest:'pass'}};}});
  assert.equal(await moderate('院子里的夏天','owner-openid','公开故事卡片'),true);
  assert.deepEqual(calls,[{content:'院子里的夏天',version:2,scene:4,openid:'owner-openid',title:'公开故事卡片'}]);
  assert.equal(await moderate('正文','bad openid','题名'),false);
  assert.equal(await createTextModerator({msgSecCheck:async()=>{throw new Error('unavailable');}})('正文','owner-openid','题名'),false);
});

test('direct story moderation checks every 2,500-code-point chunk and fails closed on a later chunk', async () => {
  const calls=[];
  const moderate=createTextModerator({msgSecCheck:async input=>{calls.push(input);return {result:{suggest:calls.length===1?'pass':'risky'}};}});
  assert.equal(await moderate('安'.repeat(2500)+'拒'.repeat(20),'owner-openid','亲友编辑故事'),false);
  assert.deepEqual(calls.map(call=>call.content.length),[2500,20]);
  assert.equal(calls.every(call=>call.openid==='owner-openid'&&call.title==='亲友编辑故事'),true);
});

test('storyBooks deployment grants only the content moderation OpenAPI permission', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../cloudfunctions/storyBooks/config.json'), 'utf8'));
  assert.deepEqual(config.permissions.openapi, ['security.msgSecCheck']);
});

test('forward permission without publish cannot preview or export a social card', async () => {
  const f = await setup(), block = f.draft.chapters[1].content[0];
  f.tables.set('story_grants:' + grantIdFor('family_owner', 'story-summer', f.reader.principalId), {
    familyId: 'family_owner', storyId: 'story-summer', principalId: f.reader.principalId, ownerPrincipalId: f.owner.principalId,
    status: 'active', version: 1, scope: { type: 'chapters', chapterIds: ['chapter-two'] }, permissions: { read: true, forward: true, publish: false },
  });
  const input = { familyId: 'family_owner', storyId: 'story-summer', revisionId: 'revision-current', chapterId: 'chapter-two', blockIds: [block.blockId], photoIds: [] };
  await assert.rejects(previewShareCard(f.repo, f.reader, input, { approve: async () => true }), { code: 'STORY_FORBIDDEN' });
});

test('mixed and retained-copy sources require publish and export on every source', async () => {
  const f = await setup(), chapter = f.draft.chapters[1], a = sourceId('a'), b = sourceId('b');
  chapter.content[0].sourceIds = [a, b];
  Object.assign(f.draft, core.flatten(f.draft.chapters));
  f.tables.get('stories:family_owner_story-summer').sourcePolicyRequired = true;
  f.tables.set('story_source_policies:' + a, { version: 1, parents: [], permissions: { view: true, publish: true, export: true } });
  f.tables.set('story_source_policies:' + b, { version: 1, parents: [], permissions: { view: true, publish: true, export: false } });
  const input = { familyId: 'family_owner', storyId: 'story-summer', revisionId: 'revision-current', chapterId: 'chapter-two', blockIds: [chapter.content[0].blockId], photoIds: [] };
  await assert.rejects(previewShareCard(f.repo, f.owner, input, { approve: async () => true }), { code: 'STORY_FORBIDDEN' });
  f.tables.get('story_source_policies:' + b).permissions.export = true;
  assert.equal((await previewShareCard(f.repo, f.owner, input, { approve: async () => true })).descriptor.paragraphs.length, 1);
  f.tables.get('story_source_policies:' + b).permissions.view = false;
  const source = await listShareCardSource(f.repo, f.owner, { familyId: 'family_owner', storyId: 'story-summer' });
  assert.equal(source.chapters[1].blocks.some(block => block.blockId === chapter.content[0].blockId), false);
  await assert.rejects(previewShareCard(f.repo, f.owner, input, { approve: async () => true }), { code: 'STORY_FORBIDDEN' });
  assert.equal(JSON.stringify(f.tables.get('story_source_policies:' + a)).includes('story-summer'), false, 'immutable receipts do not need the original story record');
});

test('final export rechecks revision and policy, signs only selected photos, and does not expose file IDs', async () => {
  const f = await setup(), blocks = f.draft.chapters[1].content;
  const input = { familyId: 'family_owner', storyId: 'story-summer', revisionId: 'revision-current', chapterId: 'chapter-two', blockIds: [blocks[0].blockId, blocks[1].blockId], photoIds: ['photo-summer'] };
  const preview = await previewShareCard(f.repo, f.owner, input, { approve: async () => true });
  const result = await exportShareCard(f.repo, f.owner, { ...input, descriptorId: preview.descriptor.id }, { approve: async () => true, sign: async (fileID, ttl) => { assert.equal(ttl, 300); assert.match(fileID, /photo-summer/); return 'https://media.example/signed'; } });
  assert.deepEqual(result.media, [{ photoId: 'photo-summer', url: 'https://media.example/signed', requestedMaxAgeSeconds: 300 }]);
  assert.equal(JSON.stringify(result).includes('cloud://'), false);
  f.tables.get('stories:family_owner_story-summer').currentRevisionId = 'revision-new';
  await assert.rejects(exportShareCard(f.repo, f.owner, { ...input, descriptorId: preview.descriptor.id }, { approve: async () => true, sign: async () => 'https://media.example/signed' }), { code: 'VERSION_CONFLICT' });
});

test('a photo revoked while its temporary URL is being signed is discarded before release', async () => {
  const f = await setup(), blocks = f.draft.chapters[1].content;
  const input = { familyId: 'family_owner', storyId: 'story-summer', revisionId: 'revision-current', chapterId: 'chapter-two', blockIds: [blocks[0].blockId, blocks[1].blockId], photoIds: ['photo-summer'] };
  const preview = await previewShareCard(f.repo, f.owner, input, { approve: async () => true });
  await assert.rejects(exportShareCard(f.repo, f.owner, { ...input, descriptorId: preview.descriptor.id }, { approve: async () => true, sign: async () => {
    f.tables.get('photos:family_owner__photo-summer').moderation.ok = false;
    return 'https://media.example/signed-but-discarded';
  } }), { code: 'STORY_FORBIDDEN' });
});
