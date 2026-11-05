import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { initialXiaoyiPanelData, onXiaoyiAnswerInput, onXiaoyiDraftInput, organizeXiaoyiAnswer, useXiaoyiDraft, useXiaoyiOriginal, askXiaoyiQuestion, type XiaoyiHost } from '../miniprogram/services/xiaoyiCompanion';
import { clearAiConsent } from '../miniprogram/services/aiConsent';

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

test('cancelled AI permission preserves input and never labels denial as a connection failure', async context => {
  const previousWx = Object.getOwnPropertyDescriptor(globalThis, 'wx');
  const previousApp = Object.getOwnPropertyDescriptor(globalThis, 'getApp');
  Object.defineProperty(globalThis, 'getApp', { configurable: true, value: () => ({ globalData: { cloudReady: true, aiReady: true } }) });
  Object.defineProperty(globalThis, 'wx', { configurable: true, value: {
    showModal: ({ success }: any) => success({ confirm: false }),
    cloud: { callFunction: async () => { assert.fail('denied content must not reach the provider'); } },
  } });
  clearAiConsent();
  context.after(() => {
    clearAiConsent();
    if (previousWx) Object.defineProperty(globalThis, 'wx', previousWx); else delete (globalThis as any).wx;
    if (previousApp) Object.defineProperty(globalThis, 'getApp', previousApp); else delete (globalThis as any).getApp;
  });
  const { page, landed } = host();
  page.data.xiaoyiAnswer = '【虚构验收】绿色笔记本';
  await askXiaoyiQuestion.call(page);
  assert.equal(page.data.xiaoyiAnswer, '【虚构验收】绿色笔记本');
  assert.equal(page.data.xiaoyiLoading, false);
  assert.deepEqual(landed, []);
  const reply = page.data.xiaoyiMessages[page.data.xiaoyiMessages.length - 1];
  assert.equal(reply?.label, '尚未允许在线处理');
  assert.match(reply?.text || '', /我的.*在线 AI 授权/);
});

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
  assert.deepEqual(landed, [], 'drafts without generated origin must not land');
  assert.equal(page.data.xiaoyiDraftText, '', 'stale draft text is cleared after rejection');
  assert.match(page.data.xiaoyiStatus, /重新生成/);
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

test('successful chat consumes only the sent input; newer typing stays untouched', async context => {
  const previousWx=(globalThis as any).wx,previousApp=(globalThis as any).getApp;
  context.after(()=>{clearAiConsent();(globalThis as any).wx=previousWx;(globalThis as any).getApp=previousApp;});
  (globalThis as any).getApp=()=>({globalData:{cloudReady:true,aiReady:true}});
  for(const nextInput of ['', 'next unsent sentence']){
    clearAiConsent();let reply:(value:any)=>void=()=>{},started:()=>void=()=>{};
    const entered=new Promise<void>(r=>{started=r;});
    (globalThis as any).wx={getStorageSync:()=>({granted:true,version:1}),cloud:{callFunction:()=>{started();return new Promise(r=>{reply=r;});}}};
    const {page,landed}=host();page.data.xiaoyiAnswer='sent sentence';
    const pending=askXiaoyiQuestion.call(page);await entered;
    if(nextInput)onXiaoyiAnswerInput.call(page,{detail:{value:nextInput}});
    reply({result:{dimension:'event',text:'A follow-up question'}});await pending;
    assert.equal(page.data.xiaoyiAnswer,nextInput);assert.equal(page.data.xiaoyiLoading,false);
    assert.ok(page.xiaoyiConversation.some(turn=>turn.role==='user'&&turn.text==='sent sentence'));
    assert.ok(page.xiaoyiConversation.some(turn=>turn.role==='assistant'&&turn.text==='A follow-up question'));
    if(!nextInput){
      const count=page.xiaoyiConversation.length;
      await useXiaoyiOriginal.call(page);
      assert.deepEqual(landed,['sent sentence']);assert.equal(page.xiaoyiConversation.length,count);
    }
  }
});
