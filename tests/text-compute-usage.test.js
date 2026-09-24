const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { createTextMeter, readRecentTextUsage, tokenUsage, estimate, peakAt } = require('../cloudfunctions/chatInterview/textComputeUsage');
const BASE = 'https://tokenhub.tencentmaas.com/v1', MODEL = 'deepseek/deepseek-flash';
const PEAK = Date.parse('2026-09-24T02:00:00Z');
const identity = { accountId: 'account_' + 'a'.repeat(24) };
const usage = { prompt_tokens: 1138, completion_tokens: 268, total_tokens: 1406,
  prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 205 } };
function fixture() {
  const records = new Map(); let writes = 0;
  const db = { failWrite: 0, collection(name) {
    return { doc(id) { return {
      async set({ data }) { if (++writes === db.failWrite) throw new Error('offline'); records.set(name + ':' + id, structuredClone(data)); },
      async get() { const data = records.get(name + ':' + id); if (!data) throw new Error('not found'); return { data: structuredClone(data) }; },
    }; }, where(filter) { return { orderBy(key, direction) {
      assert.equal(key, 'startedAt'); assert.equal(direction, 'desc');
      return { limit(n) { assert.equal(n, 10); return { async get() {
        return { data: [...records.entries()].filter(([k, v]) => k.startsWith(name + ':') && v.accountId === filter.accountId)
          .map(([, v]) => structuredClone(v)).sort((a, b) => b.startedAt - a.startedAt).slice(0, n) };
      } }; } };
    } }; } };
  } };
  return { db, records };
}
function response(content = 'private result', u = usage, status = 200) {
  return { ok: status === 200, status, headers: { get: () => 'provider-id' },
    json: async () => ({ id: 'completion-id', usage: u, choices: [{ message: { content } }] }) };
}
function meter(db, fetcher, extra = {}) {
  return createTextMeter({ db, identity, kind: 'chatInterview', model: MODEL, baseUrl: BASE,
    fetcher, now: () => PEAK, env: { TEXT_COMPUTE_USAGE_ENABLED: 'true' }, ...extra });
}

test('known real samples convert to compute, cache input is not counted twice, reasoning is not added', () => {
  assert.equal(estimate(tokenUsage({ usage }), MODEL, BASE, PEAK, PEAK), 8840);
  const cached = tokenUsage({ usage: { ...usage, prompt_tokens_details: { cached_tokens: 100 } } });
  assert.equal(estimate(cached, MODEL, BASE, PEAK, PEAK), 8448);
  const quiet = Date.parse('2026-09-26T02:00:00Z');
  assert.equal(estimate(tokenUsage({ usage }), MODEL, BASE, quiet, quiet), 4420);
  assert.equal(estimate({ input: 1, output: 0, cached: 1 }, MODEL, BASE, PEAK, PEAK), 1);
});
test('weekday Beijing boundaries, unknown models, invalid and missing usage never become free', () => {
  for (const [time, expected] of [['00:59:59', false], ['01:00:00', true], ['04:00:00', false], ['06:00:00', true], ['10:00:00', false]])
    assert.equal(peakAt(Date.parse('2026-09-24T' + time + 'Z')), expected);
  assert.equal(estimate(tokenUsage({ usage }), 'unknown', BASE, PEAK, PEAK), null);
  assert.equal(estimate(tokenUsage({ usage }), MODEL, BASE, PEAK, Date.parse('2026-09-24T04:00:00Z')), null);
  for (const u of [undefined, {}, { ...usage, prompt_tokens: -1 }, { ...usage, total_tokens: 1 },
    { ...usage, prompt_tokens_details: {} }, { ...usage, prompt_tokens_details: { cached_tokens: 2000 } }])
    assert.equal(tokenUsage({ usage: u }), null);
});
test('persists before provider submission; each retry has its own ID and both usages contribute', async () => {
  const { db, records } = fixture(); const ids = [];
  const m = meter(db, async (_url, options) => {
    const row = [...records.values()][0]; assert.equal(row.attempts.at(-1).estimatedMicros, null);
    ids.push(options.headers['X-Request-ID']); return response();
  });
  for (let i = 0; i < 2; i++) await m.fetch(BASE, { headers: { Authorization: 'secret-token' }, body: 'private prompt' });
  assert.notEqual(ids[0], ids[1]); assert.equal(m.snapshot().estimatedMicros, 17680);
  const serialized = JSON.stringify([...records.values()]);
  assert.doesNotMatch(serialized, /secret-token|private prompt|private result/);
  assert.equal(m.snapshot().status, 'tariff_estimate');
  await assert.rejects(m.fetch(BASE, {}), /ATTEMPT_LIMIT/);
});
test('network failures, missing usage and error responses remain pending, known subtotal is separate', async () => {
  const { db } = fixture(); let calls = 0;
  const m = meter(db, async () => ++calls === 1 ? response() : response('', null, 400));
  await m.fetch(BASE, {}); await m.fetch(BASE, {});
  assert.equal(m.snapshot().estimatedMicros, null); assert.equal(m.snapshot().knownMicros, 8840);
  assert.equal(m.snapshot().unknownAttempts, 1);
  const n = meter(db, async () => { throw new Error('network'); });
  await assert.rejects(n.fetch(BASE, {}), /network/);
  assert.equal(n.snapshot().status, 'pending_reconciliation');
});
test('pre-write failure prevents network; post-write failure leaves durable pending receipt', async () => {
  const first = fixture(); first.db.failWrite = 1;
  await assert.rejects(meter(first.db, () => { assert.fail('must not call provider'); }).fetch(BASE, {}), /offline/);
  const second = fixture(); second.db.failWrite = 2;
  const m = meter(second.db, async () => response()); await m.fetch(BASE, {});
  assert.equal([...second.records.values()][0].attempts[0].estimatedMicros, null);
  assert.equal(m.snapshot().recordingFailed, true);
});
test('disabled metering passes through without changing behavior or requiring a database', async () => {
  const fetcher = async () => response();
  const m = createTextMeter({ fetcher, env: {} });
  assert.equal(m.fetch, fetcher); assert.equal(m.snapshot(), null);
});
test('history reads only the server-resolved migrated account, strips internal fields and rejects other apps/revoked accounts', async () => {
  const { db, records } = fixture();
  const context = { APPID: 'wx123', OPENID: 'person_a' };
  const env = { TEXT_COMPUTE_USAGE_ENABLED: 'true', WECHAT_APP_ID: context.APPID };
  const key = 'user_accounts:account_' + createHash('sha256').update(context.OPENID).digest('hex').slice(0, 24);
  records.set(key, { status: 'active', wxOpenId: context.OPENID, accountId: identity.accountId });
  await meter(db, async () => response()).fetch(BASE, {});
  await meter(db, async () => response(), { identity: { accountId: 'account_' + 'b'.repeat(24) } }).fetch(BASE, {});
  const result = await readRecentTextUsage(db, context, env);
  assert.equal(result.operations.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /accountId|providerRequestId|priceVersion|CNY|model|prompt/);
  await assert.rejects(readRecentTextUsage(db, { ...context, APPID: 'wxWrong' }, env), /AUTH_REQUIRED/);
  records.get(key).status = 'revoked';
  await assert.rejects(readRecentTextUsage(db, context, env), /AUTH_REQUIRED/);
});
test('all deployable copies match and rules deny direct database access', () => {
  const canonical = fs.readFileSync(require.resolve('../cloudfunctions/chatInterview/textComputeUsage'), 'utf8');
  for (const name of ['organizeMemory', 'generateBiography', 'getOpenId'])
    assert.equal(fs.readFileSync(require.resolve(`../cloudfunctions/${name}/textComputeUsage`), 'utf8'), canonical);
  const rule = require('../deploy/text-compute/database.rules.json').collections.text_compute_operations;
  assert.deepEqual(rule, { read: false, write: false });
});

test('real cloud handlers record empty-response retry, timeout fallback and parsed-output failure before business handling', async () => {
  const names = ['AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL', 'CHAT_AI_MODEL', 'CHAT_AI_BASE_URL', 'ORGANIZE_AI_MODEL', 'ORGANIZE_AI_BASE_URL', 'TEXT_COMPUTE_USAGE_ENABLED'];
  const previous = Object.fromEntries(names.map(n => [n, process.env[n]])); const originalFetch = global.fetch;
  try {
    for (const n of names) delete process.env[n];
    Object.assign(process.env, { AI_API_KEY: 'test-key', AI_MODEL: MODEL, AI_BASE_URL: BASE, TEXT_COMPUTE_USAGE_ENABLED: 'true' });
    const { db, records } = fixture(); const deps = { skipGuard: true, db, identity };
    let calls = 0;
    global.fetch = async () => response(++calls === 1 ? '' : JSON.stringify({ dimension: 'place', text: '当时在哪儿？' }));
    const chat = await require('../cloudfunctions/chatInterview').main({ answer: '小时候夏天会乘凉。' }, deps);
    assert.equal(calls, 2); assert.equal(chat.computeUsage.attempts, 2); assert.ok(chat.computeUsage.estimatedMicros > 0);
    global.fetch = async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; };
    const organized = await require('../cloudfunctions/organizeMemory').main({ transcript: ['小时候夏天会乘凉。'], memoryType: 'note' }, deps);
    assert.equal(organized.computeUsage.status, 'pending_reconciliation');
    global.fetch = async () => response('');
    await assert.rejects(require('../cloudfunctions/generateBiography').main({ memories: [{ authorName: '甲', relation: '本人', text: '小时候夏天会乘凉。' }] }, deps), /EMPTY_MODEL_OUTPUT/);
    const row = [...records.values()].find(r => r.kind === 'generateBiography');
    assert.ok(row.attempts[0].estimatedMicros > 0);
    assert.equal(records.size, 3);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
