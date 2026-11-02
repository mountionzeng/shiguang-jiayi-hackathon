const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {webLoginQr,PATH,PAGE}=require('../cloudfunctions/storyDesktopAccess/webLoginQr');
const {sign,verifyRequest}=require('../cloudfunctions/storyDesktopAccess/core');
const {webLoginBody}=require('../cloudfunctions/drinkingTimeBridge/core');
const secret='s'.repeat(32),now=1793600000000,code='A'.repeat(28);
function setup(){
  const data=new Map(),calls=[],repo={get:async(t,id)=>data.get(t+'/'+id),set:async(t,id,v)=>data.set(t+'/'+id,v),transaction:async fn=>fn(repo)};
  const options={secret,now:()=>now,envVersion:'trial',generate:async input=>{calls.push(input);return {buffer:Buffer.from('fixture-image')};}};
  function request(body={code,expiresAt:now+120000},timestamp=now){
    const nonce=crypto.randomBytes(18).toString('base64url');return {method:'POST',path:PATH,body,headers:{'x-shiguang-timestamp':String(timestamp),'x-shiguang-nonce':nonce,'x-shiguang-signature':sign(secret,String(timestamp),nonce,body,PATH)}};
  }
  return {repo,options,calls,request};
}
test('generates a fixed confirmation page and token-only scene, from a signed request',async()=>{
  const f=setup();assert.deepEqual(await webLoginQr(f.repo,f.request(),f.options),{base64:Buffer.from('fixture-image').toString('base64')});
  assert.deepEqual(f.calls,[{scene:'wl_'+code,page:PAGE,envVersion:'trial',checkPath:false,width:360}]);
  assert.ok(f.calls[0].scene.length<=32);
  assert.equal(webLoginBody({code,decision:'preview',userId:99},{APPID:'wxTest',OPENID:'openid'}).code,code);
});
test('rejects stale function-clock signatures, expiry, extra fields, forged requests and replays before generating',async()=>{
  for(const kind of ['stale','expired','extra','forged','replay']){
    const f=setup(),req=f.request(kind==='expired'?{code,expiresAt:now-1}:kind==='extra'?{code,expiresAt:now+120000,page:'evil'}:undefined,kind==='stale'?now-300001:now);
    if(kind==='forged')req.body.code='B'.repeat(28);
    if(kind==='replay')await webLoginQr(f.repo,req,f.options);
    await assert.rejects(webLoginQr(f.repo,req,f.options));assert.equal(f.calls.length,kind==='replay'?1:0);
  }
});
test('existing authority requests also enforce time skew when production passes a clock function',()=>{
  const body={grantId:'desktop-grant-'+'a'.repeat(64)},timestamp=String(now-300001),nonce='a'.repeat(24),path='/v1/story/read';
  assert.throws(()=>verifyRequest({method:'POST',path,body,headers:{'x-shiguang-timestamp':timestamp,'x-shiguang-nonce':nonce,'x-shiguang-signature':sign(secret,timestamp,nonce,body,path)}},{secret,now:()=>now}),/invalid_authority_signature/);
});
test('does not return an invalid provider response or a code expired during generation',async()=>{
  const f=setup();f.options.generate=async()=>({errcode:40097});await assert.rejects(webLoginQr(f.repo,f.request(),f.options));
  f.options.generate=async()=>{f.options.now=()=>now+120001;return Buffer.from('fixture-image');};
  await assert.rejects(webLoginQr(f.repo,f.request(),f.options));
});
test('provider diagnostics preserve failure and never log the request or provider message',async()=>{
  const f=setup(),logs=[],original=console.error;
  const error=Object.assign(new Error('errcode: 85096 app not released private-token'),{errCode:-604101});
  f.options.generate=async()=>{throw error;};console.error=(...args)=>logs.push(args);
  try{await assert.rejects(webLoginQr(f.repo,f.request(),f.options),value=>value===error);}
  finally{console.error=original;}
  assert.deepEqual(logs,[['web_login_qr_generation_failed',{sdkCode:-604101,providerCode:85096,invalidPage:false,unreleased:true,permissionDenied:false}]]);
});
