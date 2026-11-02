const {verifySignedRequest,claimNonce}=require('./core');
const PATH='/v1/web-login/qr';
const PAGE='packages/web-login/pages/confirm/index';
const fail=code=>{throw Object.assign(new Error(code),{code});};

async function webLoginQr(repo,request,options){
  const verified=verifySignedRequest(request,options,PATH,['code','expiresAt']);
  const {code,expiresAt}=request.body,now=options.now();
  if(!/^[A-F0-9]{28}$/.test(code||'')||!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt>now+120000)fail('invalid_input');
  await repo.transaction(tx=>claimNonce(tx,verified.timestampMs,verified.nonce));
  const envVersion=options.envVersion||'release';
  if(!['release','trial','develop'].includes(envVersion))fail('qr_not_configured');
  const response=await options.generate({scene:`wl_${code}`,page:PAGE,checkPath:envVersion==='release',envVersion,width:360});
  const bytes=Buffer.isBuffer(response)?response:response?.buffer;
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>1024*1024||expiresAt<=options.now())fail('qr_unavailable');
  return {base64:bytes.toString('base64')};
}
module.exports={webLoginQr,PATH,PAGE};
