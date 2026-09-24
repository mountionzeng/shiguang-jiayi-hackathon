import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTextCompute, parseTextComputeView } from '../miniprogram/services/textComputeUsageService';
const operation = { id: 'test-call', kind: 'chatInterview', startedAt: 1_790_000_000_000,
  status: 'tariff_estimate', estimatedMicros: 8840, knownMicros: 8840, attempts: 1, unknownAttempts: 0 };
const view = (row: unknown) => parseTextComputeView({ version: 1, unit: 'compute', enabled: true, operations: [row] });
test('front end preserves tiny compute and labels estimates, never currency or settled charges', () => {
  assert.equal(formatTextCompute(8840), '0.00884 算力');
  assert.equal(formatTextCompute(1), '0.000001 算力');
  assert.equal(view(operation).rows[0].detail, '预估 0.00884 算力');
  assert.doesNotMatch(JSON.stringify(view(operation)), /¥|￥|人民币|已扣/);
});
test('partial/absent receipts are pending, not a zero or fake total', () => {
  const pending = { ...operation, status: 'pending_reconciliation', estimatedMicros: null, unknownAttempts: 1, attempts: 2 };
  assert.equal(view(pending).rows[0].detail, '已知部分预估 0.00884 算力，其余待核对');
  assert.equal(view({ ...pending, knownMicros: 0 }).rows[0].detail, '用量待核对');
});
test('malformed or mixed-unit responses fail closed', () => {
  for (const row of [null, { ...operation, estimatedMicros: -1 }, { ...operation, kind: '__proto__' },
    { ...operation, status: 'settled_actual' }, { ...operation, unknownAttempts: 1 }, { ...operation, attempts: 0 }])
    assert.throws(() => view(row), /暂不可用/);
  assert.throws(() => parseTextComputeView({ version: 1, unit: 'CNY', enabled: true, operations: [operation] }), /暂不可用/);
  assert.deepEqual(parseTextComputeView({ version: 1, unit: 'compute', enabled: false, operations: [] }), { enabled: false, rows: [] });
});

test('a late usage response from an earlier page visit cannot update the new visit', async () => {
  const previousPage = Object.getOwnPropertyDescriptor(globalThis, 'Page');
  const previousWx = Object.getOwnPropertyDescriptor(globalThis, 'wx');
  type Definition = {
    _computeVisible: boolean; _computeEpoch: number; _textComputeReading: boolean;
    refreshTextCompute(): Promise<void>; setData(value: unknown): void;
  };
  let page: Definition | undefined;
  let resolveResponse: ((value: unknown) => void) | undefined;
  const updates: unknown[] = [];
  Object.defineProperty(globalThis, 'Page', { configurable: true, value: (value: Definition) => { page = value; } });
  Object.defineProperty(globalThis, 'wx', { configurable: true, value: {
    getStorageSync: () => undefined,
    cloud: { callFunction: () => new Promise(resolve => { resolveResponse = resolve; }) },
  } });
  try {
    await import('../miniprogram/pages/me/me');
    assert.ok(page);
    page.setData = value => updates.push(value);
    page._computeVisible = true; page._computeEpoch = 1;
    const pending = page.refreshTextCompute();
    page._computeEpoch = 2;
    assert.ok(resolveResponse);
    resolveResponse({ result: { version: 1, unit: 'compute', enabled: true, operations: [operation] } });
    await pending;
    assert.equal(updates.length, 0);
    assert.equal(page._textComputeReading, false);
  } finally {
    if (previousPage) Object.defineProperty(globalThis, 'Page', previousPage);
    else Reflect.deleteProperty(globalThis, 'Page');
    if (previousWx) Object.defineProperty(globalThis, 'wx', previousWx);
    else Reflect.deleteProperty(globalThis, 'wx');
  }
});
