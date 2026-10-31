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
