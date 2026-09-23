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
  const extract=async()=>({statementType:'direct_statement',insights:[{matchLineage:null,isContradiction:false,category:'preference',text:'喜欢安静地阅读。',projectScoped:false,confidence:0.8,sensitive:false}]});
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
  await memoryCloud.main({action:'configure',enabled:true,consentVersion:1},{cloud:f.cloud});
  assert.equal((await memoryCloud.main({action:'extract',memoryId:'m1',familyId:'family_alice'},{cloud:f.cloud,extract:f.extract})).status,'ineligible');
});
test('interview and organizer consume persisted private-account context with origin and selector version',async context=>{
  env(context);const original=global.fetch;context.after(()=>global.fetch=original);
  for(const name of ['chat','organize']) {
    const f=fixture();await f.learn();let request;
    global.fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(name==='chat'?{dimension:'event',text:'书店里哪一处让你停了下来？'}:{title:'书店',body:'今天我走进了一家书店。',summary:'逛书店',emotions:[],people:[],places:[]})}}]})};};
    const result=name==='chat'?await chatCloud.main({answer:'今天我走进了一家书店。'},{cloud:f.cloud}):await organizeCloud.main({memoryId:'m2'},{cloud:f.cloud});
    assert.equal(result.personalMemorySelectorVersion,'u6-v1');
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
test('independent cloud bundles stay in sync and all personal collections deny direct client access',()=>{
  for(const name of ['personalMemoryCore.js','personalMemoryRepository.js','personalMemoryContext.js']) for(const target of ['chatInterview','organizeMemory']) assert.equal(fs.readFileSync('cloudfunctions/'+target+'/'+name,'utf8'),fs.readFileSync('cloudfunctions/personalMemory/'+name,'utf8'));
  const rules=JSON.parse(fs.readFileSync('deploy/personal-memory/database.rules.json','utf8'));
  for(const value of Object.values(rules.collections))assert.deepEqual(value,{read:false,write:false});
});
