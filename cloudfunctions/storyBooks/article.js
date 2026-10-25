const crypto=require('node:crypto');
const core=require('./core');
const {assertSpaceOwner,identityError}=require('./identity');
const {allowsSources}=require('./provenance');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(message,code='INVALID_INPUT')=>{throw Object.assign(new Error(message),{code});};
const clone=value=>JSON.parse(JSON.stringify(value));
const blockPattern=/^block-[a-f0-9]{64}$/;
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).every(k=>keys.includes(k));
function normalize(input){
  if(!input||!/^request-[a-z0-9-]{8,100}$/.test(input.requestId||'')||!core.STORY_ID.test(input.storyId||'')||
    !/^revision-[a-zA-Z0-9-]{1,120}$/.test(input.revisionId||'')||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1)fail('保存信息不完整');
  const c=input.chapter;
  if(!exact(c,['id','title','content','layout','packageAssets'])||!/^chapter-[a-z0-9-]{1,60}$/.test(c.id||'')||typeof c.title!=='string'||c.title.length>40||!Array.isArray(c.content)||c.content.length>512)fail('文章格式不正确');
  const ids=new Set();
  for(const b of c.content){
    if(!exact(b,['blockId','parentBlockId','text','photoId'])||!blockPattern.test(b.blockId||'')||ids.has(b.blockId)||
      (b.parentBlockId!==undefined&&!blockPattern.test(b.parentBlockId))||
      !(typeof b.text==='string'&&b.photoId===undefined&&b.text.length<=20000||typeof b.photoId==='string'&&/^photo-[a-z0-9-]{1,120}$/.test(b.photoId)&&b.text===undefined))fail('文章模块不正确');
    ids.add(b.blockId);
  }
  if(!exact(c.packageAssets||{},Object.keys(c.packageAssets||{}))||Object.keys(c.packageAssets||{}).length>12)fail('图片数量超限');
  for(const [id,a] of Object.entries(c.packageAssets||{}))if(!/^asset-[a-f0-9]{32}$/.test(id)||!exact(a,['photoId','aiGenerated'])||typeof a.aiGenerated!=='boolean'||!/^photo-[a-z0-9-]{1,120}$/.test(a.photoId||''))fail('图片格式不正确');
  if(!c.layout)fail('文章排版不完整');
  core.validateChapterLayout({...c,layout:c.layout});
  const bindings=new Set();
  for(const module of c.layout.pages.flatMap(page=>page.modules)){
    const r=module.rect;if(r.x<0||r.y<0||r.x+r.width>900.01||r.y+r.height>1200.01)fail('模块超出页面');
    if(module.kind==='text'){
      const binding=module.bind.blockId||'title';if(bindings.has(binding))fail('文字模块重复');bindings.add(binding);
    } else {const r=module.crop;if(r.x<0||r.y<0||r.x+r.width>1.00001||r.y+r.height>1.00001)fail('图片裁切超出范围');}
  }
  if(Buffer.byteLength(JSON.stringify(input))>240000)fail('文章太大，请分成不同章节');
  return clone(input);
}
function moduleChanges(before,after){
  const previous=new Map(before.content.map((b,i)=>[b.blockId||'legacy-'+i,b]));
  const changes=[];
  for(const block of after.content){const old=previous.get(block.blockId);previous.delete(block.blockId);
    if(!old||old.text!==block.text||old.photoId!==block.photoId)changes.push({kind:block.photoId?'image':'text',action:old?'changed':'added',blockId:block.blockId,before:old?.text||old?.photoId||'',after:block.text||block.photoId||''});}
  for(const [blockId,old] of previous)changes.push({kind:old.photoId?'image':'text',action:'removed',blockId,before:old.text||old.photoId||'',after:''});
  if(before.title!==after.title)changes.push({kind:'title',action:'changed',before:before.title,after:after.title});
  if(core.stable(before.layout||null)!==core.stable(after.layout||null))changes.push({kind:'layout',action:'changed',before:'',after:''});
  return changes;
}
async function saveArticle(repo,ctx,raw,{approveText,approveImage,now=()=>new Date().toISOString()}={}){
  const input=normalize(raw),stamp=now(),receipt='article-'+hash([ctx.principalId,input.requestId]),fingerprint=hash(input);
  if(typeof approveText!=='function'||typeof approveImage!=='function')fail('内容检查暂时不可用','MODERATION_UNAVAILABLE');
  if(!await approveText([input.chapter.title,...input.chapter.content.map(b=>b.text||'')].join('\n'),ctx.verifiedOpenid,'文章'))fail('文字未通过内容检查','CONTENT_REJECTED');
  await repo.ensureCollection?.('story_chapter_edits');
  return repo.transaction(async tx=>{
    await assertSpaceOwner(tx,ctx);
    const prior=await tx.get('story_chapter_edits',receipt);
    if(prior){if(prior.familyId!==ctx.familyId||prior.fingerprint!==fingerprint)fail('保存请求已经改变','VERSION_CONFLICT');return prior.result;}
    const story=await tx.get('stories',`${ctx.familyId}_${input.storyId}`);
    if(!story||story.familyId!==ctx.familyId||story.deletedAt)throw identityError();
    if(story.version!==input.expectedVersion||story.currentRevisionId!==input.revisionId)fail('文章已在别处修改，请重新打开后重试','VERSION_CONFLICT');
    const row=await tx.get('biography_drafts',`${ctx.familyId}_${input.revisionId}`);
    if(!row||row.familyId!==ctx.familyId||row.storyId!==story.id)throw identityError();
    const draft=clone(row.revision.draft),before=draft.chapters.find(c=>c.id===input.chapter.id);
    if(!before)throw identityError();
    const existing=new Map(before.content.map((b,i)=>[b.blockId||'block-'+hash(['article-existing',before.id,i]),b]));
    const otherIds=new Set(draft.chapters.filter(c=>c.id!==before.id).flatMap(c=>c.content.map(b=>b.blockId)));
    const submitted=new Map(input.chapter.content.map(b=>[b.blockId,b]));
    const inherited=(id,seen=new Set())=>{
      if(seen.has(id))fail('段落来源存在循环');seen.add(id);
      const old=existing.get(id);if(old)return old.sourceIds||[];
      const item=submitted.get(id);if(!item)fail('新增段落的来源不存在');
      return item.parentBlockId?inherited(item.parentBlockId,seen):[];
    };
    const content=[];
    for(const item of input.chapter.content){
      if(otherIds.has(item.blockId))fail('模块编号重复');
      const old=existing.get(item.blockId),parent=item.parentBlockId?existing.get(item.parentBlockId):null;
      const sourceIds=inherited(item.blockId);
      if(!await allowsSources(tx,sourceIds,'view'))throw identityError();
      if(old&&((typeof old.text==='string')!==(typeof item.text==='string')))fail('不能改变已有模块的类型');
      if(item.photoId&&old?.photoId!==item.photoId&&!await approveImage(ctx,item.photoId))fail('图片未通过检查','CONTENT_REJECTED');
      content.push({...(old||{}),blockId:item.blockId,...(draft.provenanceVersion===1?{sourceIds}:{}),...(typeof item.text==='string'?{text:item.text}:{photoId:item.photoId})});
    }
    const assets=input.chapter.packageAssets||{};
    for(const [id,asset] of Object.entries(assets))if(before.packageAssets?.[id]?.photoId!==asset.photoId&&!await approveImage(ctx,asset.photoId))fail('图片未通过检查','CONTENT_REJECTED');
    for(const id of [input.chapter.layout.settings.bodyTextureAssetId,...input.chapter.layout.pages.flatMap(p=>p.modules.filter(m=>m.kind==='image').map(m=>m.assetId))].filter(Boolean))if(!assets[id])fail('排版引用了不存在的图片');
    const after={...before,title:input.chapter.title,content,layout:input.chapter.layout,packageAssets:assets};
    const changes=moduleChanges({...before,content:before.content.map((b,i)=>({...b,blockId:b.blockId||'block-'+hash(['article-existing',before.id,i])}))},after);
    draft.chapters=draft.chapters.map(c=>c.id===after.id?after:c);Object.assign(draft,core.flatten(draft.chapters));core.validateDraft(draft,story);
    if(Buffer.byteLength(JSON.stringify(draft))>240000)fail('文章太大，请分成不同章节');
    const revisionId='revision-'+hash([receipt]),version=story.version+1;
    const revision={id:revisionId,storyId:story.id,memberId:'',kind:'version',label:'自动保存',savedAt:stamp,sourceFingerprint:row.revision.sourceFingerprint||'',sourceRevisionId:input.revisionId,editedByPrincipalId:ctx.principalId,editedChapterIds:[after.id],draft};
    const result={ok:true,storyId:story.id,revisionId,version};
    await tx.set('biography_drafts',`${ctx.familyId}_${revisionId}`,{familyId:ctx.familyId,storyId:story.id,draftType:'story-revision',revision});
    await tx.set('stories',`${ctx.familyId}_${story.id}`,{...story,version,currentRevisionId:revisionId,updatedAt:stamp});
    await tx.set('story_chapter_edits',receipt,{familyId:ctx.familyId,principalId:ctx.principalId,storyId:story.id,chapterId:after.id,revisionId,sourceRevisionId:input.revisionId,createdAt:stamp,fingerprint,changes,result});
    return result;
  });
}
module.exports={saveArticle,normalizeArticle:normalize,moduleChanges};
