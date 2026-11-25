const {moderateTextWithTencent}=require('./tencentModeration');
const OPENID=/^[0-9A-Za-z_-]{1,128}$/;
// pass / explicit rejection / review / service failure are different outcomes.
// Only service failures may use a fallback. No raw errors, text or openids in logs.
function providerCode(value){
  const code=value?.errCode ?? value?.errcode ?? value?.code;
  if (/^-?\d{1,8}$/.test(String(code))) return Number(code);
  const match=String(value?.errMsg || value?.message || value?.error || '').match(/\berrCode\s*[:=]\s*(-?\d{1,8})\b/i);
  return match ? Number(match[1]) : undefined;
}
function diagnostic(provider,verdict,response){
  const trace=String(response?.traceId || response?.trace_id || '');
  const label=response?.result?.label ?? response?.label;
  console.warn('[moderation]',{provider,verdict,
    ...(providerCode(response)!==undefined?{code:providerCode(response)}:{}),
    ...(/^[\w-]{1,128}$/.test(trace)?{traceId:trace}:{}),
    ...(Number.isInteger(label)?{label}:{})});
}
function unavailable(provider,response){
  diagnostic(provider,'unavailable',response);
  throw Object.assign(new Error('内容检查服务暂时不可用，请稍后重试'),{code:'MODERATION_UNAVAILABLE'});
}
function verdict(suggest,provider,response){
  if(suggest==='pass')return true;
  if(suggest==='risky'||suggest==='reject'||suggest==='block'){
    diagnostic(provider,'reject',response);return false;
  }
  if(suggest==='review'){
    diagnostic(provider,'review',response);
    throw Object.assign(new Error('内容检查返回“需复核”，暂未通过检查'),{code:'MODERATION_REVIEW'});
  }
  unavailable(provider,response);
}
function interpretResponse(response){
  const code=providerCode(response);
  if(code===87014)return verdict('risky','wechat',response);
  if(code)unavailable('wechat',response);
  return verdict(response?.result?.suggest,'wechat',response);
}
async function checkWithSharedFunction(callFunction,input){
  if(typeof callFunction!=='function')unavailable('shared');
  let response;
  try{
    response=await callFunction({name:'contentSecurityCheck',data:input});
  }catch(error){
    if(providerCode(error)===87014)return verdict('risky','shared',error);
    unavailable('shared',error);
  }
  const result=response?.result;
  if(providerCode(result)===87014)return verdict('risky','shared',result);
  if(result?.error || providerCode(result))unavailable('shared',result);
  if(result?.ok===true && (!result.suggest || result.suggest==='pass'))return true;
  if(result?.ok!==false || result.suggest==='pass')unavailable('shared',result);
  return verdict(result.suggest,'shared',result);
}
async function checkWithFallback(callFunction,input,paidModeration){
  try { return await checkWithSharedFunction(callFunction,input); }
  catch(error){
    if(error?.code!=='MODERATION_UNAVAILABLE')throw error;
    let result;
    try{
      result=await paidModeration({content:input.title ? `${input.title}\n${input.content}` : input.content});
    }catch(paidError){unavailable('tencent-tms',paidError);}
    if(result?.available!==true)unavailable('tencent-tms');
    // The shared adapter retains reject status for compatibility with AI callers;
    // its original suggestion distinguishes Review from Block here.
    return verdict(String(result.suggestion ?? result.status ?? '').toLowerCase(),'tencent-tms',result);
  }
}
function createTextModerator(security,callFunction,paidModeration=moderateTextWithTencent){
  return async (text,openid,title)=>{
    if(!OPENID.test(openid || ''))unavailable('identity');
    const content=Array.from(String(text || '').trim());
    if(!content.length)return true;
    const safeTitle=Array.from(String(title || '').trim()).slice(0,100).join('');
    for(let offset=0;offset<content.length;offset+=2500){
      const input={content:content.slice(offset,offset+2500).join(''),scene:4,openid,...(safeTitle?{title:safeTitle}:{})};
      let passed;
      if(security && typeof security.msgSecCheck==='function'){
        try{
          passed=interpretResponse(await security.msgSecCheck({...input,version:2}));
        }catch(error){
          if(error?.code==='MODERATION_REVIEW')throw error;
          if(providerCode(error)===87014)return verdict('risky','wechat',error);
          if(error?.code!=='MODERATION_UNAVAILABLE')diagnostic('wechat','unavailable',error);
          passed=await checkWithFallback(callFunction,input,paidModeration);
        }
      }else{
        passed=await checkWithFallback(callFunction,input,paidModeration);
      }
      if(passed!==true)return false;
    }
    return true;
  };
}
module.exports={createTextModerator};
