const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {accountDocumentIdFor}=require('../cloudfunctions/personalMemory/aiGuard');
const memoryCloud=require('../cloudfunctions/personalMemory');
const chatCloud=require('../cloudfunctions/chatInterview');
const organizeCloud=require('../cloudfunctions/organizeMemory');
function fixture() {
  const records=new Map();let openid='alice-openid';
  const ids={alice:'account_aaaaaaaaaaaaaaaaaaaaaaaa',bob:'account_bbbbbbbbbbbbbbbbbbbbbbbb'};
  for(const name of ['alice','bob']) {
    records.set('user_accounts:'+accountDocumentIdFor(name+'-openid'),{status:'active',wxOpenId:name+'-openid',accountId:ids[name],primaryFamilyId:'family_'+name,aiConsent:{version:1}});
    records.set('families:family_'+name,{ownerAccountId:ids[name]});
    records.set('family_members:family_'+name+'_owner',{familyId:'family_'+name,memberId:'owner',role:'owner',relation:'自己'});
  }
  records.set('memories:family_alice_m1',{familyId:'family_alice',frontendContributionId:'m1',authorMemberId:'owner',scope:'personal',text:'我喜欢安静地阅读。',createdAt:'2026-09-01'});
  records.set('memories:family_alice_m2',{familyId:'family_alice',frontendContributionId:'m2',authorMemberId:'owner',scope:'personal',text:'今天我走进了一家书店。',createdAt:'2026-09-22'});
  records.set('memories:family_alice_family',{familyId:'family_alice',frontendContributionId:'family',authorMemberId:'owner',scope:'family',text:'不能从家庭投稿学习'});
  const db={collection(name){return {
    doc(id){return {async get(){const value=records.get(name+':'+id);if(!value)throw new Error('document.get:fail document with _id '+id+' does not exist');return {data:structuredClone({_id:id,...value})};},
      async set({data}){assert.equal(data._id,undefined);records.set(name+':'+id,structuredClone(data));},async update({data}){records.set(name+':'+id,{...records.get(name+':'+id),...data});}};},
    where(filter){let offset=0,count=100;const q={orderBy(){return q;},skip(n){offset=n;return q;},limit(n){count=n;return q;},async get(){return {data:[...records].filter(([k,v])=>k.startsWith(name+':')&&Object.entries(filter).every(([key,value])=>v[key]===value)).map(([k,v])=>structuredClone({_id:k.slice(name.length+1),...v})).slice(offset,offset+count)};}};return q;},
  };},async runTransaction(fn){const before=structuredClone(records);try{return await fn(db);}catch(e){records.clear();for(const[k,v]of before)records.set(k,v);throw e;}}};
  const cloud={init(){},database:()=>db,getWXContext:()=>({OPENID:openid,APPID:'wxmemorytest'}),openapi:{security:{msgSecCheck:async()=>({result:{suggest:'pass'}})}}};
  const extract=async()=>({statementType:'direct_statement',insights:[{matchLineage:null,isContradiction:false,category:'preference',conversationTendency:false,text:'喜欢安静地阅读。',projectScoped:false,confidence:0.8,sensitive:false}]});
  return {records,db,cloud,extract,as(name){openid=name+'-openid';},async learn(){await memoryCloud.main({action:'configure',enabled:true,consentVersion:1},{cloud,extract});await memoryCloud.main({action:'extract',memoryId:'m1'},{cloud,extract});}};
}
function env(context) {
  const values={WECHAT_APP_ID:'wxmemorytest',AI_SERVER_RELEASE_READY:'true',PERSONAL_MEMORY_ENABLED:'true',CHAT_AI_BASE_URL:'https://tokenhub.tencentmaas.com/v1',CHAT_AI_API_KEY:'test-not-real',CHAT_AI_MODEL:'test-model',ORGANIZE_AI_BASE_URL:'https://tokenhub.tencentmaas.com/v1',ORGANIZE_AI_API_KEY:'test-not-real',ORGANIZE_AI_MODEL:'test-model'};
  const old={...process.env};Object.assign(process.env,values);
  context.after(()=>{for(const key of Object.keys(values)){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}});
}
test('first visit defaults to disabled when CloudBase reports the control document does not exist',async context=>{
  env(context);const f=fixture();
  assert.deepEqual(await memoryCloud.main({action:'list'},{cloud:f.cloud}),{enabled:false,insights:[]});
  assert.equal([...f.records.keys()].some(key=>key.startsWith('personal_memory_controls:')),false);
});
test('repository does not treat permission, network, or missing collection errors as absent documents',async()=>{
  const {createRepository}=require('../cloudfunctions/personalMemory/personalMemoryRepository');
  for(const message of ['document.get:fail permission denied','document.get:fail network timeout','collection personal_memory_controls does not exist']) {
    const failure=new Error(message);
    const repo=createRepository({collection(){return {doc(){return {async get(){throw failure;}};}};}});
    await assert.rejects(repo.get('personal_memory_controls','test-account'),error=>error===failure);
  }
});
test('real cloud entry resolves account ownership; another account cannot extract or forget private understanding',async context=>{
  env(context);const f=fixture();await f.learn();
  const alice=await memoryCloud.main({action:'list'},{cloud:f.cloud});assert.equal(alice.insights.length,1);
  assert.equal((await memoryCloud.main({action:'extract',memoryId:'family'},{cloud:f.cloud,extract:f.extract})).status,'ineligible');
  f.as('bob');
  assert.deepEqual((await memoryCloud.main({action:'list',userId:'alice'},{cloud:f.cloud})).insights,[]);
  await assert.rejects(memoryCloud.main({action:'forget',lineageKey:alice.insights[0].lineageKey},{cloud:f.cloud}),/NOT_FOUND/);
  await assert.rejects(memoryCloud.main({action:'confirm',lineageKey:alice.insights[0].lineageKey},{cloud:f.cloud}),/NOT_FOUND/);
  await assert.rejects(memoryCloud.main({action:'correct',lineageKey:alice.insights[0].lineageKey,text:'不属于这个账号的纠正。'},{cloud:f.cloud}),/NOT_FOUND/);
  await memoryCloud.main({action:'configure',enabled:true,consentVersion:1},{cloud:f.cloud});
  assert.equal((await memoryCloud.main({action:'extract',memoryId:'m1',familyId:'family_alice'},{cloud:f.cloud,extract:f.extract})).status,'ineligible');
});
test('interview and organizer consume persisted private-account context with origin and selector version',async context=>{
  env(context);const original=global.fetch;context.after(()=>global.fetch=original);
  for(const name of ['chat','organize']) {
    const f=fixture();await f.learn();let request;
    global.fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(name==='chat'?{dimension:'event',text:'书店里哪一处让你停了下来？'}:{title:'书店',body:'今天我走进了一家书店。',summary:'逛书店',emotions:[],people:[],places:[]})}}]})};};
    const result=name==='chat'?await chatCloud.main({answer:'今天我走进了一家书店。'},{cloud:f.cloud}):await organizeCloud.main({memoryId:'m2'},{cloud:f.cloud});
    assert.equal(result.personalMemorySelectorVersion,'u6-v2');
    assert.match(request.messages[1].content,/喜欢安静地阅读/);
    assert.match(request.messages[1].content,/user_stated/);
    assert.match(request.messages[1].content,/不得补写为本次故事的事实/);
  }
});
test('deleted evidence does not enter later prompts; malformed AI history never becomes original speech',async context=>{
  env(context);const f=fixture();await f.learn();
  const {createRepository}=require('../cloudfunctions/personalMemory/personalMemoryRepository');
  const {prepareContext}=require('../cloudfunctions/personalMemory/personalMemoryContext');
  const {resolveActiveIdentity}=require('../cloudfunctions/personalMemory/aiGuard');
  const identity=await resolveActiveIdentity(f.db,f.cloud.getWXContext());
  f.records.get('memories:family_alice_m1').deletedAt='now';
  assert.deepEqual((await prepareContext(createRepository(f.db),identity)).promptContext,[]);
  const source=f.records.get('memories:family_alice_m2');source.aiRevisions=[{kind:'ai',text:'模型猜测'}];
  assert.equal((await memoryCloud.main({action:'extract',memoryId:'m2'},{cloud:f.cloud,extract:f.extract})).status,'ineligible');
});
test('all three tendency angles reach the interview prompt and correction or forgetting changes the next request',async context=>{
  env(context);const originalFetch=global.fetch;context.after(()=>global.fetch=originalFetch);
  const angles=['更愿意从身边的人讲起。','更愿意从自己的感受讲起。','更愿意从物件与场景讲起。'];
  for(const angle of angles){
    const f=fixture();let request;
    const extract=async(_source,candidates)=>({statementType:'direct_statement',insights:[{matchLineage:candidates[0]?.ref || null,
      isContradiction:false,category:'preference',conversationTendency:true,text:angle,projectScoped:false,confidence:0.8,sensitive:false}]});
    f.records.set('memories:family_alice_m3',{familyId:'family_alice',frontendContributionId:'m3',authorMemberId:'owner',scope:'personal',text:'我把旧茶杯重新放到窗边。',createdAt:'2026-09-23'});
    await memoryCloud.main({action:'configure',enabled:true,consentVersion:1},{cloud:f.cloud});
    for(const memoryId of ['m1','m2','m3'])await memoryCloud.main({action:'extract',memoryId},{cloud:f.cloud,extract});
    const insight=(await memoryCloud.main({action:'list'},{cloud:f.cloud})).insights[0];
    assert.equal(insight.evidence.length,3);
    global.fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({dimension:'feeling',text:'这句话中的哪个意思最贴近你？'})}}]})};};
    const ask=step=>chatCloud.main({answer:'越是迷茫的时候，越是要往远处看。'},{cloud:f.cloud,nowMs:Date.now()+step*3000});
    await ask(1);assert.ok(request.messages[1].content.includes(angle));assert.match(request.messages[1].content,/"conversationTendency":true/);
    const correction='我更想自己选择这一次从哪里讲起。';
    await memoryCloud.main({action:'correct',lineageKey:insight.lineageKey,text:correction},{cloud:f.cloud});
    await ask(2);assert.ok(request.messages[1].content.includes(correction));assert.ok(!request.messages[1].content.includes(angle));
    await memoryCloud.main({action:'forget',lineageKey:insight.lineageKey},{cloud:f.cloud});
    await ask(3);assert.ok(!request.messages[1].content.includes(correction));assert.ok(!request.messages[1].content.includes(angle));
  }
});
test('independent cloud bundles stay in sync and all personal collections deny direct client access',()=>{
  for(const name of ['personalMemoryCore.js','personalMemoryRepository.js','personalMemoryContext.js']) for(const target of ['chatInterview','organizeMemory']) assert.equal(fs.readFileSync('cloudfunctions/'+target+'/'+name,'utf8'),fs.readFileSync('cloudfunctions/personalMemory/'+name,'utf8'));
  const rules=JSON.parse(fs.readFileSync('deploy/personal-memory/database.rules.json','utf8'));
  for(const value of Object.values(rules.collections))assert.deepEqual(value,{read:false,write:false});
});


test('writing preferences persist across requests, isolate accounts, reject stale updates and can be cleared',async context=>{
  env(context); const f=fixture();
  const call=(data)=>chatCloud.main({action:'writingPreferences',...data},{cloud:f.cloud});
  assert.deepEqual(await call({operation:'get'}),{text:'',revision:0});
  await call({operation:'save',text:'一次只问一个问题，先给例子。',revision:0});
  assert.equal((await call({operation:'get'})).text,'一次只问一个问题，先给例子。');
  await assert.rejects(call({operation:'save',text:'stale',revision:0}),/CHANGED/);
  await assert.rejects(call({operation:'save',text:'x'.repeat(501),revision:1}),/INVALID/);
  f.as('bob');assert.deepEqual(await call({operation:'get',accountId:'account_aaaaaaaaaaaaaaaaaaaaaaaa'}),{text:'',revision:0});
  f.as('alice');await call({operation:'save',text:'',revision:1});
  assert.deepEqual(await call({operation:'get'}),{text:'',revision:2});
});
test('explicit writing preferences affect the next source-only conversation and compose without learning source characters',async context=>{
  env(context);const f=fixture();const old=global.fetch;context.after(()=>global.fetch=old);
  await chatCloud.main({action:'writingPreferences',operation:'save',text:'先给一个朴素的开头。',revision:0},{cloud:f.cloud});
  let request;
  global.fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({dimension:'event',text:'可以从读文章的感受开始。'})}}]})};};
  await chatCloud.main({answer:'这是一篇文章，我不知道怎么写。',sourceOnly:true,sourceText:'书中作者的回忆'},{cloud:f.cloud,nowMs:Date.now()});
  assert.match(request.messages[1].content,/先给一个朴素的开头/);
  global.fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({title:'书店',body:'今天我走进了一家书店。',summary:'书店',emotions:[],people:[],places:[]})}}]})};};
  await organizeCloud.main({memoryId:'m2',writingMode:'compose'},{cloud:f.cloud,nowMs:Date.now()+10000});
  assert.match(request.messages[1].content,/先给一个朴素的开头/);
});
test('clearing a writing preference during a model request prevents releasing the stale personalized response',async context=>{
  env(context);const f=fixture();const old=global.fetch;context.after(()=>global.fetch=old);
  await chatCloud.main({action:'writingPreferences',operation:'save',text:'先给例子',revision:0},{cloud:f.cloud});
  global.fetch=async()=>{
    await chatCloud.main({action:'writingPreferences',operation:'save',text:'',revision:1},{cloud:f.cloud});
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({dimension:'event',text:'旧偏好的回应'})}}]})};
  };
  await assert.rejects(chatCloud.main({answer:'怎么写',sourceOnly:true},{cloud:f.cloud}),/WRITING_PREFERENCES_CHANGED/);
});
test('search cloud entry enforces explicit search consent and identity before calling the provider',async context=>{
  env(context);const f=fixture();let calls=0;const old=global.fetch;context.after(()=>global.fetch=old);
  global.fetch=async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:'资料[1]',search_results:[{index:1,url:'https://example.org',name:'资料'}]}}]})};};
  await assert.rejects(chatCloud.main({action:'writingSearch',query:'河北满城'},{cloud:f.cloud}),/CONSENT_REQUIRED/);
  assert.equal(calls,0);
  const value=await chatCloud.main({action:'writingSearch',query:'河北满城',searchConsent:true,sourceText:'private text'},{cloud:f.cloud});
  assert.equal(value.sources.length,1);assert.equal(calls,1);
  f.records.get('user_accounts:'+accountDocumentIdFor('alice-openid')).status='deleted';
  await assert.rejects(chatCloud.main({action:'writingPreferences',operation:'get'},{cloud:f.cloud}),error=>error.code==='IDENTITY_UNLINKED');
  await assert.rejects(chatCloud.main({action:'writingSearch',query:'满城',searchConsent:true},{cloud:f.cloud}),error=>error.code==='IDENTITY_UNLINKED');
  assert.equal(calls,1);
});


test('成文模型接收五页云端OCR而非客户端照片概述，并核对材料回执',async context=>{
  env(context);const f=fixture(),old=global.fetch;context.after(()=>global.fetch=old);
  const {captureIdOf}=require('../cloudfunctions/organizeMemory/memoryMaterialReading');
  const ids=[1,2,3,4,5].map(n=>'photo-page-'+n),memory=f.records.get('memories:family_alice_m2');
  memory._openid='alice-openid';memory.photoIds=ids;memory.text='还没想好怎么写';
  const captureId=captureIdOf('m2',ids);
  for(const id of ids)f.records.set('photos:family_alice__'+id,{familyId:'family_alice',_openid:'alice-openid'});
  const row={accountId:'account_aaaaaaaaaaaaaaaaaaaaaaaa',familyId:'family_alice',memoryId:'m2',evidence:ids.map((id,i)=>({sourceId:id,kind:'image-reading',text:`【可见文字】第${i+1}页，1945年9月18日满城解放。\n【画面内容】一本打开的书。`}))};
  f.records.set('material_captures:'+row.accountId+'_'+captureId,row);
  let request;
  global.fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({title:'街道与往事',body:'读到满城解放的记述，我想记住这些往事。',summary:'读书感想',emotions:[],people:[],places:[]})}}]})};};
  const result=await organizeCloud.main({memoryId:'m2',materialSourceId:'m2',sourceOnly:true,expectedText:memory.text,transcript:[memory.text],writingMode:'compose'},{cloud:f.cloud});
  assert.equal(result.materialReadingApplied,true);
  for(let i=1;i<=5;i++)assert.match(request.messages[1].content,new RegExp('第'+i+'页'));
  assert.doesNotMatch(request.messages[1].content,/一本打开的书/);
  assert.match(request.messages[0].content,/材料作者/);
  assert.match(request.messages[0].content,/300字以内.*不必概括每一页.*包含标点和换行/);
  row.evidence.pop();let calls=0;global.fetch=async()=>{calls++;throw new Error('must not reach provider');};
  await assert.rejects(organizeCloud.main({memoryId:'m2',materialSourceId:'m2',writingMode:'compose'},{cloud:f.cloud,nowMs:Date.now()+10000}),/尚未读完/);
  assert.equal(calls,0);
});

function sessionSnapshot(overrides={}) {return {messages:[{id:'msg-1',kind:'opening',text:'为什么留下这篇文章？',label:''},{id:'msg-2',kind:'answer',text:'值得传承。',label:''}],answers:['值得传承。'],askedDimensions:['feeling'],inputText:'还没发出的想法',draftTitle:'街道',draftText:'那些牺牲值得记住。',draftSummary:'读后感',draftOrganizationMode:'cloud-ai',outputMemoryId:'m2',saved:true,...overrides};}
function sessionFixture(context) {
  env(context);const f=fixture();for(const id of ['m1','m2'])f.records.get('memories:family_alice_'+id)._openid='alice-openid';
  f.call=(data={})=>chatCloud.main({action:'writingSession',memoryId:'m1',expectedFamilyId:'family_alice',operation:'get',...data},{cloud:f.cloud});return f;
}
test('writing session roundtrips complete dialogue, unsent text and draft from source and output memory',async context=>{
  const f=sessionFixture(context);delete process.env.CHAT_AI_API_KEY;
  assert.equal((await f.call()).snapshot,null);
  const snapshot=sessionSnapshot({draftAiText:'原生成文',draftAiTitle:'原标题'});await f.call({operation:'save',revision:0,mutationId:'turn-1',snapshot});
  for(const memoryId of ['m1','m2']) {const result=await f.call({memoryId});assert.equal(result.memoryId,'m1');assert.deepEqual(result.snapshot,{...snapshot,messages:snapshot.messages.map(m=>({...m,sources:[]}))});}
});
test('session retries are idempotent and stale writers cannot overwrite another device',async context=>{
  const f=sessionFixture(context),request={operation:'save',revision:0,mutationId:'turn-1',snapshot:sessionSnapshot()};
  assert.equal((await f.call(request)).revision,1);assert.equal((await f.call(request)).revision,1);
  await assert.rejects(f.call({...request,mutationId:'turn-2'}),/CONFLICT/);
  assert.equal((await f.call()).snapshot.inputText,'还没发出的想法');
});
test('sessions reject another account, switched scope, deleted source, family memories and unowned output',async context=>{
  const f=sessionFixture(context);
  await assert.rejects(f.call({expectedFamilyId:'family_bob'}),/SCOPE_CHANGED/);
  await assert.rejects(f.call({memoryId:'family'}),/MEMORY_UNAVAILABLE/);
  f.records.get('memories:family_alice_m2')._openid='bob-openid';
  await assert.rejects(f.call({operation:'save',revision:0,mutationId:'x',snapshot:sessionSnapshot()}),/MEMORY_UNAVAILABLE/);
  f.records.get('memories:family_alice_m1').deletedAt='today';await assert.rejects(f.call(),/MEMORY_UNAVAILABLE/);
  f.as('bob');await assert.rejects(f.call({expectedFamilyId:'family_bob'}),/MEMORY_UNAVAILABLE/);
});
test('session transaction rechecks revoked identity before any write',async context=>{
  const f=sessionFixture(context),transaction=f.db.runTransaction;
  f.db.runTransaction=fn=>{f.records.get('user_accounts:'+accountDocumentIdFor('alice-openid')).status='disabled';return transaction(fn);};
  await assert.rejects(f.call({operation:'save',revision:0,mutationId:'x',snapshot:sessionSnapshot()}),error=>error.code==='IDENTITY_REVOKED');
  assert.equal([...f.records.keys()].some(k=>k.startsWith('writing_sessions:')),false);
});
test('session storage bounds malformed payloads without silently truncating dialogue',async context=>{
  const f=sessionFixture(context);
  for(const snapshot of [sessionSnapshot({messages:Array(201).fill({})}),sessionSnapshot({draftText:'字'.repeat(10001)}),sessionSnapshot({messages:[{id:'x',kind:'system',text:'bad'}]})]) {
    await assert.rejects(f.call({operation:'save',revision:0,mutationId:'x',snapshot}),/WRITING_SESSION_(INVALID|TOO_LARGE)/);
  }
});
test('session read propagates storage outage instead of inventing an empty conversation',async context=>{
  const f=sessionFixture(context),collection=f.db.collection;
  f.db.collection=name=>name==='writing_sessions'?{doc(){return {get:async()=>{throw new Error('collection writing_sessions does not exist');}};}}:collection(name);
  await assert.rejects(f.call(),/collection writing_sessions/);
});
