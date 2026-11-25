const test = require('node:test');
const assert = require('node:assert/strict');
const {createTextModerator} = require('../cloudfunctions/storyBooks/moderation');
const {errorCode} = require('../cloudfunctions/storyBooks/errors');

/*
 * 回归：检测服务自己坏了，不能说成用户的内容违规。
 * 原实现在 security 缺失、openid 无效、msgSecCheck 抛错时一律返回 false，
 * 调用方按 `!== true` 提示「这段内容没有通过内容安全检测，请修改后重试」，
 * 用户改多少遍都没用，而且不留日志。
 */
test('检测服务故障抛 MODERATION_UNAVAILABLE，不再被当成内容违规', async () => {
  await assert.rejects(
    () => createTextModerator(undefined)('一段回忆', 'openid-1'),
    error => error.code === 'MODERATION_UNAVAILABLE',
  );
  await assert.rejects(
    () => createTextModerator({})('一段回忆', 'openid-1'),
    error => error.code === 'MODERATION_UNAVAILABLE',
  );
  await assert.rejects(
    () => createTextModerator({msgSecCheck: async () => ({})})('一段回忆', '非法 openid!'),
    error => error.code === 'MODERATION_UNAVAILABLE',
  );
  await assert.rejects(
    () => createTextModerator({msgSecCheck: async () => {throw new Error('网络超时');}})('一段回忆', 'openid-1'),
    error => error.code === 'MODERATION_UNAVAILABLE',
  );
  assert.equal(errorCode(Object.assign(new Error('暂时不可用'), {code: 'MODERATION_UNAVAILABLE'})), 'MODERATION_UNAVAILABLE');
});

test('内容确实违规时仍然返回 false，用户改文字可以解决', async () => {
  const moderate = createTextModerator({msgSecCheck: async () => ({result: {suggest: 'risky'}})});
  assert.equal(await moderate('需要修改的内容', 'openid-1'), false);
});

test('内容通过时返回 true，空内容不打扰检测服务', async () => {
  let calls = 0;
  const moderate = createTextModerator({msgSecCheck: async () => {calls += 1; return {result: {suggest: 'pass'}};}});
  assert.equal(await moderate('平常的一段回忆', 'openid-1'), true);
  assert.equal(await moderate('   ', 'openid-1'), true);
  assert.equal(calls, 1, '空内容不应该调用检测接口');
});

test('storyBooks 直连检测不可用时复用共享内容安全云函数', async () => {
  const calls = [];
  const moderate = createTextModerator({
    msgSecCheck: async () => { throw new Error('direct openapi unavailable'); },
  }, async request => {
    calls.push(request);
    return { result: { ok: true, suggest: 'pass', label: 100 } };
  });
  assert.equal(await moderate('平常的一段回忆', 'openid-1', '公开故事卡片'), true);
  assert.deepEqual(calls, [{
    name: 'contentSecurityCheck',
    data: { content: '平常的一段回忆', scene: 4, openid: 'openid-1', title: '公开故事卡片' },
  }]);
});

test('共享内容安全云函数故障时仍然抛 MODERATION_UNAVAILABLE', async () => {
  const moderate = createTextModerator(undefined, async () => ({ result: { ok: false, error: 'CHECK_UNAVAILABLE' } }));
  await assert.rejects(
    () => moderate('平常的一段回忆', 'openid-1', '公开故事卡片'),
    error => error.code === 'MODERATION_UNAVAILABLE',
  );
});


test('分享审核在微信及共享审核不可用时使用付费审核，包含标题', async () => {
  const calls=[];
  const moderate=createTextModerator({msgSecCheck:async()=>{throw new Error('daily quota');}},
    async()=>({result:{ok:false,error:'daily quota'}}),
    async input=>{calls.push(input);return {available:true,status:'pass'};});
  assert.equal(await moderate('回忆正文','openid-1','回忆标题'),true);
  assert.deepEqual(calls,[{content:'回忆标题\n回忆正文'}]);
});

test('分享审核不对微信或共享审核的拒绝进行付费重判', async () => {
  let calls=0;const paid=async()=>{calls++;return {available:true,status:'pass'};};
  assert.equal(await createTextModerator({msgSecCheck:async()=>({result:{suggest:'risky'}})},undefined,paid)('正文','openid-1'),false);
  await assert.rejects(createTextModerator(undefined,async()=>({result:{ok:false,suggest:'review'}}),paid)('正文','openid-1'),{code:'MODERATION_REVIEW'});
  assert.equal(calls,0);
});

test('付费分享审核拒绝或不可用时不能通过，前段通过也不代表全文通过', async () => {
  const shared=async()=>({result:{error:'daily quota'}});
  for(const result of [{available:true,status:'reject'}]) {
    assert.equal(await createTextModerator(undefined,shared,async()=>result)('正文','openid-1'),false);
  }
  for(const paid of [async()=>({available:false}),async()=>({available:true}),async()=>{throw new Error('network');}]){
    await assert.rejects(()=>createTextModerator(undefined,shared,paid)('正文','openid-1'),e=>e.code==='MODERATION_UNAVAILABLE');
  }
  let chunk=0;
  assert.equal(await createTextModerator(undefined,shared,async()=>({available:true,status:++chunk===1?'pass':'reject'}))('字'.repeat(2501),'openid-1'),false);
  assert.equal(chunk,2);
});

test('missing verdict and returned service errors are unavailable, not user content rejection',async()=>{
 for(const response of [{},{errCode:45009,errMsg:'quota'},{result:{suggest:'unknown'}}]) {
   await assert.rejects(createTextModerator({msgSecCheck:async()=>response},undefined,async()=>({available:false}))('文字','openid-1'),{code:'MODERATION_UNAVAILABLE'});
 }
 for(const result of [{},{ok:false,suggest:'pass'},{ok:true,suggest:'risky'}])
   await assert.rejects(createTextModerator(undefined,async()=>({result}),async()=>({available:false}))('文字','openid-1'),{code:'MODERATION_UNAVAILABLE'});
});

test('explicit WeChat rejection cannot be retried through another provider as an outage',async()=>{
 let fallbacks=0;
 const moderate=createTextModerator({msgSecCheck:async()=>{throw {errCode:87014};}},async()=>{fallbacks++;return {result:{ok:true}};});
 assert.equal(await moderate('文字','openid-1'),false);assert.equal(fallbacks,0);
});


test('review is distinct from rejection and never retried with another checker',async()=>{
 let fallbackCalls=0;
 const fallback=async()=>{fallbackCalls++;return {result:{ok:true}};};
 await assert.rejects(createTextModerator({msgSecCheck:async()=>({result:{suggest:'review'}})},fallback)('正文','openid-1'),{code:'MODERATION_REVIEW'});
 await assert.rejects(createTextModerator(undefined,async()=>({result:{error:'quota'}}),async()=>({available:true,status:'reject',suggestion:'Review'}))('正文','openid-1'),{code:'MODERATION_REVIEW'});
 assert.equal(fallbackCalls,0);
 assert.equal(errorCode(Object.assign(new Error('review'),{code:'MODERATION_REVIEW'})),'MODERATION_REVIEW');
});

test('shared explicit rejection is final even when wrapped as an error',async()=>{
 let paidCalls=0;
 const result=await createTextModerator(undefined,async()=>({result:{ok:false,suggest:'review',error:'openapi.security.msgSecCheck:fail errCode: 87014 risky content'}}),async()=>{paidCalls++;return {available:true,status:'pass'};})('正文','openid-1');
 assert.equal(result,false);assert.equal(paidCalls,0);
});

test('checker diagnostics never log manuscript, caller identity or raw provider errors',async()=>{
 const logs=[];const oldError=console.error,oldWarn=console.warn;
 console.error=(...args)=>logs.push(args);console.warn=(...args)=>logs.push(args);
 try {
   await assert.rejects(createTextModerator({msgSecCheck:async()=>{throw Error('secret manuscript private-openid');}},undefined,async()=>({available:false}))('secret manuscript','private-openid'),{code:'MODERATION_UNAVAILABLE'});
   await assert.rejects(createTextModerator({msgSecCheck:async()=>({result:{suggest:'review',label:100},traceId:'trace-123'})})('secret manuscript','private-openid'),{code:'MODERATION_REVIEW'});
   const text=JSON.stringify(logs);assert.doesNotMatch(text,/secret manuscript|private-openid/);assert.match(text,/trace-123/);
 } finally {console.error=oldError;console.warn=oldWarn;}
});
