const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { createHandlers } = require('../cloudfunctions/storyBooks/flow');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const { aliasIdFor } = require('../cloudfunctions/storyBooks/identity');
const { measurePerformance } = require('../cloudfunctions/storyBooks/performance');

const context = { APPID: 'wx-original', OPENID: 'owner' };
const options = { accessEnabled: true, rulesReady: true, bootstrapAppId: context.APPID };
const collections = ['stories', 'biography_drafts', 'story_migration_items', 'memories', 'family_members'];

test('state starts independent room reads together and retains the complete response', async () => {
  const { repo, account, tables } = fixture();
  account('owner', 'family_stable');
  tables.set('memories:memory-a', { familyId: 'family_stable', frontendContributionId: 'memory-a', text: '原文' });
  const expected = await createHandlers(repo).state({ familyId: 'family_stable' });
  const get = repo.get;
  const all = repo.all;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  repo.get = async (table, id) => { calls.push(table); await pending; return get(table, id); };
  repo.all = async (table, id) => { calls.push(table); await pending; return all(table, id); };
  const loading = createHandlers(repo).state({ familyId: 'family_stable' });
  await new Promise(resolve => setImmediate(resolve));
  const started = [...calls];
  release();
  assert.deepEqual(await loading, expected);
  assert.deepEqual(started.sort(), ['families', ...collections].sort(), 'collections must not wait for the family read');
});

test('state fails closed on missing room and on each failed collection', async () => {
  const { repo, account } = fixture();
  await assert.rejects(createHandlers(repo).state({ familyId: 'family_missing' }), /记录空间/);
  account('owner');
  for (const failedTable of collections) {
    const failure = new Error('database unavailable');
    const failing = { ...repo, all: (table, id) => table === failedTable ? Promise.reject(failure) : repo.all(table, id) };
    await assert.rejects(createHandlers(failing).state({ familyId: 'family_owner' }), error => error === failure);
  }
});

test('state retains stable family scope, all identity checks, and post-read revocation', async () => {
  const { repo, account, tables } = fixture();
  account('owner', 'family_stable');
  const service = createStoryService(repo, options);
  await service(context, { action: 'capabilities' });
  const reads = [];
  const wrap = reader => ({ ...reader, get: async (table, id) => { reads.push(table); return reader.get(table, id); } });
  const measured = { ...wrap(repo), transaction: fn => repo.transaction(tx => fn(wrap(tx))) };
  const families = [];
  measured.all = async (table, familyId) => { families.push(familyId); return repo.all(table, familyId); };
  await createStoryService(measured, options)(context, { action: 'state', familyId: 'family_intruder' });
  assert.deepEqual(families, collections.map(() => 'family_stable'));
  assert.equal(reads.filter(table => table === 'story_identity_aliases').length, 4);
  assert.equal(reads.filter(table => table === 'story_principals').length, 3);
  assert.equal(reads.filter(table => table === 'story_principal_spaces').length, 3);
  assert.equal(reads.filter(table => table === 'families').length, 3);
  measured.all = async (table, familyId) => {
    const result = await repo.all(table, familyId);
    tables.get(`story_identity_aliases:${aliasIdFor(context.APPID, context.OPENID)}`).status = 'revoked';
    return result;
  };
  await assert.rejects(createStoryService(measured, options)(context, { action: 'state' }), { code: 'STORY_FORBIDDEN' });
  let dataReads = 0;
  measured.all = async () => { dataReads++; return []; };
  await assert.rejects(createStoryService(measured, options)(context, { action: 'state' }), { code: 'STORY_FORBIDDEN' });
  assert.equal(dataReads, 0, 'invalid identity must fail before any collection reads');
});

test('state also rejects principal, space and ownership changes during parallel reads', async () => {
  for (const target of ['principal', 'space', 'family']) {
    const { repo, account, tables } = fixture();
    account('owner', 'family_stable');
    const service = createStoryService(repo, options);
    await service(context, { action: 'capabilities' });
    const all = repo.all;
    repo.all = async (table, familyId) => {
      const rows = await all(table, familyId);
      const alias = tables.get(`story_identity_aliases:${aliasIdFor(context.APPID, context.OPENID)}`);
      if (target === 'principal') tables.get(`story_principals:${alias.principalId}`).status = 'revoked';
      if (target === 'space') tables.get('story_principal_spaces:family_stable').status = 'revoked';
      if (target === 'family') tables.get('families:family_stable').ownerAccountId = 'account_other';
      return rows;
    };
    await assert.rejects(service(context, { action: 'state' }), { code: 'STORY_FORBIDDEN' });
  }
});

test('state timing reports fixed stages without request, identity or document contents', async t => {
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  const { repo, account, tables } = fixture();
  account('owner', 'family_stable');
  tables.set('memories:private-memory', { familyId: 'family_stable', text: 'PRIVATE_CONTENT' });
  const state = await createStoryService(repo, options)(context, { action: 'state', extra: 'PRIVATE_REQUEST' });
  assert.equal(state.contributions[0].text, 'PRIVATE_CONTENT');
  const operations = logs.map(([tag, detail]) => {
    assert.equal(tag, '[performance]');
    assert.deepEqual(Object.keys(detail).sort(), ['durationMs', 'operation', 'outcome']);
    assert.equal(detail.outcome, 'ok');
    assert.ok(Number.isFinite(detail.durationMs) && detail.durationMs >= 0);
    return detail.operation;
  });
  assert.deepEqual(operations.sort(), [
    'state.identity', 'state.authorize.before', 'state.authorize.after', 'state.load', 'state.total',
    ...['families', ...collections].map(table => `state.query.${table}`),
  ].sort());
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_|family_stable|principal_|account_/);
  assert.deepEqual(Object.keys(state).sort(), [
    'roomStateVersion', 'roomName', 'protagonistName', 'members', 'contributions', 'draft',
    'draftSourceFingerprint', 'personalDrafts', 'personalDraftSourceFingerprints', 'deletedStories',
    'storyMigration', 'stories', 'manuscriptRevisions',
  ].sort(), 'timing remains server-side and does not change the API response');
});

test('timing preserves successes and original errors even when the logger fails', async t => {
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  const failure = new Error('PRIVATE_ERROR');
  await assert.rejects(measurePerformance('state.load', async () => { throw failure; }), error => error === failure);
  assert.equal(logs[0][1].outcome, 'error');
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_ERROR/);
  t.mock.method(console, 'info', () => { throw new Error('logging unavailable'); });
  const value = {};
  assert.equal(await measurePerformance('state.load', async () => value), value);
  await assert.rejects(measurePerformance('state.load', async () => { throw failure; }), error => error === failure);
  const { repo, account } = fixture();
  account('owner');
  assert.equal((await createStoryService(repo, options)(context, { action: 'state' })).roomStateVersion, 1);
});
