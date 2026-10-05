import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { initialXiaoyiPanelData, onXiaoyiAnswerInput, onXiaoyiDraftInput, organizeXiaoyiAnswer, useXiaoyiDraft, type XiaoyiHost } from '../miniprogram/services/xiaoyiCompanion';

function host() {
  const patches: Record<string, unknown>[] = [];
  const landed: string[] = [];
  const page: XiaoyiHost = {
    data: { ...initialXiaoyiPanelData() },
    setData(patch) { patches.push(patch); Object.assign(this.data, patch); },
    xiaoyiAskedDimensions: [], xiaoyiConversation: [],
    xiaoyiConfig: () => ({ memoryType: 'memoir' }),
    xiaoyiContextText: () => '原来的正文',
    xiaoyiLand: async text => { landed.push(text); return true; },
  };
  return { page, patches, landed };
}

test('native dictation and draft editing retain the latest full value without echoing into the input', async () => {
  const { page, patches, landed } = host();
  for (const value of ['我愿意', '我愿意对待一个小生命', '我愿意对待一个小生命。']) {
    onXiaoyiAnswerInput.call(page, { detail: { value } });
  }
  assert.equal(page.data.xiaoyiAnswer, '我愿意对待一个小生命。');
  assert.equal(patches.some(patch => 'xiaoyiAnswer' in patch), false, 'setData must not replay native IME text');
  onXiaoyiDraftInput.call(page, { detail: { value: '很久很久以前，我愿意照顾它。' } });
  assert.equal(patches.some(patch => 'xiaoyiDraftText' in patch), false);
  await useXiaoyiDraft.call(page);
  assert.deepEqual(landed, ['很久很久以前，我愿意照顾它。'], 'intentional repetition is preserved');
});

test('organize stays available without a prior successful question and keyboard taps keep their target', () => {
  for (const name of ['book', 'interview', 'archive']) {
    const template = readFileSync(`miniprogram/pages/${name}/${name}.wxml`, 'utf8');
    const action = template.match(/<button[^>]*bindtap="organizeXiaoyiAnswer"[^>]*>/)?.[0] || '';
    assert.ok(action);
    assert.doesNotMatch(action, /xiaoyiCanOrganize/, `${name}: previous question must not gate organization`);
    const input = template.match(/<textarea[^>]*class="xiaoyi-answer"[^>]*>/)?.[0] || '';
    assert.match(input, /hold-keyboard="\{\{true\}\}"/, `${name}: prevent keyboard collapse from moving the button before tap`);
  }
});

test('direct organization uses the latest answer; failed calls retain input and allow a retry', async context => {
  const previousWx = Object.getOwnPropertyDescriptor(globalThis, 'wx');
  const previousApp = Object.getOwnPropertyDescriptor(globalThis, 'getApp');
  context.after(() => {
    if (previousWx) Object.defineProperty(globalThis, 'wx', previousWx); else delete (globalThis as any).wx;
    if (previousApp) Object.defineProperty(globalThis, 'getApp', previousApp); else delete (globalThis as any).getApp;
  });
  const calls: any[] = [];
  let fail = true;
  Object.defineProperty(globalThis, 'getApp', { configurable: true, value: () => ({ globalData: { cloudReady: true, aiReady: true } }) });
  Object.defineProperty(globalThis, 'wx', { configurable: true, value: {
    getStorageSync: () => ({ granted: true, version: 1 }),
    cloud: { callFunction: async (request: any) => {
      calls.push(request);
      if (fail) throw new Error('network unavailable');
      return { result: { body: '我愿意善待这个小生命。', generationMode: 'cloud-ai' } };
    } },
  } });
  const { page, landed } = host();
  onXiaoyiAnswerInput.call(page, { detail: { value: '我愿意对待一个对我毫无伤害的小生命。' } });
  await organizeXiaoyiAnswer.call(page);
  assert.equal(page.data.xiaoyiLoading, false);
  assert.equal(page.data.xiaoyiDraftText, '');
  assert.equal(page.data.xiaoyiAnswer, '我愿意对待一个对我毫无伤害的小生命。');
  assert.ok(page.data.xiaoyiStatus);
  fail = false;
  await organizeXiaoyiAnswer.call(page);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].name, 'organizeMemory');
  assert.deepEqual(calls[1].data.transcript, [page.data.xiaoyiAnswer]);
  assert.equal(page.data.xiaoyiDraftText, '我愿意善待这个小生命。');
  assert.deepEqual(landed, [], 'organization must not write into the original document');
});
