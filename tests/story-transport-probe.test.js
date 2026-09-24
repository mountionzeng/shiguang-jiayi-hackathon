const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runStoryTransportProbe, utf8Bytes } = require('../scripts/diagnostics/story-transport-probe');

test('diagnostic UTF-8 sizing agrees with actual encoded multilingual JSON', () => {
  for (const value of ['ASCII', '中文', 'é', '😀', '\ud800', '换行\n和"引号']) {
    const json = JSON.stringify(value);
    assert.equal(utf8Bytes(json), Buffer.byteLength(json, 'utf8'));
  }
});

test('probe alternates only read operations and measures calls separately from analysis callbacks', async () => {
  let clock = 0;
  const actions = [];
  const samples = await runStoryTransportProbe(async input => {
    assert.equal(input.name, 'storyBooks');
    actions.push(input.data.action);
    clock += 100;
    return { result: input.data.action === 'state' ? { stories: [], manuscriptRevisions: [] } : {} };
  }, { now: () => clock, onSample: () => { clock += 200; } });
  assert.deepEqual(actions, ['capabilities', 'state', 'state', 'capabilities', 'capabilities', 'state']);
  assert.equal(samples.length, 6);
  assert.ok(samples.every(sample => sample.durationMs === 100));
});

test('probe returns counts and sizes without retaining account identifiers or manuscript content', async () => {
  const secret = 'PRIVATE_CONTENT_DO_NOT_LOG';
  const result = { openid: secret, unknownField: secret, stories: [{ id: secret, currentRevisionId: secret }],
    manuscriptRevisions: [{ id: secret, draft: { text: secret }, sourceFingerprint: secret }],
    contributions: [{ text: secret }], storyMigration: { status: 'active', nested: secret } };
  const samples = await runStoryTransportProbe(async () => ({ result, requestID: secret }));
  assert.equal(JSON.stringify(samples).includes(secret), false);
  const state = samples[1];
  assert.equal(state.revisions.matchingCurrentCount, 1);
  assert.equal(state.fields.manuscriptRevisions.count, 1);
  assert.equal(state.utf8Bytes, Buffer.byteLength(JSON.stringify(result)));
  assert.equal('unknownField' in state.fields, false);
});

test('transport and invalid service responses stop the probe without exposing SDK error text', async () => {
  let count = 0;
  const failed = await runStoryTransportProbe(async () => { count++; throw new Error('PRIVATE_URL'); });
  assert.equal(count, 1);
  assert.equal(failed[0].failure, 'transport');
  assert.equal(JSON.stringify(failed).includes('PRIVATE_URL'), false);
  const invalid = await runStoryTransportProbe(async () => ({ result: { error: 'PRIVATE_MESSAGE' } }));
  assert.equal(invalid[0].failure, 'response');
  assert.equal(JSON.stringify(invalid).includes('PRIVATE_MESSAGE'), false);
});

test('leaving the diagnostic page prevents subsequent calls', async () => {
  let stopped = false;
  const samples = await runStoryTransportProbe(async () => ({ result: {} }), {
    cancelled: () => stopped, onSample: () => { stopped = true; },
  });
  assert.equal(samples.length, 1);
});
