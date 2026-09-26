const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryExportSource } = require('../cloudfunctions/storyBooks/memoryExports');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const { resolveStoryIdentity } = require('../cloudfunctions/storyBooks/identity');
const { fixture } = require('./helpers/story-access-fixture');

async function setup() {
  const f = fixture();
  f.account('owner');
  const ctx = await resolveStoryIdentity(f.repo, { APPID: 'wx-original', OPENID: 'owner' }, { bootstrapAppId: 'wx-original' });
  const memory = {
    familyId: 'family_owner', frontendContributionId: 'memory-one', authorMemberId: 'owner',
    scope: 'personal', visibility: 'private', reviewStatus: 'confirmed', title: '雨天',
    text: '旧屋檐下听雨。',
    aiRevisions: [
      { id: 'revision-spoken', kind: 'spoken', text: '屋檐下听雨。', title: '雨天', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'revision-ai', kind: 'ai', text: '旧屋檐下听雨。', title: '雨天', createdAt: '2026-01-02T00:00:00.000Z' },
    ],
  };
  f.tables.set('family_members:family_owner_owner', { familyId: 'family_owner', memberId: 'owner', relation: '自己', role: 'owner', kind: 'recording-profile' });
  f.tables.set('memories:family_owner_memory-one', memory);
  return { ...f, ctx, memory };
}

test('memory source resolves authoritative saved text and selected revision without trusting client text', async () => {
  const f = await setup();
  const result = await memoryExportSource(f.repo, f.ctx, { memoryId: 'memory-one', revisionId: 'revision-spoken' });
  assert.deepEqual(result.source, {
    kind: 'memory', memoryId: 'memory-one', revisionId: 'revision-spoken',
    sourceVersion: result.source.sourceVersion, title: '雨天', text: '屋檐下听雨。', containsAiText: false,
  });
  assert.match(result.source.sourceVersion, /^[a-f0-9]{64}$/);
  await assert.rejects(memoryExportSource(f.repo, f.ctx, { memoryId: 'memory-one', revisionId: 'missing' }), { code: 'VERSION_CONFLICT' });
});

test('current memory with saved revisions keeps a current-memory source version across rechecks', async () => {
  const f = await setup();
  const first = await memoryExportSource(f.repo, f.ctx, { memoryId: 'memory-one' });
  assert.equal(first.source.revisionId, null);
  assert.equal(first.source.title, '雨天');
  assert.equal(first.source.text, '旧屋檐下听雨。');

  const checked = await memoryExportSource(f.repo, f.ctx, {
    memoryId: 'memory-one',
    expectedSourceVersion: first.source.sourceVersion,
  });
  assert.equal(checked.source.revisionId, null);
  assert.equal(checked.source.sourceVersion, first.source.sourceVersion);
});

test('legacy current memory can be resolved from its cloud row and edits invalidate its source version', async () => {
  const f = await setup();
  delete f.memory.aiRevisions;
  f.tables.set('memories:family_owner_memory-one', f.memory);
  const first = await memoryExportSource(f.repo, f.ctx, { memoryId: 'memory-one' });
  assert.equal(first.source.revisionId, null);
  assert.equal(first.source.text, '旧屋檐下听雨。');

  f.memory.segments = [{ text: '旧屋檐下听雨。', internalStatus: 'refreshed' }];
  f.memory.updatedAt = { _internalCloudDateShape: Math.random() };
  f.tables.set('memories:family_owner_memory-one', f.memory);
  const metadataOnly = await memoryExportSource(f.repo, f.ctx, {
    memoryId: 'memory-one', expectedSourceVersion: first.source.sourceVersion,
  });
  assert.equal(metadataOnly.source.sourceVersion, first.source.sourceVersion);

  f.memory.text = '修改后的记忆。';
  f.tables.set('memories:family_owner_memory-one', f.memory);
  await assert.rejects(memoryExportSource(f.repo, f.ctx, {
    memoryId: 'memory-one', expectedSourceVersion: first.source.sourceVersion,
  }), { code: 'VERSION_CONFLICT' });
});

test('selected historical memory revision stays sendable after a newer version is appended', async () => {
  const f = await setup();
  const first = await memoryExportSource(f.repo, f.ctx, { memoryId: 'memory-one', revisionId: 'revision-spoken' });
  f.memory.aiRevisions.push({
    id: 'revision-newer',
    kind: 'manual',
    text: '后来另存的新版本。',
    title: '新版本',
    createdAt: '2026-01-03T00:00:00.000Z',
  });
  f.memory.text = '后来另存的新版本。';
  f.memory.title = '新版本';
  f.tables.set('memories:family_owner_memory-one', f.memory);
  const checked = await memoryExportSource(f.repo, f.ctx, {
    memoryId: 'memory-one',
    revisionId: 'revision-spoken',
    expectedSourceVersion: first.source.sourceVersion,
  });
  assert.equal(checked.source.sourceVersion, first.source.sourceVersion);
  assert.equal(checked.source.text, '屋檐下听雨。');

  f.memory.reviewStatus = 'pending';
  f.tables.set('memories:family_owner_memory-one', f.memory);
  await assert.rejects(memoryExportSource(f.repo, f.ctx, {
    memoryId: 'memory-one',
    revisionId: 'revision-spoken',
    expectedSourceVersion: first.source.sourceVersion,
  }));
});

test('legacy memory document ids normalize back to the stable frontend memory id', async () => {
  const f = await setup();
  delete f.memory.frontendContributionId;
  f.memory.id = 'family_owner_memory-one';
  f.tables.set('memories:family_owner_memory-one', f.memory);
  const result = await memoryExportSource(f.repo, f.ctx, { memoryId: 'memory-one' });
  assert.equal(result.source.memoryId, 'memory-one');
  assert.equal(result.source.text, f.memory.text);
});

test('memory source uses point reads for the selected memory on the normal export path', async () => {
  const f = await setup();
  for (let index = 0; index < 250; index += 1) {
    f.tables.set(`memories:family_owner_unrelated-${index}`, {
      familyId: 'family_owner', frontendContributionId: `unrelated-${index}`, authorMemberId: 'owner',
      scope: 'personal', reviewStatus: 'confirmed', text: `无关记忆 ${index}`,
    });
  }
  const calls = [];
  const repo = {
    ...f.repo,
    async get(table, id) {
      calls.push(['get', table, id]);
      return f.repo.get(table, id);
    },
    async all(table, familyId) {
      calls.push(['all', table, familyId]);
      if (table === 'memories') throw new Error('memory export should not scan all memories');
      return f.repo.all(table, familyId);
    },
  };
  const result = await memoryExportSource(repo, f.ctx, { memoryId: 'memory-one' });
  assert.equal(result.source.text, '旧屋檐下听雨。');
  assert.deepEqual(calls.filter(call => call[0] === 'all' && call[1] === 'memories'), []);
  assert(calls.some(call => call[0] === 'get' && call[1] === 'memories' && call[2] === 'family_owner_memory-one'));
});

test('memory source refuses other accounts, family memories, deleted rows, and unconfirmed content', async () => {
  const f = await setup();
  f.account('reader');
  const reader = await resolveStoryIdentity(f.repo, { APPID: 'wx-original', OPENID: 'reader' }, { bootstrapAppId: 'wx-original' });
  await assert.rejects(memoryExportSource(f.repo, reader, { memoryId: 'memory-one' }), { code: 'STORY_NOT_FOUND' });
  for (const patch of [{ scope: 'family' }, { deletedAt: '2026-09-25T00:00:00Z' }, { reviewStatus: 'pending' }]) {
    f.tables.set('memories:family_owner_memory-one', { ...f.memory, ...patch });
    await assert.rejects(memoryExportSource(f.repo, f.ctx, { memoryId: 'memory-one' }));
  }
});

test('memory source action stays behind owner identity and access rules without trusting client text', async () => {
  const f = await setup();
  const context = { APPID: 'wx-original', OPENID: 'owner' };
  const common = { accessEnabled: true, rulesReady: true, bootstrapAppId: 'wx-original', shareCardEnabled: false, sharedReadFamilyIds: [] };
  const legacyMemory = { ...f.memory, familyId: 'family_owner', authorMemberId: 'owner' };
  f.tables.set('memories:family_owner_memory-one', legacyMemory);
  f.tables.set('family_members:family_owner_owner', { familyId: 'family_owner', memberId: 'owner', relation: '自己', role: 'owner', kind: 'recording-profile' });
  const legacy = createStoryService(f.repo, { ...common, accessEnabled: false });
  assert.equal((await legacy(context, { action: 'capabilities' })).memoryBookExport, true);
  assert.equal((await legacy(context, { action: 'memoryExportSource', memoryId: 'memory-one' })).source.text, legacyMemory.text);
  const service = createStoryService(f.repo, common);
  const capabilities = await service(context, { action: 'capabilities' });
  assert.equal(capabilities.bookExport, false);
  assert.equal(capabilities.memoryBookExport, true);
  const result = await service(context, { action: 'memoryExportSource', memoryId: 'memory-one', text: '伪造正文', familyId: 'family_reader' });
  assert.equal(result.source.text, f.memory.text);
  assert.equal(JSON.stringify(result).includes('伪造正文'), false);
});

test('legacy memory export preview still passes caller openid to content safety', async () => {
  const f = await setup();
  const context = { APPID: 'wx-original', OPENID: 'owner' };
  const service = createStoryService(f.repo, {
    accessEnabled: false,
    approveShareCard: async (_text, openid) => openid === 'owner',
  });
  const source = (await service(context, { action: 'memoryExportSource', memoryId: 'memory-one' })).source;
  const preview = await service(context, {
    action: 'bookExportPreview',
    sourceKind: 'memory',
    memoryId: 'memory-one',
    expectedSourceVersion: source.sourceVersion,
  });
  assert.equal(preview.descriptor.memoryId, 'memory-one');
});
