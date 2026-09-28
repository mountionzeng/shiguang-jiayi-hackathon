import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { accountDocumentIdFor, resolveActiveIdentity } = require(process.cwd() + '/cloudfunctions/personalMemory/aiGuard.js');
const memoryCloud = require(process.cwd() + '/cloudfunctions/personalMemory');
const chatCloud = require(process.cwd() + '/cloudfunctions/chatInterview');

const OLD_ENV = { ...process.env };
Object.assign(process.env, {
  WECHAT_APP_ID: 'wxmemorytest',
  AI_SERVER_RELEASE_READY: 'true',
  PERSONAL_MEMORY_ENABLED: 'true',
  CHAT_AI_BASE_URL: 'https://tokenhub.tencentmaas.com/v1',
  CHAT_AI_API_KEY: 'test-not-real',
  CHAT_AI_MODEL: 'test-model',
});

function restoreEnv() {
  for (const key of Object.keys(process.env)) if (!(key in OLD_ENV)) delete process.env[key];
  Object.assign(process.env, OLD_ENV);
}

const ids = {
  alice: 'account_aaaaaaaaaaaaaaaaaaaaaaaa',
  bob: 'account_bbbbbbbbbbbbbbbbbbbbbbbb',
  relation: 'account_cccccccccccccccccccccccc',
  feeling: 'account_dddddddddddddddddddddddd',
  object: 'account_eeeeeeeeeeeeeeeeeeeeeeee',
  sparse: 'account_ffffffffffffffffffffffff',
};

function createHarness(accountNames = ['alice', 'bob']) {
  const records = new Map();
  let current = accountNames[0];
  for (const name of accountNames) {
    const familyId = `family_${name}`;
    const openid = `${name}-openid`;
    records.set(`user_accounts:${accountDocumentIdFor(openid)}`, {
      status: 'active', wxOpenId: openid, accountId: ids[name], primaryFamilyId: familyId, aiConsent: { version: 1 },
    });
    records.set(`families:${familyId}`, { ownerAccountId: ids[name] });
    records.set(`family_members:${familyId}_owner`, { familyId, memberId: 'owner', role: 'owner', relation: '自己' });
  }
  const db = {
    collection(name) { return {
      doc(id) { return {
        async get() {
          const value = records.get(`${name}:${id}`);
          if (!value) throw new Error(`document.get:fail document with _id ${id} does not exist`);
          return { data: structuredClone({ _id: id, ...value }) };
        },
        async set({ data }) { records.set(`${name}:${id}`, structuredClone(data)); },
        async update({ data }) { records.set(`${name}:${id}`, { ...records.get(`${name}:${id}`), ...data }); },
      }; },
      where(filter) { let offset = 0, count = 100; const q = {
        orderBy() { return q; }, skip(n) { offset = n; return q; }, limit(n) { count = n; return q; },
        async get() { return { data: [...records].filter(([k, v]) => k.startsWith(`${name}:`) && Object.entries(filter).every(([key, value]) => v[key] === value)).map(([k, v]) => structuredClone({ _id: k.slice(name.length + 1), ...v })).slice(offset, offset + count) }; },
      }; return q; },
    }; },
    async runTransaction(fn) { const before = structuredClone(records); try { return await fn(db); } catch (error) { records.clear(); for (const [k, v] of before) records.set(k, v); throw error; } },
  };
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: `${current}-openid`, APPID: 'wxmemorytest' }), openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } } };
  return {
    records, db, cloud,
    as(name) { current = name; },
    addMemory(account, id, text, day = 1) {
      const familyId = `family_${account}`;
      records.set(`memories:${familyId}_${id}`, { familyId, frontendContributionId: id, authorMemberId: 'owner', scope: 'personal', text, createdAt: `2026-09-${String(day).padStart(2, '0')}` });
    },
    async identity() { return resolveActiveIdentity(db, cloud.getWXContext()); },
  };
}

const angles = {
  relation: '更愿意从身边的人讲起。',
  feeling: '更愿意从自己的感受讲起。',
  object: '更愿意从物件与场景讲起。',
};

const materials = {
  relation: ['下班时想起妈妈以前等我回家的样子。', '父亲修好旧收音机后，先调到我小时候爱听的节目。', '和姐姐说起同一件旧事，我们记得不一样。', '朋友临走前给我留了一杯热茶。'],
  feeling: ['越是迷茫的时候，越想往远处看。', '真正让我安心的，是不用急着证明自己。', '有些遗憾不用补回来，承认它在那里就够了。', '今天没新事，只想聊聊踏实的感觉。'],
  object: ['搬家时翻出一个掉了漆的铁盒，我舍不得扔。', '下班路上闻到桂花香，一下想起老家的院子。', '第一次学骑车，最记得把手上的橡胶味。', '那天傍晚坐在河边，看见小船慢慢靠岸。'],
  sparse: ['今天阳台上的花冒了一个小芽。', '我想把这句话留下。'],
};

const result = { generatedAt: new Date().toISOString(), u4: {}, u5: {} };
try {
  for (const account of ['relation', 'feeling', 'object']) {
    const harness = createHarness([account]);
    harness.as(account);
    materials[account].forEach((text, index) => harness.addMemory(account, `m${index + 1}`, text, index + 1));
    const extract = async (_source, candidates) => ({ statementType: 'direct_statement', insights: [{ matchLineage: candidates[0]?.ref || null, isContradiction: false, category: 'preference', conversationTendency: true, text: angles[account], projectScoped: false, confidence: 0.8, sensitive: false }] });
    await memoryCloud.main({ action: 'configure', enabled: true, consentVersion: 1 }, { cloud: harness.cloud });
    for (let index = 0; index < 4; index += 1) await memoryCloud.main({ action: 'extract', memoryId: `m${index + 1}` }, { cloud: harness.cloud, extract });
    const listed = await memoryCloud.main({ action: 'list' }, { cloud: harness.cloud });
    assert.equal(listed.insights.length, 1);
    assert.equal(listed.insights[0].text, angles[account]);
    assert.equal(listed.insights[0].evidence.length, 4);
    let promptBefore = '';
    const originalFetch = global.fetch;
    global.fetch = async (_url, options) => { const body = JSON.parse(options.body); promptBefore = body.messages[1].content; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ dimension: 'feeling', text: '这句话里哪个意思最贴近你？' }) } }] }) }; };
    await chatCloud.main({ answer: '越是迷茫的时候，越是要往远处看。' }, { cloud: harness.cloud, nowMs: Date.parse('2026-09-28T00:00:00Z') });
    assert.ok(promptBefore.includes(angles[account]));
    assert.ok(promptBefore.includes('conversationTendency'));
    const correction = '我更想自己选择这一次从哪里讲起。';
    await memoryCloud.main({ action: 'correct', lineageKey: listed.insights[0].lineageKey, text: correction }, { cloud: harness.cloud });
    let promptAfterCorrection = '';
    global.fetch = async (_url, options) => { const body = JSON.parse(options.body); promptAfterCorrection = body.messages[1].content; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ dimension: 'feeling', text: '这句话里哪个意思最贴近你？' }) } }] }) }; };
    await chatCloud.main({ answer: '越是迷茫的时候，越是要往远处看。' }, { cloud: harness.cloud, nowMs: Date.parse('2026-09-28T00:00:03Z') });
    assert.ok(promptAfterCorrection.includes(correction));
    assert.ok(!promptAfterCorrection.includes(angles[account]));
    await memoryCloud.main({ action: 'forget', lineageKey: listed.insights[0].lineageKey }, { cloud: harness.cloud });
    let promptAfterForget = '';
    global.fetch = async (_url, options) => { const body = JSON.parse(options.body); promptAfterForget = body.messages[1].content; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ dimension: 'feeling', text: '这句话里哪个意思最贴近你？' }) } }] }) }; };
    await chatCloud.main({ answer: '越是迷茫的时候，越是要往远处看。' }, { cloud: harness.cloud, nowMs: Date.parse('2026-09-28T00:00:06Z') });
    assert.ok(!promptAfterForget.includes(correction));
    assert.ok(!promptAfterForget.includes(angles[account]));
    global.fetch = originalFetch;
    result.u4[account] = { status: 'pass', expectedTendency: angles[account], evidenceCount: listed.insights[0].evidence.length, promptUsedTendency: true, correctionReplacedTendency: true, forgetRemovedTendency: true };
  }

  const sparse = createHarness(['sparse']);
  sparse.as('sparse');
  materials.sparse.forEach((text, index) => sparse.addMemory('sparse', `m${index + 1}`, text, index + 1));
  const sparseExtract = async (_source, candidates) => ({ statementType: 'direct_statement', insights: [{ matchLineage: candidates[0]?.ref || null, isContradiction: false, category: 'preference', conversationTendency: true, text: angles.object, projectScoped: false, confidence: 0.8, sensitive: false }] });
  await memoryCloud.main({ action: 'configure', enabled: true, consentVersion: 1 }, { cloud: sparse.cloud });
  for (let index = 0; index < 2; index += 1) await memoryCloud.main({ action: 'extract', memoryId: `m${index + 1}` }, { cloud: sparse.cloud, extract: sparseExtract });
  const sparseList = await memoryCloud.main({ action: 'list' }, { cloud: sparse.cloud });
  assert.equal(sparseList.insights.length, 0);
  result.u4.sparse = { status: 'pass', expected: 'no tendency before three independent sources', visibleInsights: 0 };

  const h = createHarness(['alice', 'bob']);
  h.addMemory('alice', 'm1', '我喜欢安静地阅读。', 1);
  h.addMemory('alice', 'm2', '今天我走进了一家书店。', 2);
  h.addMemory('alice', 'm3', '另一天我也想从书和安静讲起。', 3);
  const aliceExtract = async (_source, candidates) => ({ statementType: 'direct_statement', insights: [{ matchLineage: candidates[0]?.ref || null, isContradiction: false, category: 'preference', conversationTendency: true, text: '更愿意从安静阅读讲起。', projectScoped: false, confidence: 0.8, sensitive: false }] });
  h.as('alice');
  await memoryCloud.main({ action: 'configure', enabled: true, consentVersion: 1 }, { cloud: h.cloud });
  for (const memoryId of ['m1', 'm2', 'm3']) await memoryCloud.main({ action: 'extract', memoryId }, { cloud: h.cloud, extract: aliceExtract });
  const aliceList = await memoryCloud.main({ action: 'list' }, { cloud: h.cloud });
  assert.equal(aliceList.insights.length, 1);
  h.as('bob');
  const bobList = await memoryCloud.main({ action: 'list', userId: 'alice' }, { cloud: h.cloud });
  assert.equal(bobList.insights.length, 0);
  await assert.rejects(memoryCloud.main({ action: 'correct', lineageKey: aliceList.insights[0].lineageKey, text: 'B 不能改。' }, { cloud: h.cloud }), /NOT_FOUND/);
  await assert.rejects(memoryCloud.main({ action: 'forget', lineageKey: aliceList.insights[0].lineageKey }, { cloud: h.cloud }), /NOT_FOUND/);
  h.as('alice');
  await memoryCloud.main({ action: 'forget', lineageKey: aliceList.insights[0].lineageKey }, { cloud: h.cloud });
  const aliceAfterForget = await memoryCloud.main({ action: 'list' }, { cloud: h.cloud });
  assert.equal(aliceAfterForget.insights.length, 0);
  const replay = await memoryCloud.main({ action: 'extract', memoryId: 'm1' }, { cloud: h.cloud, extract: aliceExtract });
  assert.equal(replay.status, 'suppressed');
  result.u5 = { status: 'pass', bobCannotSeeAlice: true, bobCannotCorrectAlice: true, bobCannotForgetAlice: true, aliceForgetDoesNotRevive: true, replayStatus: replay.status };

  console.log(JSON.stringify(result, null, 2));
} finally {
  restoreEnv();
}
