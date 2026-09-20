const OPENID=/^[0-9A-Za-z_-]{1,128}$/;
/*
 * 内容安全检测的三态语义（2026-09-20 修正）：
 *   true  —— 内容通过
 *   false —— 内容确实违规，用户改文字可以解决
 *   抛错  —— 检测服务本身故障，用户改多少遍都没用
 *
 * 原实现把后两种都返回 false，四个调用点一律按 `!== true` 提示
 * 「这段内容没有通过内容安全检测，请修改后重试」。于是 security 接口没配置、
 * openid 取不到、msgSecCheck 超时，全被说成是用户写的东西违规，而且不留日志。
 * 系统的故障不能说成用户的错，所以故障改为抛 MODERATION_UNAVAILABLE 并打日志。
 */
function unavailable(reason,detail){
  console.error('[moderation] 内容安全检测不可用：',reason,detail||'');
  throw Object.assign(new Error('内容安全检测暂时不可用，请稍后再试'),{code:'MODERATION_UNAVAILABLE'});
}
function createTextModerator(security){
  return async (text,openid,title)=>{
    if(!security || typeof security.msgSecCheck!=='function')unavailable('云开发 security 接口不可用');
    if(!OPENID.test(openid || ''))unavailable('调用方 openid 无效');
    const content=Array.from(String(text || '').trim());
    if(!content.length)return true;
    const safeTitle=Array.from(String(title || '').trim()).slice(0,100).join('');
    try{
      for(let offset=0;offset<content.length;offset+=2500){
        const response=await security.msgSecCheck({content:content.slice(offset,offset+2500).join(''),version:2,scene:4,openid,...(safeTitle?{title:safeTitle}:{})});
        if(response?.result?.suggest!=='pass')return false;
      }
      return true;
    }catch(error){
      if(error?.code==='MODERATION_UNAVAILABLE')throw error;
      unavailable('msgSecCheck 调用失败',error?.message||error);
    }
  };
}
module.exports={createTextModerator};
