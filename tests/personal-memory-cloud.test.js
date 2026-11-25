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
  const result=await organizeCloud.main({memoryId:'m2',materialSourceId:'m2',sourceOnly:true,expectedText:memory.text,transcript:[memory.text],writingMode:'compose',writingInstruction:'写给孩子看的读后感，重点是传承。'},{cloud:f.cloud});
  assert.equal(result.materialReadingApplied,true);
  for(let i=1;i<=5;i++)assert.match(request.messages[1].content,new RegExp('第'+i+'页'));
  assert.doesNotMatch(request.messages[1].content,/一本打开的书/);
  assert.match(request.messages[0].content,/材料作者/);
  assert.match(request.messages[0].content,/instruction.*文章类型、读者、主题和语气/);
  assert.match(request.messages[0].content,/不能仅凭表达目的替用户选择体裁.*不必概括每一页.*包含标点和换行/);
  assert.match(request.messages[1].content,/写给孩子看的读后感，重点是传承/);
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


test('article guidance reads the whole dialogue and returns one clarification without treating it as a draft',async context=>{
 env(context);const f=fixture(),old=global.fetch;context.after(()=>global.fetch=old);
 const memory=f.records.get('memories:family_alice_m2');memory._openid='alice-openid';
 let request;let response={clarification:'你想介绍这家书店，还是写进门时的感受？'};
 global.fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(response)}}]})};};
 const conversation=[{role:'user',content:'最初的关切不能被最后十轮截掉'},...Array.from({length:12},(_,i)=>({role:'assistant',content:'交流'+i}))];
 const event={memoryId:'m2',sourceOnly:true,expectedText:memory.text,transcript:[memory.text],writingMode:'compose',articleGuidance:true,conversation};
 const question=await organizeCloud.main(event,{cloud:f.cloud});
 assert.equal(question.body,'');assert.equal(question.clarification,response.clarification);
 assert.match(request.messages[1].content,/最初的关切不能被最后十轮截掉/);
 assert.match(request.messages[0].content,/前因、经过、结果/);assert.match(request.messages[0].content,/希望写成什么样/);assert.match(request.messages[0].content,/必须仅返回 clarification/);assert.doesNotMatch(request.messages[0].content,/未指定体裁时从已知目的选择合适的写法/);assert.match(request.messages[0].content,/不能代替用户选择文章写法/);assert.match(request.messages[0].content,/不要把助手自己建议过的写法当作用户已选择/);assert.match(request.messages[0].content,/已经问过并得到回答的内容不得再问/);
 assert.match(request.messages[0].content,/交代为何发生和结果/);assert.match(request.messages[0].content,/不声称/);
 await assert.rejects(organizeCloud.main({...event,sourceOnly:false},{cloud:f.cloud,nowMs:Date.now()+5000}),/INVALID_ARTICLE_GUIDANCE_MODE/);
 event.conversation.push({role:'assistant',content:'[写作方向] '+response.clarification},{role:'user',content:'写读书时的感受'});
 await assert.rejects(organizeCloud.main(event,{cloud:f.cloud,nowMs:Date.now()+10000}),/EMPTY_MODEL_OUTPUT/);
 response={title:'书店',body:'我走进书店，想把这一刻的感受留下。'};
 const article=await organizeCloud.main(event,{cloud:f.cloud,nowMs:Date.now()+20000});
 assert.equal(article.body,response.body);assert.equal(article.clarification,undefined);
 assert.match(request.messages[0].content,/本轮直接返回文章 JSON/);
});


test('legacy writing form setting survives session storage without a fake conversation turn',()=>{
 const {snapshot}=require('../cloudfunctions/chatInterview/writingSession');
 const result=snapshot(sessionSnapshot({writingInstruction:'写给孩子看，朴素一点'}));
 assert.equal(result.writingInstruction,'写给孩子看，朴素一点');assert.equal(result.messages.length,2);
 assert.throws(()=>snapshot(sessionSnapshot({writingInstruction:'字'.repeat(301)})),/WRITING_SESSION_INVALID/);
});

test('writing session preserves the generated shelf story and acknowledged revision across reopen',async context=>{
 const f=sessionFixture(context);
 await f.call({operation:'save',revision:0,mutationId:'story-link-1',snapshot:sessionSnapshot({outputStoryId:'story-generated',outputStoryRevisionId:'revision-generated'})});
 const result=await f.call();assert.equal(result.snapshot.outputStoryId,'story-generated');assert.equal(result.snapshot.outputStoryRevisionId,'revision-generated');
});


test('article turns claim once, recover the same reply and reject changed payloads or revoked accounts',async context=>{
 env(context);const f=fixture();let tail=Promise.resolve();
 f.db.runTransaction=fn=>{const result=tail.then(()=>fn(f.db));tail=result.catch(()=>{});return result;};
 const old=global.fetch;context.after(()=>global.fetch=old);let calls=0,finish;
 global.fetch=async()=>{calls++;return new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({dimension:'event',text:'已有材料足够，可以从纸船出发写。'})}}]})});});};
 const event={action:'articleTurn',turnId:'article-fictional-123',input:{answer:'请直接写一个开头',sourceText:'【虚构】蓝纸船与黄色灯塔',scope:'chapter:module',storyTitle:'纸船',conversation:[]}};
 const first=chatCloud.main(event,{cloud:f.cloud});
 while(!finish)await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(await chatCloud.main(event,{cloud:f.cloud}),{turnId:event.turnId,status:'sending'});assert.equal(calls,1);
 finish();const result=await first;assert.equal(result.status,'ready');
 assert.deepEqual(await chatCloud.main(event,{cloud:f.cloud}),result);assert.equal(calls,1);
 await assert.rejects(chatCloud.main({...event,input:{...event.input,sourceText:'改过的稿'}},{cloud:f.cloud}),/ARTICLE_TURN_CONFLICT/);
 f.records.get('user_accounts:'+accountDocumentIdFor('alice-openid')).status='disabled';
 await assert.rejects(chatCloud.main(event,{cloud:f.cloud}),/账号|IDENTITY/);assert.equal(calls,1);
});
test('article turns do not retry empty model output or reuse another account receipt',async context=>{
 env(context);const f=fixture();const old=global.fetch;context.after(()=>global.fetch=old);let calls=0;
 global.fetch=async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:''}}]})};};
 const event={action:'articleTurn',turnId:'article-fictional-fail',input:{answer:'写一下',sourceText:'虚构纸船',scope:'same',storyTitle:'',conversation:[]}};
 await assert.rejects(chatCloud.main(event,{cloud:f.cloud}),/EMPTY_MODEL_OUTPUT/);assert.equal(calls,1);
 assert.equal((await chatCloud.main(event,{cloud:f.cloud})).status,'failed');assert.equal(calls,1);
 f.as('bob');await assert.rejects(chatCloud.main(event,{cloud:f.cloud}),/EMPTY_MODEL_OUTPUT/);assert.equal(calls,2);
});

test('article writing sends the whole manuscript with version and returns only an exact, editable range', async context => {
  env(context);
  const f = fixture();
  const first = '在车站接我那天，下着细雨。爸爸把手里的伞又往我这边挪了一点。';
  const last = '后来又路过车站，那天也下着细雨。';
  const wechat = '爸，今天你把伞往我这边挪，我看见啦。';
  const lines = [first, ...Array.from({length:100}, (_, i) => `第${i + 1}段。窗外在下雨，街道和橱窗亮着灯。`.repeat(4)), last, wechat];
  const sourceText = lines.join('\n');
  let offset = 0;
  const paragraphs = lines.map((value, index) => {
    const p = {start:offset, end:offset + value.length, editable:index !== lines.length - 1, selected:false};
    offset += value.length + 1;
    return p;
  });
  const articleWriting = {chapterId:'umbrella', title:'车站的两把伞', revisionId:'rev-8', version:8, paragraphs};
  const event = {action:'articleTurn', turnId:'article-long-front', input:{sourceText, articleWriting, storyTitle:'两把伞', scope:'full',
    answer:'前面写车站的那段，收短一点', conversation:[{role:'user',text:'书稿语气朴素一点。'}]}};
  const calls = [];
  const responses = [
    {kind:'edit', text:'把开头这段收短了一点。', target:0, original:first, replacement:'那天下雨，爸爸到车站接我，把伞又往我这里挪了一点。'},
    {kind:'edit', text:'我改了结尾。', target:lines.length-2, original:last, replacement:'后来我又去了车站。'},
    {kind:'clarify',text:'你想改哪一段？',targets:[0, lines.length-2]},
    {kind:'edit',text:'我换了微信里的说法。',target:lines.length-1,original:wechat,replacement:'爸，谢谢你。'},
    {kind:'edit',text:'缩短',target:0,original:'并不存在的文字',replacement:'改好了。'},
  ];
  const oldFetch = global.fetch;
  context.after(() => {global.fetch = oldFetch;});
  global.fetch = async (_url, options) => {
    calls.push(JSON.parse(JSON.parse(options.body).messages[1].content));
    const content = JSON.stringify(responses[calls.length - 1]);
    return {ok:true,json:async () => ({choices:[{message:{content}}]})};
  };
  const call = (input, step) => chatCloud.main(input,{cloud:f.cloud,nowMs:Date.UTC(2026, 10, 25) + step * 60_000});
  const original = await call(event,0);
  assert.ok(sourceText.length > 8000);
  assert.deepEqual(original.decision,{kind:'edit',target:0,start:0,end:first.length,replacement:responses[0].replacement});
  assert.equal(calls[0].article.revisionId,'rev-8');
  assert.equal(calls[0].article.version,8);
  assert.equal(calls[0].article.paragraphs.at(-2).text,last);
  assert.equal(calls[0].article.paragraphs.at(-1).editable,false);
  assert.match(calls[0].history[0].text,/语气朴素/);
  assert.deepEqual(await call(event,0),original);
  assert.equal(calls.length,1);

  const follow = await call({...event,turnId:'article-long-follow',input:{...event.input,answer:'把刚才那段再改得口语一点',
    articleWriting:{...articleWriting,recent:{target:0,start:0,end:first.length,draft:responses[0].replacement}}}},1);
  assert.equal(calls[1].recent.draft,responses[0].replacement);
  assert.deepEqual(calls[1].required,{target:0,quote:first});
  assert.equal(follow.decision,undefined,'follow-up cannot edit the similarly worded ending');
  const unclear = await call({...event,turnId:'article-long-unclear',input:{...event.input,answer:'车站那段收短一点'}},2);
  assert.deepEqual(unclear.decision,{kind:'clarify',targets:[0,lines.length-2]});
  for (const [index,suffix] of ['alternative','missing'].entries()) {
    const result = await call({...event,turnId:'article-long-' + suffix},index + 3);
    assert.equal(result.decision,undefined,'a locked passage or an invented quote cannot produce a suggestion');
  }
});

test('article writing keeps long notes and distinguishes organization from a draft in its receipt', async context => {
  env(context);
  const f = fixture();
  const sourceText = '';
  const articleWriting = {chapterId:'scratch',title:'随手记',revisionId:'rev-1',version:1,paragraphs:[]};
  const note = '零散笔记：' + '下雨天，爸爸来车站接我。'.repeat(100)
    + '\n旧稿说他递给我一把伞。我记不清。\n给爸爸的微信（定稿）：爸，我看见啦。';
  const replies = [
    {kind:'chat',text:'我先收下这些笔记。'},
    {kind:'chat',text:'你记得下雨和车站。递伞是旧稿里不确定的细节。微信原话单独留着。'},
    {kind:'draft',label:'书稿',text:'那天下雨，爸爸来车站接我。他把伞往我这边挪了挪。'},
  ];
  const old = global.fetch;
  const calls = [];
  context.after(()=>{global.fetch=old;});
  global.fetch = async (_url, opts) => {
    const {messages} = JSON.parse(opts.body);
    calls.push(JSON.parse(messages[1].content));
    assert.match(messages[0].content,/记不清的细节只指导取舍/);
    assert.match(messages[0].content,/分类|硬套栏目/);
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(replies[calls.length - 1])}}]})};
  };
  const asks = [note,'帮我理一下','帮我把车站那天的事写出来'];
  const history = [];
  const results = [];
  for (const [index,answer] of asks.entries()) {
    const result = await chatCloud.main({action:'articleTurn',turnId:'article-long-notes-'+index,
      input:{answer,sourceText,articleWriting,scope:'scratch',storyTitle:'随手记',conversation:history}},
    {cloud:f.cloud,nowMs:Date.UTC(2026,10,25) + index * 60000});
    history.push({role:'user',text:answer},{role:'assistant',text:result.reply});
    results.push(result);
  }
  assert.ok(note.length > 500);
  assert.equal(calls[0].request,note);
  assert.equal(calls[2].history[0].text,note);
  assert.equal(results[1].decision,undefined);
  assert.deepEqual(results[2].decision,{kind:'draft',label:'书稿'});
  assert.equal(results[2].reply,replies[2].text);
});
