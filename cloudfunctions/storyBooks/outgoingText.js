// Check the exact outgoing snapshot; never use this gate for private persistence.
async function approveOutgoingText(approve,ctx,title,chapters){
  if(typeof approve!=='function')throw Object.assign(new Error('分享检查暂时不可用，请稍后重试'),{code:'MODERATION_UNAVAILABLE'});
  const text=[title,...chapters.flatMap(c=>[c.title,...(c.content||[]).map(b=>b.text||''),...(c.layout?.pages||[]).map(p=>p.label||'')])].filter(Boolean).join('\n');
  if(await approve(text,ctx.verifiedOpenid,'分享故事')!==true)throw Object.assign(new Error('内容未通过分享检查'),{code:'CONTENT_REJECTED'});
}
module.exports={approveOutgoingText};
