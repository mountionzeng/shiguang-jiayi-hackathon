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
  let response;
  try {
    response=await options.generate({scene:`wl_${code}`,page:PAGE,checkPath:envVersion==='release',envVersion,width:360});
  } catch(error) {
    // Diagnose real platform prerequisites without logging scenes, signatures,
    // credentials, full provider messages or any account information.
    const sdkCode=Number(error?.errCode??error?.errcode);
    const message=String(error?.errMsg||error?.message||'');
    const match=/(?:errcode|error code)[\s:="'：]+(-?\d+)/i.exec(message);
    console.error('web_login_qr_generation_failed',{
      sdkCode:Number.isFinite(sdkCode)?sdkCode:null,
      providerCode:match?Number(match[1]):null,
      invalidPage:/invalid page/i.test(message),
      unreleased:/not released|未发布/i.test(message),
      permissionDenied:/permission|权限|unauthorized/i.test(message),
    });
    throw error;
  }
  const bytes=Buffer.isBuffer(response)?response:response?.buffer;
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>1024*1024||expiresAt<=options.now())fail('qr_unavailable');
  return {base64:bytes.toString('base64')};
}
module.exports={webLoginQr,PATH,PAGE};
