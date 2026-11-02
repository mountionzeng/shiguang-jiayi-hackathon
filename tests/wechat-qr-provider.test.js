const test=require('node:test'),assert=require('node:assert/strict');
const {createQrGenerator}=require('../cloudfunctions/storyDesktopAccess/wechatQrProvider');
const appid='wx86ae3e9d507ce52d',secret='test-secret';
const input={scene:'wl_'+'A'.repeat(28),page:'packages/web-login/pages/confirm/index',checkPath:false,envVersion:'develop',width:360};
const image=Buffer.from([137,80,78,71,13,10,26,10,1]);
const json=value=>Buffer.from(JSON.stringify(value));
test('server credentials acquire a cached stable token and generate the exact confirmation scene',async()=>{
 const calls=[];let now=1000;
 const generate=createQrGenerator({appid,secret,now:()=>now,request:async(path,body)=>{calls.push({path,body});return path==='/cgi-bin/stable_token'?json({access_token:'token/value',expires_in:7200}):image;}});
 assert.deepEqual(await generate(input),image);await generate(input);
 assert.equal(calls.length,3);assert.deepEqual(calls[0].body,{grant_type:'client_credential',appid,secret,force_refresh:false});
 assert.equal(calls[1].path,'/wxa/getwxacodeunlimit?access_token=token%2Fvalue');
 assert.deepEqual(calls[1].body,{scene:input.scene,page:input.page,check_path:false,env_version:'develop',width:360});
 now+=7200000;await generate(input);assert.equal(calls.filter(c=>c.path==='/cgi-bin/stable_token').length,2);
});
test('fails closed without credentials and never exposes provider messages',async()=>{
 await assert.rejects(createQrGenerator({appid}) (input),/qr_not_configured/);
 const generate=createQrGenerator({appid,secret,request:async()=>json({errcode:40125,errmsg:'private-provider-details'})});
 await assert.rejects(generate(input),error=>error.code==='qr_provider_rejected'&&error.errCode===40125&&!error.message.includes('private'));
});
test('shares token acquisition across concurrent requests and invalidates rejected tokens',async()=>{
 let tokens=0,images=0;
 const generate=createQrGenerator({appid,secret,request:async path=>{
  if(path==='/cgi-bin/stable_token'){tokens++;return json({access_token:'token',expires_in:7200});}
  images++;return images===1?json({errcode:40001}):image;
 }});
 const result=await Promise.allSettled([generate(input),generate(input)]);
 assert.equal(tokens,1);assert.equal(result[0].status,'rejected');assert.equal(result[1].status,'fulfilled');
 await generate(input);assert.equal(tokens,2);
});
