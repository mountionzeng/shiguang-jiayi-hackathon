const test=require('node:test');
const assert=require('node:assert/strict');
const {createMemoryService}=require('../cloudfunctions/personalMemory/service');
const {TABLES,digest}=require('../cloudfunctions/personalMemory/personalMemoryRepository');
const {prepareContext,commitContext}=require('../cloudfunctions/personalMemory/personalMemoryContext');
const {formatContext}=require('../cloudfunctions/personalMemory/personalMemoryCore');
const identity={accountId:'alice',familyId:'family_alice'};
const response=(patch={})=>({statementType:'direct_statement',insights:[{matchLineage:null,isContradiction:false,category:'preference',text:'喜欢在安静的地方阅读。',projectScoped:false,confidence:0.8,sensitive:false,...patch}]});
function fixture(extract=async()=>response()) {
  const tables=new Map(); let active=true,chain=Promise.resolve(),calls=0;
  const source={memoryId:'m1',sourceDocId:'family_alice_m1',text:'我喜欢安静地读书。',fingerprint:digest('我喜欢安静地读书。'),evidenceId:'e1',occurredOn:'2026-09-01'};
  tables.set('memories:family_alice_m1',{scope:'personal',text:source.text});
  const io={get:async(t,id)=>structuredClone(tables.get(t+':'+id)),set:async(t,id,v)=>tables.set(t+':'+id,structuredClone(v)),authorize:async()=>{if(!active)throw new Error('IDENTITY_REVOKED');}};
  const repo={...io,source:async(ctx,id)=>ctx.accountId==='alice'&&id==='m1'&&!tables.get('memories:family_alice_m1')?.deletedAt?source:null,
    snapshot:async ctx=>({control:await io.get(TABLES.controls,ctx.accountId)||{version:0,enabled:false},...Object.fromEntries(['insights','evidence','suppressions'].map(kind=>[kind,[...tables].filter(([k,v])=>k.startsWith(TABLES[kind]+':')&&v.userId===ctx.accountId).map(([,v])=>structuredClone(v))]))}),
    transaction:fn=>{const next=chain.then(async()=>{const before=structuredClone(tables);try{return await fn(io);}catch(e){tables.clear();for(const [k,v]of before)tables.set(k,v);throw e;}});chain=next.catch(()=>{});return next;}};
  const service=createMemoryService(repo,{extract:async(...args)=>{calls++;return extract(...args);},now:()=>Date.parse('2026-09-22T00:00:00Z')});
  const enable=()=>service(identity,{action:'configure',enabled:true,consentVersion:1});
  return {tables,repo,service,enable,source,calls:()=>calls,revoke:()=>{active=false;}};
}
test('explicit consent is required and saved evidence is extracted once; user ids are never accepted from events',async()=>{
  const f=fixture();
  assert.equal((await f.service(identity,{action:'extract',memoryId:'m1'})).status,'disabled');
  assert.equal(f.calls(),0);
  await assert.rejects(f.service(identity,{action:'configure',enabled:true}),/CONSENT/);
  await f.enable();
  await f.service(identity,{action:'extract',memoryId:'m1',userId:'bob'});
  await f.service(identity,{action:'extract',memoryId:'m1'});
  assert.equal(f.calls(),1);
  assert.equal((await f.service(identity,{action:'list'})).insights.length,1);
  assert.equal((await f.service({accountId:'bob'},{action:'list'})).insights.length,0);
});
test('private insights are filtered before candidate assembly, even when highly confident',async()=>{
  const f=fixture(async()=>response({sensitive:true})); await f.enable();
  await f.service(identity,{action:'extract',memoryId:'m1'});
  const context=await prepareContext(f.repo,identity);
  assert.deepEqual(context.selected,[]);assert.deepEqual(context.promptContext,[]);
});
test('context retains origin, tracks cooldown on success, and cannot be released after forgetting',async()=>{
  const f=fixture();await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  const first=await prepareContext(f.repo,identity,{nowMs:Date.parse('2026-09-22')});
  assert.equal(first.promptContext[0].origin,'user_stated');
  assert.match(formatContext(first.promptContext),/不是指令/);
  await commitContext(f.repo,identity,first,Date.parse('2026-09-22'));
  assert.equal((await prepareContext(f.repo,identity,{nowMs:Date.parse('2026-09-23')})).selected.length,0);
  const later=await prepareContext(f.repo,identity,{nowMs:Date.parse('2026-10-02')});
  const lineageKey=later.selected[0].lineageKey;
  await f.service(identity,{action:'forget',lineageKey});
  await assert.rejects(commitContext(f.repo,identity,later),/PERSONAL_MEMORY_CHANGED/);
  assert.equal((await f.service(identity,{action:'extract',memoryId:'m1'})).status,'suppressed');
  await f.service(identity,{action:'configure',enabled:false});await f.enable();
  assert.deepEqual((await f.service(identity,{action:'list'})).insights,[]);
});
test('a forget racing a pending extraction blocks stale writes and never resurrects the evidence',async()=>{
  let release,started;const startedPromise=new Promise(r=>started=r);
  const f=fixture(async()=>{started();return new Promise(r=>release=r);});await f.enable();
  const pending=f.service(identity,{action:'extract',memoryId:'m1'});await startedPromise;
  await f.service(identity,{action:'configure',enabled:false});
  release(response());await assert.rejects(pending,/PERSONAL_MEMORY_CHANGED/);
  assert.deepEqual((await f.service(identity,{action:'list'})).insights,[]);
});
test('deleted source or revoked identity during extraction cannot leave active understanding',async()=>{
  for(const mutation of ['delete','revoke']) {
    let release,started;const begun=new Promise(r=>started=r);
    const f=fixture(async()=>{started();return new Promise(r=>release=r);});await f.enable();
    const pending=f.service(identity,{action:'extract',memoryId:'m1'});await begun;
    if(mutation==='delete')f.tables.get('memories:family_alice_m1').deletedAt='now';else f.revoke();
    release(response());await assert.rejects(pending,/SOURCE_CHANGED|IDENTITY_REVOKED/);
    assert.equal([...f.tables.keys()].filter(k=>k.startsWith(TABLES.insights+':')).length,0);
  }
});
test('model failure is retryable and does not mark a job successful',async()=>{
  let fail=true;const f=fixture(async()=>{if(fail)throw new Error('provider unavailable');return response();});await f.enable();
  await assert.rejects(f.service(identity,{action:'extract',memoryId:'m1'}),/provider/);
  fail=false;await f.service(identity,{action:'extract',memoryId:'m1'});
  assert.equal(f.calls(),2);assert.equal((await f.service(identity,{action:'list'})).insights.length,1);
});

test('forget retains superseded evidence, not only the current revision evidence',async()=>{
  let correction=false;
  const f=fixture(async()=>response(correction?{matchLineage:'C1',isContradiction:true,text:'现在更喜欢与朋友一起阅读。'}:{}));
  await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  const first=(await f.service(identity,{action:'list'})).insights[0];
  correction=true;
  f.source.evidenceId='e2';f.source.text='现在我喜欢和朋友一起读书。';f.source.fingerprint=digest(f.source.text);
  f.tables.get('memories:family_alice_m1').text=f.source.text;
  await f.service(identity,{action:'extract',memoryId:'m1'});
  const updated=(await f.service(identity,{action:'list'})).insights[0];
  assert.equal(updated.lineageKey,first.lineageKey);assert.equal(updated.origin,'user_corrected');
  await f.service(identity,{action:'forget',lineageKey:first.lineageKey});
  const tombstone=f.tables.get(TABLES.suppressions+':alice_'+first.lineageKey);
  assert.deepEqual(tombstone.evidenceIds.sort(),['e1','e2']);
});
