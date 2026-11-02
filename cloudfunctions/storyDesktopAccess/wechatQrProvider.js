const https=require('node:https');
const fail=code=>Object.assign(new Error(code),{code});
function post(path,body){
  return new Promise((resolve,reject)=>{
    const data=Buffer.from(JSON.stringify(body));
    const req=https.request({hostname:'api.weixin.qq.com',path,method:'POST',headers:{'content-type':'application/json','content-length':data.length}},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){res.destroy();reject(fail('qr_provider_response_too_large'));}else chunks.push(chunk);});
      res.on('error',()=>reject(fail('qr_provider_unavailable')));
      res.on('end',()=>res.statusCode===200?resolve(Buffer.concat(chunks)):reject(fail('qr_provider_unavailable')));
    });
    req.setTimeout(8000,()=>req.destroy());
    req.on('error',()=>reject(fail('qr_provider_unavailable')));
    req.end(data);
  });
}
function parse(buffer){try{return JSON.parse(buffer.toString('utf8'));}catch{throw fail('qr_provider_invalid_response');}}
function providerError(result){
  const error=fail('qr_provider_rejected');
  error.errCode=Number.isSafeInteger(result?.errcode)?result.errcode:0;
  return error;
}
function createQrGenerator({appid,secret,request=post,now=Date.now}){
  let cached,pending;
  async function token(){
    if(cached&&cached.until>now())return cached.value;
    if(pending)return pending;
    pending=(async()=>{
      const result=parse(await request('/cgi-bin/stable_token',{grant_type:'client_credential',appid,secret,force_refresh:false}));
      if(result.errcode)throw providerError(result);
      if(typeof result.access_token!=='string'||!result.access_token||!Number.isFinite(result.expires_in)||result.expires_in<=60)throw fail('qr_provider_invalid_response');
      cached={value:result.access_token,until:now()+(result.expires_in-60)*1000};
      return cached.value;
    })();
    try{return await pending;}finally{pending=undefined;}
  }
  return async function generate(input){
    if(!/^wx[a-f0-9]{16}$/.test(appid||'')||!secret)throw fail('qr_not_configured');
    const accessToken=await token();
    const bytes=await request('/wxa/getwxacodeunlimit?access_token='+encodeURIComponent(accessToken),{
      scene:input.scene,page:input.page,check_path:input.checkPath,env_version:input.envVersion,width:input.width,
    });
    if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.subarray(0,3).equals(Buffer.from([255,216,255])))return bytes;
    const result=parse(bytes);
    if([40001,40014,42001].includes(result.errcode))cached=undefined;
    throw providerError(result);
  };
}
module.exports={createQrGenerator};
