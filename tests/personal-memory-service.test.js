const test=require('node:test');
const assert=require('node:assert/strict');
const {createMemoryService}=require('../cloudfunctions/personalMemory/service');
const {TABLES,digest}=require('../cloudfunctions/personalMemory/personalMemoryRepository');
const {prepareContext,commitContext}=require('../cloudfunctions/personalMemory/personalMemoryContext');
const {formatContext}=require('../cloudfunctions/personalMemory/personalMemoryCore');
const identity={accountId:'alice',familyId:'family_alice'};
const response=(patch={})=>({statementType:'direct_statement',insights:[{matchLineage:null,isContradiction:false,category:'preference',conversationTendency:false,text:'喜欢在安静的地方阅读。',projectScoped:false,confidence:0.8,sensitive:false,...patch}]});
function fixture(extract=async()=>response()) {
  const tables=new Map(); let active=true,chain=Promise.resolve(),calls=0;
  const source={memoryId:'m1',sourceDocId:'family_alice_m1',text:'我喜欢安静地读书。',fingerprint:digest('我喜欢安静地读书。'),evidenceId:'e1',occurredOn:'2026-09-01'};
  const sourceMap=new Map([['m1',source]]);
  tables.set('memories:family_alice_m1',{scope:'personal',text:source.text});
  const io={get:async(t,id)=>structuredClone(tables.get(t+':'+id)),set:async(t,id,v)=>tables.set(t+':'+id,structuredClone(v)),authorize:async()=>{if(!active)throw new Error('IDENTITY_REVOKED');}};
  const repo={...io,source:async(ctx,id)=>ctx.accountId==='alice'&&sourceMap.has(id)&&!tables.get('memories:'+sourceMap.get(id).sourceDocId)?.deletedAt?sourceMap.get(id):null,
    snapshot:async ctx=>({control:await io.get(TABLES.controls,ctx.accountId)||{version:0,enabled:false},...Object.fromEntries(['insights','evidence','suppressions'].map(kind=>[kind,[...tables].filter(([k,v])=>k.startsWith(TABLES[kind]+':')&&v.userId===ctx.accountId).map(([,v])=>structuredClone(v))]))}),
    transaction:fn=>{const next=chain.then(async()=>{const before=structuredClone(tables);try{return await fn(io);}catch(e){tables.clear();for(const [k,v]of before)tables.set(k,v);throw e;}});chain=next.catch(()=>{});return next;}};
  const service=createMemoryService(repo,{extract:async(...args)=>{calls++;return extract(...args);},now:()=>Date.parse('2026-09-22T00:00:00Z')});
  const enable=()=>service(identity,{action:'configure',enabled:true,consentVersion:1});
  const addSource=(memoryId,text)=>{
    const added={memoryId,text,sourceDocId:'family_alice_'+memoryId,fingerprint:digest(text),evidenceId:'e-'+memoryId,occurredOn:'2026-09-22'};
    sourceMap.set(memoryId,added);tables.set('memories:'+added.sourceDocId,{scope:'personal',text});return added;
  };
  return {tables,repo,service,enable,source,addSource,calls:()=>calls,revoke:()=>{active=false;}};
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
  const listed=await f.service(identity,{action:'list'});
  assert.equal(listed.insights.length,1);
  assert.deepEqual(listed.insights[0].evidence,[{id:'e1',label:'讲述',occurredOn:'2026-09-01',excerpt:'我喜欢安静地读书。'}]);
  assert.equal((await f.service({accountId:'bob'},{action:'list'})).insights.length,0);
});
test('private insights are filtered before candidate assembly, even when highly confident',async()=>{
  const f=fixture(async()=>response({sensitive:true})); await f.enable();
  await f.service(identity,{action:'extract',memoryId:'m1'});
  const context=await prepareContext(f.repo,identity);
  assert.deepEqual(context.selected,[]);assert.deepEqual(context.promptContext,[]);
});
test('the visible memory list hides an insight after every source fingerprint stops matching',async()=>{
  const f=fixture();await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  f.repo.source=async()=>null;
  assert.deepEqual((await f.service(identity,{action:'list'})).insights,[]);
});
test('one inferred conversation tendency from one telling is neither displayed nor used in a prompt',async()=>{
  const f=fixture(async()=>({statementType:'inferred_behavior',insights:[{matchLineage:null,isContradiction:false,category:'preference',conversationTendency:true,text:'更愿意从自己的感受讲起。',projectScoped:false,confidence:0.9,sensitive:false}]}));
  await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  assert.deepEqual((await f.service(identity,{action:'list'})).insights,[]);
  const context=await prepareContext(f.repo,identity);
  assert.deepEqual(context.promptContext,[]);
});
test('new independent telling content can reassess a tentative tendency after three sources',async()=>{
  const f=fixture(async(source,candidates)=>({statementType:'inferred_behavior',insights:[{
    matchLineage:candidates[0]?.ref || null,isContradiction:false,category:'preference',conversationTendency:true,text:'更愿意从自己的感受讲起。',
    projectScoped:false,confidence:source.memoryId==='m1'?0.4:0.8,sensitive:false}]}));
  await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  const source2={...f.source,memoryId:'m2',sourceDocId:'family_alice_m2',text:'讲到这件事时，我总会先说心里的感受。',fingerprint:digest('讲到这件事时，我总会先说心里的感受。'),evidenceId:'e2',occurredOn:'2026-09-02'};
  const source3={...f.source,memoryId:'m3',sourceDocId:'family_alice_m3',text:'我想先说说那时自己心里怎么想。',fingerprint:digest('我想先说说那时自己心里怎么想。'),evidenceId:'e3',occurredOn:'2026-09-03'};
  f.tables.set('memories:family_alice_m2',{scope:'personal',text:source2.text});
  f.tables.set('memories:family_alice_m3',{scope:'personal',text:source3.text});
  f.repo.source=async(ctx,id)=>ctx.accountId==='alice'?({m1:f.source,m2:source2,m3:source3}[id] || null):null;
  await f.service(identity,{action:'extract',memoryId:'m2'});
  assert.deepEqual((await f.service(identity,{action:'list'})).insights,[]);
  await f.service(identity,{action:'extract',memoryId:'m3'});
  const listed=(await f.service(identity,{action:'list'})).insights;
  assert.equal(listed.length,1);
  assert.equal(listed[0].evidence.length,3);
  const stored=[...f.tables.entries()].find(([key,value])=>key.startsWith(TABLES.insights+':')&&value.status==='active')[1];
  assert.equal(stored.confidence,0.8);
});
test('copied tellings and edits of the same source cannot increase tendency confidence',async()=>{
  let confidence=0.4;
  const f=fixture(async(_source,candidates)=>response({conversationTendency:true,confidence,matchLineage:candidates[0]?.ref || null}));
  await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  const original=[...f.tables.values()].find(item=>item.status==='active');
  const key=TABLES.insights+':alice_'+original.lineageKey;
  confidence=0.99;
  f.addSource('m2',f.source.text);await f.service(identity,{action:'extract',memoryId:'m2'});
  assert.equal(f.tables.get(key).confidence,0.4);
  f.addSource('m1',f.source.text+'我详细补充了同一次经历。');await f.service(identity,{action:'extract',memoryId:'m1'});
  assert.equal(f.tables.get(key).confidence,0.4);
  assert.deepEqual((await f.service(identity,{action:'list'})).insights,[]);
});
test('tendency reassessment receives only distinct currently valid source excerpts',async()=>{
  let observed;
  const f=fixture(async(_source,candidates)=>{observed=candidates;return response({conversationTendency:true,matchLineage:candidates[0]?.ref || null});});
  await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  f.addSource('m2','今天回想画画时，我先想谈心里的感受。');await f.service(identity,{action:'extract',memoryId:'m2'});
  assert.deepEqual(observed[0].evidenceExcerpts,[f.source.text]);
  f.tables.get('memories:family_alice_m1').deletedAt='2026-09-22';
  f.addSource('m3','另一天，我想先谈读书时的踏实。');await f.service(identity,{action:'extract',memoryId:'m3'});
  assert.deepEqual(observed[0].evidenceExcerpts,['今天回想画画时，我先想谈心里的感受。']);
});
test('a user correction becomes the active tendency with its own fingerprinted evidence',async()=>{
  const f=fixture(async()=>response({conversationTendency:true}));await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  const original=[...f.tables.values()].find(item=>item.status==='active');
  const storageKey=TABLES.insights+':alice_'+original.lineageKey;
  f.tables.set(storageKey,{...f.tables.get(storageKey),lastMentionedAt:'2026-09-22T00:00:00.000Z'});
  await f.service(identity,{action:'correct',lineageKey:original.lineageKey,text:'我更愿意从自己的感受讲起。'});
  const updated=(await f.service(identity,{action:'list'})).insights[0];
  assert.equal(updated.origin,'user_corrected');
  assert.equal(updated.text,'我更愿意从自己的感受讲起。');
  assert.ok(updated.evidence.some(item=>item.label==='你的纠正' && item.excerpt===updated.text));
  f.tables.get('memories:family_alice_m1').deletedAt='now';
  const context=await prepareContext(f.repo,identity);
  assert.equal(context.promptContext[0].text,updated.text);
  assert.equal(context.selected[0].evidenceIds.length,1);
  assert.equal(context.selected[0].evidenceIds[0],f.tables.get(storageKey).correctionEvidenceId);
  await commitContext(f.repo,identity,context);
});
test('model statement type cannot expose a tendency inferred from only one telling',async()=>{
  const f=fixture(async()=>response({conversationTendency:true,text:'更愿意从自己的感受讲起。'}));
  await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  assert.deepEqual((await f.service(identity,{action:'list'})).insights,[]);
  assert.deepEqual((await prepareContext(f.repo,identity)).selected,[]);
});
test('copying the same telling to different records cannot create three independent sources',async()=>{
  const f=fixture(async(_source,candidates)=>response({conversationTendency:true,matchLineage:candidates[0]?.ref || null}));
  await f.enable();
  for (const memoryId of ['m1','m2','m3']) {
    if(memoryId!=='m1')f.addSource(memoryId,f.source.text);
    await f.service(identity,{action:'extract',memoryId});
  }
  assert.deepEqual((await f.service(identity,{action:'list'})).insights,[]);
  assert.deepEqual((await prepareContext(f.repo,identity)).selected,[]);
});
test('later reinforcement preserves the user correction and pins its evidence across many tellings',async()=>{
  const f=fixture(async(_source,candidates)=>response({conversationTendency:true,matchLineage:candidates[0]?.ref || null}));
  await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  const original=[...f.tables.values()].find(item=>item.status==='active');
  const correction='我更愿意从物件与场景讲起。';
  await f.service(identity,{action:'correct',lineageKey:original.lineageKey,text:correction});
  for(let index=2;index<=22;index++){
    f.addSource('m'+index,'第'+index+'次讲述里，我记下了旧茶杯上的花纹。');
    await f.service(identity,{action:'extract',memoryId:'m'+index});
  }
  const current=f.tables.get(TABLES.insights+':alice_'+original.lineageKey);
  assert.equal(current.correctionText,correction);assert.equal(current.origin,'user_corrected');
  assert.equal(current.evidenceIds.length,20);assert.ok(current.evidenceIds.includes(current.correctionEvidenceId));
  const context=await prepareContext(f.repo,identity);
  assert.equal(context.promptContext[0].text,correction);await commitContext(f.repo,identity,context);
});
test('invalid correction fingerprints cannot use later matching stories as a substitute source',async()=>{
  for(const target of ['insight','evidence']){
    const f=fixture(async(_source,candidates)=>response({matchLineage:candidates[0]?.ref || null}));
    await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
    const original=(await f.service(identity,{action:'list'})).insights[0];
    await f.service(identity,{action:'correct',lineageKey:original.lineageKey,text:'更喜欢在家读书。'});
    f.addSource('m2','周末我喜欢在家读书。');await f.service(identity,{action:'extract',memoryId:'m2'});
    const current=f.tables.get(TABLES.insights+':alice_'+original.lineageKey);
    if(target==='insight')current.correctionText='被改写的来源';
    else f.tables.get(TABLES.evidence+':'+current.correctionEvidenceId).correctionText='被改写的来源';
    assert.deepEqual((await f.service(identity,{action:'list'})).insights,[]);
    assert.deepEqual((await prepareContext(f.repo,identity)).selected,[]);
  }
});
test('a correction source changed during generation prevents releasing the prepared context',async()=>{
  const f=fixture();await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  const original=(await f.service(identity,{action:'list'})).insights[0];
  await f.service(identity,{action:'correct',lineageKey:original.lineageKey,text:'更喜欢在家读书。'});
  const context=await prepareContext(f.repo,identity);
  const current=f.tables.get(TABLES.insights+':alice_'+original.lineageKey);
  f.tables.get(TABLES.evidence+':'+current.correctionEvidenceId).correctionText='生成时被改变的纠正';
  await assert.rejects(commitContext(f.repo,identity,context),/PERSONAL_MEMORY_CHANGED/);
});
test('a superseded tendency starts again with its own evidence and never inherits earlier support',async()=>{
  let opposite=false,observedCount;
  const f=fixture(async(_source,candidates)=>{
    observedCount=candidates[0]?.distinctSourceCount;
    return response({conversationTendency:true,matchLineage:candidates[0]?.ref || null,isContradiction:opposite,
      text:opposite?'更愿意从身边的人讲起。':'更愿意从自己的感受讲起。'});
  });
  await f.enable();
  for(const [memoryId,text] of [['m1',''],['m2','我想说说心里的踏实。'],['m3','这次我感到有些轻松。']]){
    if(memoryId!=='m1')f.addSource(memoryId,text);await f.service(identity,{action:'extract',memoryId});
  }
  assert.equal((await f.service(identity,{action:'list'})).insights.length,1);
  opposite=true;f.addSource('m4','我更想聊聊刚才和老朋友的相处。');await f.service(identity,{action:'extract',memoryId:'m4'});
  assert.deepEqual((await f.service(identity,{action:'list'})).insights,[]);
  assert.deepEqual((await prepareContext(f.repo,identity)).selected,[]);
  opposite=false;f.addSource('m5','想到朋友我就想起我们一起散步。');await f.service(identity,{action:'extract',memoryId:'m5'});
  assert.equal(observedCount,1);
});
test('a single inferred contradiction cannot overwrite an explicitly corrected tendency',async()=>{
  let opposite=false;
  const f=fixture(async(_source,candidates)=>response({conversationTendency:true,matchLineage:candidates[0]?.ref || null,
    isContradiction:opposite,text:opposite?'更愿意从身边的人讲起。':'更愿意从自己的感受讲起。'}));
  await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  const original=[...f.tables.values()].find(item=>item.status==='active');
  await f.service(identity,{action:'correct',lineageKey:original.lineageKey,text:'更愿意从物件与场景讲起。'});
  opposite=true;f.addSource('m2','和朋友出门时我也聊过他的变化。');await f.service(identity,{action:'extract',memoryId:'m2'});
  assert.equal((await prepareContext(f.repo,identity)).promptContext[0].text,'更愿意从物件与场景讲起。');
});
test('a missed candidate match neither raises confidence nor resurrects a corrected text',async()=>{
  let confidence=0.6;
  const f=fixture(async()=>response({conversationTendency:true,confidence}));
  await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  const original=[...f.tables.values()].find(item=>item.status==='active');
  confidence=0.99;f.addSource('m2','另外一天，我安静地翻了几页书。');await f.service(identity,{action:'extract',memoryId:'m2'});
  const key=TABLES.insights+':alice_'+original.lineageKey;
  assert.equal(f.tables.get(key).confidence,0.6);
  await f.service(identity,{action:'correct',lineageKey:original.lineageKey,text:'我更愿意从身边的人讲起。'});
  f.addSource('m3','今天我又读了一会儿书。');await f.service(identity,{action:'extract',memoryId:'m3'});
  assert.equal(f.tables.get(key).text,'我更愿意从身边的人讲起。');
});
test('reclassifying a regular preference as a tendency starts with new evidence',async()=>{
  let tendency=false;
  const f=fixture(async(_source,candidates)=>response({matchLineage:candidates[0]?.ref || null,conversationTendency:tendency,
    text:tendency?'更愿意从自己的感受讲起。':'喜欢在安静的地方阅读。'}));
  await f.enable();
  for(const memoryId of ['m1','m2','m3']){
    if(memoryId!=='m1')f.addSource(memoryId,memoryId+'：这天又安静地读了几页书。');
    await f.service(identity,{action:'extract',memoryId});
  }
  assert.equal((await f.service(identity,{action:'list'})).insights.length,1);
  tendency=true;f.addSource('m4','我想先讲这次心里的踏实感。');await f.service(identity,{action:'extract',memoryId:'m4'});
  const stored=[...f.tables.values()].find(item=>item.status==='active');
  assert.equal(stored.text,'更愿意从自己的感受讲起。');assert.equal(stored.origin,'inferred');
  assert.deepEqual(stored.evidenceIds,['e-m4']);
  assert.deepEqual((await f.service(identity,{action:'list'})).insights,[]);
  assert.deepEqual((await prepareContext(f.repo,identity)).selected,[]);
});
test('a blank correction disables the old tendency and suppresses the same source evidence',async()=>{
  const f=fixture();await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  const original=(await f.service(identity,{action:'list'})).insights[0];
  await f.service(identity,{action:'correct',lineageKey:original.lineageKey,text:''});
  assert.deepEqual((await f.service(identity,{action:'list'})).insights,[]);
  assert.equal((await f.service(identity,{action:'extract',memoryId:'m1'})).status,'suppressed');
});
test('context retains origin, tracks cooldown on success, and cannot be released after forgetting',async()=>{
  const f=fixture();await f.enable();await f.service(identity,{action:'extract',memoryId:'m1'});
  const first=await prepareContext(f.repo,identity,{nowMs:Date.parse('2026-09-22')});
  assert.equal(first.promptContext[0].origin,'user_stated');
  assert.match(formatContext(first.promptContext),/conversationTendency=true/);
  assert.match(formatContext(first.promptContext),/贴着用户最新一句话/);
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
  f.addSource('m2','现在我喜欢和朋友一起读书。');
  await f.service(identity,{action:'extract',memoryId:'m2'});
  const updated=(await f.service(identity,{action:'list'})).insights[0];
  assert.equal(updated.lineageKey,first.lineageKey);assert.equal(updated.origin,'user_corrected');
  await f.service(identity,{action:'forget',lineageKey:first.lineageKey});
  const tombstone=f.tables.get(TABLES.suppressions+':alice_'+first.lineageKey);
  assert.deepEqual(tombstone.evidenceIds.sort(),['e-m2','e1']);
});
