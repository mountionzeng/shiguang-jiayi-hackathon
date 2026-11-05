const crypto=require('node:crypto');
const fail=()=>Object.assign(new Error('请重新登录'),{code:'AUTH_REQUIRED'});
// Only this text-check action can use the bridge nonce; it grants no read/write access.
async function moderationContext(repo,context,event,now=Date.now()){
  if(event?.action!=='checkOutgoingText'||context?.OPENID)return context;
  if(!/^[a-f0-9]{64}$/.test(event.proof||'')||typeof event.text!=='string'||Buffer.byteLength(event.text)>240000)throw fail();
  return repo.transaction(async tx=>{
    const id='moderation_'+event.proof;
    const row=await tx.get('story_collaboration_operations',id);
    if(!row||row.kind!=='bridge-moderation'||!(row.expiresAt>now)||row.expiresAt>now+120000||
      !/^wx[\w-]{1,80}$/.test(row.appId||'')||! /^[\w-]{1,128}$/.test(row.openid||'')||
      row.digest!==crypto.createHash('sha256').update(event.text).digest('hex'))throw fail();
    await tx.remove('story_collaboration_operations',id);
    return {APPID:row.appId,OPENID:row.openid};
  });
}
module.exports={moderationContext};
