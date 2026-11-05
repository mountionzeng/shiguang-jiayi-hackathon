const OUTGOING=new Set(['sendChapter','createChapterClaimLink','returnChapter']);
async function checkOutgoingPackage(action,pkg,context,approve){
  if(!OUTGOING.has(action))return;
  if(!pkg||typeof pkg.storyTitle!=='string'||!Array.isArray(pkg.chapters)||pkg.chapters.length>30||Buffer.byteLength(JSON.stringify(pkg))>240000)throw new Error('invalid_input');
  const parts=[pkg.storyTitle,pkg.sender?.displayName||''];
  for(const chapter of pkg.chapters){
    if(typeof chapter.title!=='string'||!Array.isArray(chapter.blocks))throw new Error('invalid_input');
    parts.push(chapter.title);
    for(const block of chapter.blocks){
      if(block.type==='text'&&typeof block.text==='string')parts.push(block.text);
      else if(block.type==='image'&&(block.caption===undefined||typeof block.caption==='string'))parts.push(block.caption||'');
      else throw new Error('invalid_input');
    }
    for(const page of chapter.layout?.pages||[])parts.push(page.label||'');
  }
  if(typeof approve!=='function')throw Object.assign(new Error('分享检查暂时不可用，请稍后重试'),{code:'MODERATION_UNAVAILABLE'});
  if(await approve(parts.join('\n'),context.OPENID,'分享故事')!==true)throw Object.assign(new Error('内容未通过分享检查'),{code:'CONTENT_REJECTED'});
}
module.exports={checkOutgoingPackage};
