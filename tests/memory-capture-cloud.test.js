const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../cloudfunctions/organizeMemory/aiGuard');
const {createCaptureHandler,inputOf,handle} = require('../cloudfunctions/organizeMemory/materialCapture');

function fixture(){
  const state=new Map();let tail=Promise.resolve();
  function reader(map){return {collection:name=>({
    doc:id=>({get:async()=>{const data=map.get(`${name}/${id}`);if(!data)throw new Error('DOCUMENT_NOT_FOUND');return {data:structuredClone(data)};},set:async({data})=>{map.set(`${name}/${id}`,structuredClone(data));},update:async({data})=>{const old=map.get(`${name}/${id}`);if(!old)throw new Error('DOCUMENT_NOT_FOUND');map.set(`${name}/${id}`,{...old,...structuredClone(data)});}}),
    where:filter=>{let limit=100;const query={orderBy:()=>query,limit:n=>{limit=n;return query;},get:async()=>({data:[...map.entries()].filter(([key,row])=>key.startsWith(name+'/') && Object.entries(filter).every(([k,v])=>row[k]===v)).slice(0,limit).map(([,row])=>structuredClone(row))})};return query;},
  })};}
  const db={...reader(state),runTransaction:async action=>{let release;const prior=tail;tail=new Promise(resolve=>{release=resolve;});await prior;const copy=new Map(structuredClone([...state]));try{const result=await action(reader(copy));state.clear();for(const [key,value] of copy)state.set(key,value);return result;}finally{release();}}};
  const identity={accountId:'account_aaaaaaaaaaaaaaaaaaaaaaaa',familyId:'family_owner',openid:'owner',account:{aiConsent:{version:1}}};
  state.set('family_members/family_owner_owner',{familyId:identity.familyId,id:'owner',name:'测试作者',relation:'自己',role:'owner'});
  const audio=Buffer.alloc(30);audio.write('ID3');
  const cloud={getTempFileURL:async()=>({fileList:[{tempFileURL:'https://example.invalid/private-audio'}]}),downloadFile:async()=>({fileContent:audio}),uploadFile:async({cloudPath})=>({fileID:`cloud://env.bucket/${cloudPath}`})};
  return {state,db,identity,cloud,handler:createCaptureHandler({db,cloud,identity})};
}
const request=()=>({id:'capture-test-12345678',text:'虚构故事：纸船来到灯塔边。',photoIds:[],audio:[]});

test('随手记多条消息只创建一段记忆，重试不重复、显式恢复不带入旧记忆',async()=>{
  const oldModerate=guard.moderateText,oldActive=guard.assertIdentityStillActive;
  guard.moderateText=async()=>{};guard.assertIdentityStillActive=async()=>{};
  try{
    const f=fixture(),first={...request(),sessionId:request().id};
    await f.handler.receive({...request(),id:'capture-old-12345678'});
    await f.handler.receive(first);await f.handler.saveOriginal(first);
    const second={...request(),id:'capture-next-12345678',sessionId:first.id,text:'第二条：带来一张画。'};
    await Promise.all([f.handler.receive(second),f.handler.receive(second)]);
    await Promise.all([f.handler.saveOriginal(second),f.handler.saveOriginal(second)]);
    const session=await f.handler.readSession(second);
    assert.deepEqual(session.items.map(item=>item.id),[first.id,second.id]);
    assert.equal(new Set(session.items.map(item=>item.memoryId)).size,1);
    const memories=[...f.state.entries()].filter(([key])=>key.startsWith('memories/'));
    assert.equal(memories.length,1);assert.equal(memories[0][1].text,first.text+'\n\n'+second.text);
    assert.equal([...f.state.values()].find(row=>row.rawText).rawText,first.text+'\n\n'+second.text);
    await assert.rejects(f.handler.processNext(first),/先保存原件/);
  }finally{guard.moderateText=oldModerate;guard.assertIdentityStillActive=oldActive;}
});

test('随手记不能借用别人的会话，不能重绑已提交消息，不能混入旧批次',async()=>{
  const f=fixture(),first={...request(),sessionId:request().id};
  await f.handler.receive(first);
  const next={...first,id:'capture-next-12345678'};
  const stranger=createCaptureHandler({...f,identity:{...f.identity,accountId:'account_stranger'}});
  await assert.rejects(stranger.receive(next),/不存在/);
  await assert.rejects(stranger.readSession(first),/不存在/);
  await assert.rejects(f.handler.receive({...first,sessionId:'capture-other-12345678'}),/不能换内容/);
  await f.handler.receive({...request(),id:'capture-legacy-12345678'});
  await assert.rejects(f.handler.receive({...next,sessionId:'capture-legacy-12345678'}),/不能把旧素材/);
});

test('混合文字照片录音先保存原件，追加纯照片仍归同一记忆且无需调用模型',async()=>{
  const oldModerate=guard.moderateText,oldActive=guard.assertIdentityStillActive;
  guard.moderateText=async()=>{};guard.assertIdentityStillActive=async()=>{};
  try{
    const f=fixture();let aiCalls=0;
    const handler=createCaptureHandler({...f,fetcher:async()=>{aiCalls++;throw new Error('不得自动分析');}});
    for(const id of ['photo-first','photo-next'])f.state.set(`photos/${f.identity.familyId}__${id}`,{familyId:f.identity.familyId,_openid:f.identity.openid});
    const first={...request(),sessionId:request().id,photoIds:['photo-first'],audio:[{id:'audio-123456',extension:'mp3',bytes:30,name:'随手录音.mp3'}]};
    const receipt=await handler.receive(first);
    await assert.rejects(handler.saveOriginal(first),/尚未上传完/);
    // Failed commit must leave the batch uploadable, so the user can retry sending.
    assert.equal((await handler.read(first)).status,'received');
    await handler.register({id:first.id,fileId:first.audio[0].id,fileID:`cloud://env.bucket/${receipt.uploads[0].cloudPath}`});
    const saved=await handler.saveOriginal(first);
    const next={...request(),id:'capture-next-12345678',sessionId:first.id,text:'',photoIds:['photo-next']};
    await handler.receive(next);assert.equal((await handler.saveOriginal(next)).memoryId,saved.memoryId);
    const memory=f.state.get(`memories/${f.identity.familyId}_${saved.memoryId}`);
    assert.deepEqual(memory.photoIds,['photo-first','photo-next']);assert.equal(aiCalls,0);
    const session=await handler.readSession(first);
    assert.equal(session.items[0].audio[0].name,'随手录音.mp3');assert.equal(session.items[0].audio[0].fileID,undefined);
    assert.match((await handler.audioUrl({id:first.id,fileId:first.audio[0].id})).url,/https:/);
  }finally{guard.moderateText=oldModerate;guard.assertIdentityStillActive=oldActive;}
});

test('长会话维持既有记忆正文和配图上限，原始记录完整可恢复',async()=>{
  const oldModerate=guard.moderateText,oldActive=guard.assertIdentityStillActive;
  guard.moderateText=async()=>{};guard.assertIdentityStillActive=async()=>{};
  try{
    const f=fixture(),sessionId=request().id,photoIds=Array.from({length:12},(_,i)=>`photo-${i}`);
    for(const id of photoIds)f.state.set(`photos/${f.identity.familyId}__${id}`,{familyId:f.identity.familyId,_openid:f.identity.openid});
    const text='完整的原话。'.repeat(500);
    let saved;
    for(let i=0;i<2;i++){
      const message={...request(),id:i?'capture-next-12345678':sessionId,sessionId,text,photoIds:photoIds.slice(i*6,i*6+6)};
      await f.handler.receive(message);saved=await f.handler.saveOriginal(message);
    }
    const memory=f.state.get(`memories/${f.identity.familyId}_${saved.memoryId}`);
    assert.ok(memory.text.length<=500);assert.equal(memory.photoIds.length,9);
    assert.equal(memory.aiRevisions[memory.aiRevisions.length-1].text,memory.text);
    const session=await f.handler.readSession({id:sessionId});
    assert.equal(session.items.map(item=>item.text).join('\n\n'),text+'\n\n'+text);
    assert.equal(session.items.flatMap(item=>item.photoIds).length,12);
  }finally{guard.moderateText=oldModerate;guard.assertIdentityStillActive=oldActive;}
});

test('随手记追加保留最新人工修改及长原文，删除后的记忆不被悄悄复活',async()=>{
  const oldModerate=guard.moderateText,oldActive=guard.assertIdentityStillActive;
  const moderated=[];guard.moderateText=async(_cloud,_openid,text)=>moderated.push(text);guard.assertIdentityStillActive=async()=>{};
  try{
    const f=fixture(),first={...request(),sessionId:request().id,text:'长原文。'.repeat(300)};
    await f.handler.receive(first);const saved=await f.handler.saveOriginal(first);
    assert.ok(moderated.includes(first.text),'完整原文须审核，不能只审核缩略正文');
    assert.equal([...f.state.values()].find(row=>row.rawText).rawText,first.text);
    const memory=f.state.get(`memories/${f.identity.familyId}_${saved.memoryId}`);
    memory.text='已由用户编辑';memory.title='用户的标题';
    const next={...request(),id:'capture-next-12345678',sessionId:first.id};
    await f.handler.receive(next);await f.handler.saveOriginal(next);
    const updated=f.state.get(`memories/${f.identity.familyId}_${saved.memoryId}`);
    assert.equal(updated.text,'已由用户编辑');assert.equal(updated.title,'用户的标题');
    assert.equal([...f.state.values()].find(row=>row.rawText).rawText,first.text+'\n\n'+next.text);
    updated.deletedAt=new Date().toISOString();
    const last={...next,id:'capture-last-12345678'};
    await f.handler.receive(last);await assert.rejects(f.handler.saveOriginal(last),/更改或移除/);
    assert.ok(f.state.get(`memories/${f.identity.familyId}_${saved.memoryId}`).deletedAt);
    assert.notEqual((await f.handler.read(last)).status,'saved');
  }finally{guard.moderateText=oldModerate;guard.assertIdentityStillActive=oldActive;}
});

test('收集协议拒绝空批次、重复编号与过大录音',()=>{
  assert.throws(()=>inputOf({...request(),text:''}),/先添加/);
  assert.throws(()=>inputOf({...request(),audio:[{id:'audio-123456',extension:'exe',bytes:8}]}),/录音格式/);
  assert.throws(()=>inputOf({...request(),photoIds:['photo-one','photo-one']}),/照片/);
});
test('并发接收幂等，改内容与越权查询拒绝，来源记录留存',async()=>{
  const {handler,db,identity,cloud}=fixture();
  await Promise.all([handler.receive(request()),handler.receive(request())]);
  assert.equal((await handler.list()).items.length,1);
  await assert.rejects(handler.receive({...request(),text:'另一份内容'}),/不能换内容/);
  const stranger=createCaptureHandler({db,cloud,identity:{...identity,accountId:'account_bbbbbbbbbbbbbbbbbbbbbbbb'}});
  await assert.rejects(stranger.read(request()),/不存在/);
  assert.equal((await handler.read(request())).text,request().text);
});
test('录音只能登记服务器签发路径，不能借用其他云文件',async()=>{
  const {handler}=fixture();const input={...request(),audio:[{id:'audio-123456',extension:'mp3',name:'原录音.mp3',bytes:30}]};
  const received=await handler.receive(input);
  await assert.rejects(handler.register({id:input.id,fileId:input.audio[0].id,fileID:'cloud://env.bucket/somebody/private.mp3'}),/归属/);
  const result=await handler.register({id:input.id,fileId:input.audio[0].id,fileID:`cloud://env.bucket/${received.uploads[0].cloudPath}`});
  assert.equal(result.audio[0].fileID,undefined,'public receipts must not expose storage identifiers');
  assert.equal(result.audio[0].cloudPath,undefined);
});
test('未完成规则配置时素材入口关闭，不自动创建公开集合',async()=>{
  const previous=process.env.MATERIAL_CAPTURE_READY;delete process.env.MATERIAL_CAPTURE_READY;
  try{await assert.rejects(handle({action:'captureReceive'}),/尚未开放/);}
  finally{if(previous===undefined)delete process.env.MATERIAL_CAPTURE_READY;else process.env.MATERIAL_CAPTURE_READY=previous;}
});
test('录音登记必须检查真实字节，并保存不受客户端覆盖的原件',async()=>{
  const f=fixture();const input={...request(),audio:[{id:'audio-123456',extension:'mp3',bytes:30}]};
  const received=await f.handler.receive(input);
  const event={id:input.id,fileId:input.audio[0].id,fileID:`cloud://env.bucket/${received.uploads[0].cloudPath}`};
  f.cloud.downloadFile=async()=>({fileContent:Buffer.from('fake')});
  await assert.rejects(f.handler.register(event),/校验失败/);
  assert.equal([...f.state.values()].find(row=>row.id===input.id).audio[0].fileID,undefined);
  const bytes=Buffer.alloc(30);bytes.write('ID3');f.cloud.downloadFile=async()=>({fileContent:bytes});
  await f.handler.register(event);
  const saved=[...f.state.values()].find(row=>row.id===input.id).audio[0];
  assert.match(saved.fileID,/memory-capture-originals/);assert.match(saved.sha256,/^[a-f0-9]{64}$/);
  await f.handler.register(event);
  assert.equal([...f.state.values()].find(row=>row.id===input.id).audio[0].fileID,saved.fileID);
});
test('保存原文时记忆、来源及批次回执原子落地，并发只保存一份',async()=>{
  const oldModerate=guard.moderateText,oldActive=guard.assertIdentityStillActive;
  guard.moderateText=async()=>{};guard.assertIdentityStillActive=async()=>{};
  try {
    const {handler,state}=fixture();await handler.receive(request());
    await Promise.all([handler.saveOriginal(request()),handler.saveOriginal(request())]);
    const receipt=await handler.read(request());assert.equal(receipt.status,'saved');
    const memories=[...state.entries()].filter(([key])=>key.startsWith('memories/'));
    assert.equal(memories.length,1);assert.equal(memories[0][1].text,request().text);
    assert.equal(memories[0][1].authorName,'测试作者');assert.equal(memories[0][1].visibility,'private');
    assert.equal(memories[0][1].aiRevisions[0].kind,'spoken');assert.equal(memories[0][1].aiRevisions[1].kind,'manual');
    assert.equal(memories[0][1].frontendContributionId,receipt.memoryId);
    assert.equal([...state.keys()].filter(key=>key.startsWith('source_records/')).length,1);
  } finally {guard.moderateText=oldModerate;guard.assertIdentityStillActive=oldActive;}
});
test('处理中的批次不会因重复点击再次调用供应商',async()=>{
  const oldReady=guard.assertServerReady;guard.assertServerReady=()=>{};
  try {
    const {handler,state}=fixture();await handler.receive(request());
    const row=[...state.values()].find(item=>item.id===request().id);row.status='processing';
    assert.equal((await handler.processNext(request())).status,'processing');
  }finally{guard.assertServerReady=oldReady;}
});

test('保存原件同样拒绝他人照片，并且不创建记忆',async()=>{
  const {handler,state,identity}=fixture();
  const input={...request(),photoIds:['photo-foreign']};
  state.set(`photos/${identity.familyId}__photo-foreign`,{familyId:identity.familyId,_openid:'someone-else'});
  await assert.rejects(handler.receive(input),/不属于/);
  assert.equal([...state.keys()].filter(key=>key.startsWith('material_captures/')).length,0);
});
test('真实处理协议逐步留下证据，重复完成不再次调用模型',async()=>{
  const names=['assertServerReady','assertConsentVersion','moderateText','assertIdentityStillActive','reserveAiRequest'];
  const old=Object.fromEntries(names.map(key=>[key,guard[key]]));
  const env={...process.env};names.forEach(key=>{guard[key]=async()=>{};});
  process.env.ORGANIZE_AI_API_KEY='fixture';process.env.ORGANIZE_AI_MODEL='fixture';process.env.ORGANIZE_AI_BASE_URL='https://tokenhub.tencentmaas.com/v1';process.env.TEXT_COMPUTE_USAGE_ENABLED='false';
  try {
    const f=fixture();let calls=0;
    const handler=createCaptureHandler({...f,fetcher:async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({title:'纸船',body:'纸船来到灯塔边。'})}}]})};}});
    await handler.receive(request());const result=await handler.processNext(request());
    assert.equal(result.status,'saved');assert.equal(result.evidence[0].text,request().text);
    assert.equal((await handler.processNext(request())).memoryId,result.memoryId);assert.equal(calls,1);
    assert.equal([...f.state.values()].find(row=>row.frontendContributionId===result.memoryId)._openid,f.identity.openid);
  }finally{Object.assign(guard,old);for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);}
});
test('未知供应商失败只保留一次调用，读取和重试不会再付费',async()=>{
  const names=['assertServerReady','assertConsentVersion','moderateText','assertIdentityStillActive','reserveAiRequest'];const old=Object.fromEntries(names.map(key=>[key,guard[key]]));
  const env={...process.env};names.forEach(key=>{guard[key]=async()=>{};});
  process.env.ORGANIZE_AI_API_KEY='fixture';process.env.ORGANIZE_AI_MODEL='fixture';process.env.ORGANIZE_AI_BASE_URL='https://tokenhub.tencentmaas.com/v1';process.env.TEXT_COMPUTE_USAGE_ENABLED='false';
  try{const f=fixture();let calls=0;const handler=createCaptureHandler({...f,fetcher:async()=>{calls++;throw new Error('connection lost');}});await handler.receive(request());assert.equal((await handler.processNext(request())).status,'uncertain');await handler.processNext(request());assert.equal(calls,1);assert.equal((await handler.saveOriginal(request())).status,'saved');}finally{Object.assign(guard,old);for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);}
});


test('录音服务拒绝授权时显示明确原因，原件可保存且不重复转写', async () => {
  const names=['assertServerReady','assertConsentVersion','moderateText','assertIdentityStillActive','reserveAiRequest'];
  const old=Object.fromEntries(names.map(key=>[key,guard[key]]));
  const oldKey=process.env.DOUBAO_SPEECH_API_KEY;
  names.forEach(key=>{guard[key]=async()=>{};});
  process.env.DOUBAO_SPEECH_API_KEY='fixture';
  try {
    const f=fixture();let calls=0;
    const handler=createCaptureHandler({...f,fetcher:async()=>{calls++;return {ok:false,status:403};}});
    const input={...request(),audio:[{id:'audio-123456',extension:'mp3',bytes:30}]};
    const received=await handler.receive(input);
    await handler.register({id:input.id,fileId:input.audio[0].id,fileID:`cloud://env.bucket/${received.uploads[0].cloudPath}`});
    const result=await handler.processNext({...input,audioConsent:true});
    assert.equal(result.status,'uncertain');assert.match(result.message,/尚未获授权/);
    assert.equal(result.audio.length,1);
    await handler.processNext({...input,audioConsent:true});assert.equal(calls,1);
    const saved=await handler.saveOriginal(input);assert.equal(saved.status,'saved');
    assert.equal(saved.evidence.some(item=>item.kind==='transcript'),false);
  } finally {
    Object.assign(guard,old);
    if(oldKey===undefined)delete process.env.DOUBAO_SPEECH_API_KEY;else process.env.DOUBAO_SPEECH_API_KEY=oldKey;
  }
});


test('素材存储规则只收紧既有创建者权限，原件目录拒绝客户端读写', () => {
  const rules=require('../deploy/material-capture/storage.rules.json');
  // The expressions use the documented CloudBase regex test syntax, which is also valid JS.
  const check=(kind,path,owner='owner',visitor='owner')=>Function('resource','auth',`return (${rules[kind]});`)({path,openid:owner},{openid:visitor,uid:'web-'+visitor});
  for(const path of ['user-photos/a.jpg','chapter-packages/a.json','story-images/a.png','voice-samples/a.wav']) {
    assert.equal(check('read',path),true);assert.equal(check('write',path),true);
    assert.equal(check('read',path,'owner','stranger'),false);assert.equal(check('write',path,'owner','stranger'),false);
  }
  assert.equal(check('write','memory-capture-uploads/owner/a.mp3'),true);
  assert.equal(check('write','memory-capture-uploads/owner/a.mp3','owner','stranger'),false);
  assert.equal(check('read','memory-capture-uploads/owner/a.mp3'),false);
  assert.equal(check('read','memory-capture-originals/owner/a.mp3'),false);
  assert.equal(check('write','memory-capture-originals/owner/a.mp3'),false);
});

test('标准版转写持久化任务，等待与重开只查询、不重复提交', async () => {
  const names=['assertServerReady','assertConsentVersion','moderateText','assertIdentityStillActive','reserveAiRequest'];
  const old=Object.fromEntries(names.map(key=>[key,guard[key]])),env={...process.env};
  names.forEach(key=>{guard[key]=async()=>{};});
  process.env.DOUBAO_SPEECH_API_KEY='fixture';process.env.DOUBAO_SPEECH_RESOURCE_ID='volc.seedasr.auc';
  try {
    const f=fixture();f.cloud.getTempFileURL=async()=>({fileList:[{tempFileURL:'https://example.com/private-fixture'}]});
    const calls=[];
    const fetcher=async(url,options)=>{
      calls.push({url,options});
      const code=calls.length===2?'20000001':'20000000';
      return {ok:true,status:200,headers:{get:()=>code},json:async()=>({result:{text:'虚构录音：纸船抵达灯塔。'}})};
    };
    let handler=createCaptureHandler({...f,fetcher});
    const input={...request(),audio:[{id:'audio-123456',extension:'mp3',bytes:30}]};
    const received=await handler.receive(input);
    await handler.register({id:input.id,fileId:input.audio[0].id,fileID:`cloud://env.bucket/${received.uploads[0].cloudPath}`});
    const event={...input,audioConsent:true};
    const pending=await handler.processNext(event);
    assert.equal(pending.status,'received');assert.equal(pending.pollAfterMs,5000);
    assert.equal(pending.audio[0].asrTask,undefined);
    handler=createCaptureHandler({...f,fetcher});
    assert.equal((await handler.processNext(event)).status,'received');
    const done=await handler.processNext(event);
    assert.equal(done.evidence.find(e=>e.kind==='transcript').text,'虚构录音：纸船抵达灯塔。');
    assert.equal(done.pollAfterMs,0);assert.equal(done.message,'');
    assert.equal(calls.filter(c=>c.url.endsWith('/submit')).length,1);
    assert.equal(calls.filter(c=>c.url.endsWith('/query')).length,2);
    assert.equal(new Set(calls.map(c=>c.options.headers['X-Api-Request-Id'])).size,1);
    assert.equal(calls[0].options.headers['X-Api-Resource-Id'],'volc.seedasr.auc');
    assert.equal(JSON.parse(calls[0].options.body).audio.url,'https://example.com/private-fixture');
  } finally {Object.assign(guard,old);for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);}
});

test('标准版提交响应丢失或函数中断后，只恢复原任务查询', async () => {
  const names=['assertServerReady','assertConsentVersion','moderateText','assertIdentityStillActive','reserveAiRequest'];
  const old=Object.fromEntries(names.map(key=>[key,guard[key]])),env={...process.env};
  names.forEach(key=>{guard[key]=async()=>{};});
  process.env.DOUBAO_SPEECH_API_KEY='fixture';process.env.DOUBAO_SPEECH_RESOURCE_ID='volc.seedasr.auc';
  try {
    const f=fixture();f.cloud.getTempFileURL=async()=>({fileList:[{tempFileURL:'https://example.com/private-fixture'}]});
    const calls=[];const handler=createCaptureHandler({...f,fetcher:async(url)=>{
      calls.push(url);if(url.endsWith('/submit'))throw new Error('connection lost');
      return {ok:true,status:200,headers:{get:()=> '20000000'},json:async()=>({result:{text:'纸船。'}})};
    }});
    const input={...request(),audio:[{id:'audio-123456',extension:'mp3',bytes:30}]};
    const received=await handler.receive(input);
    await handler.register({id:input.id,fileId:input.audio[0].id,fileID:`cloud://env.bucket/${received.uploads[0].cloudPath}`});
    assert.equal((await handler.processNext({...input,audioConsent:true})).status,'received');
    const row=[...f.state.values()].find(r=>r.id===input.id);
    row.status='processing';row.updatedAtMs=Date.now()-130000;
    assert.equal((await handler.read(input)).status,'received');
    const result=await handler.processNext({...input,audioConsent:true});
    assert.equal(result.evidence.find(e=>e.kind==='transcript').text,'纸船。');
    assert.equal(calls.filter(url=>url.endsWith('/submit')).length,1);
    assert.equal(calls.filter(url=>url.endsWith('/query')).length,1);
  } finally {Object.assign(guard,old);for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);}
});
