const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, subjectFor, loadComputeBalance, postCompute } = require('../cloudfunctions/getOpenId/computeGateway');
const bridge = require('../cloudfunctions/drinkingTimeBridge/core');
const fs = require('node:fs');
const vm = require('node:vm');

test('compute uses exactly the same trusted identity and canonical JSON as desktop pairing', () => {
  const context = { APPID: 'wx1234', OPENID: 'openid_test' };
  assert.equal(subjectFor(context), bridge.subjectFor(context.APPID, context.OPENID));
  const body = { z: [{ b: 1, a: '中文' }], omitted: undefined, a: null };
  assert.equal(canonicalJson(body), bridge.canonicalJson(body));
  assert.throws(() => subjectFor({ OPENID: context.OPENID }), /AUTH_REQUIRED/);
  assert.throws(() => postCompute(context, 'balance', {}, {}), /COMPUTE_NOT_CONFIGURED/);
  assert.throws(() => postCompute(context, 'grant'), /INVALID_COMPUTE_ACTION/);
});
test('balance validates units and precision, never silently returning a fake gift', async () => {
  const balance = { version: 1, unit: 'compute', availableMicros: 9_500_000, reservedMicros: 0, spentMicros: 500_000 };
  assert.deepEqual(await loadComputeBalance({}, async () => balance), balance);
  for (const bad of [null, {}, { ...balance, unit: 'CNY' }, { ...balance, availableMicros: -1 }, { ...balance, spentMicros: 0.5 }]) {
    await assert.rejects(loadComputeBalance({}, async () => bad), /INVALID_COMPUTE_BALANCE/);
  }
  await assert.rejects(loadComputeBalance({}, async () => { throw new Error('offline'); }), /offline/);
});

test('public balance action uses trusted context, never caller identity or settlement fields', async () => {
  const context = { APPID: 'wx1234', OPENID: 'trusted_openid' };
  const calls = [];
  const sandbox = {
    module: { exports: {} }, process: { env: {} }, console,
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, getWXContext: () => context };
      if (name === './computeGateway') return { loadComputeBalance: async (...args) => { calls.push(args); return { availableMicros: 10 }; } };
      if (name === './account') return {};
      if (name === './textComputeUsage') return {};
      throw new Error('unexpected import');
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/getOpenId/index'), 'utf8'), sandbox);
  await sandbox.module.exports.main({ action: 'computeBalance', OPENID: 'attacker', userId: 7, subject: 'forged', verifiedCostMinor: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.equal(calls[0][0], context);
});

test('wallet deadline covers a stalled connection within the login function timeout', async () => {
  const { EventEmitter } = require('node:events');
  const request = new EventEmitter();
  request.end = () => {};
  request.destroy = error => { request.emit('error', error); request.emit('close'); };
  let fireDeadline, duration, cleared = false;
  const sandbox = { module: { exports: {} }, Buffer, URL, process: { env: {} },
    require(name) { return name === 'node:https' ? { request: () => request } : require(name); },
    setTimeout(fn, ms) { fireDeadline = fn; duration = ms; return 17; },
    clearTimeout(id) { assert.equal(id, 17); cleared = true; },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/getOpenId/computeGateway'), 'utf8'), sandbox);
  const promise = sandbox.module.exports.postCompute({ APPID: 'wx123', OPENID: 'test_user' }, 'balance', {},
    { DRINKING_TIME_BRIDGE_SECRET: 'test-secret'.repeat(4), DRINKING_TIME_BRIDGE_BASE_URL: 'https://example.invalid/api/shiguang' });
  assert.equal(duration, 4500);
  const rejection = assert.rejects(promise, /COMPUTE_TIMEOUT/);
  fireDeadline();
  await rejection;
  assert.equal(cleared, true);
});
