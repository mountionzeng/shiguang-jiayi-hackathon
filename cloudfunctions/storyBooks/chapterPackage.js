const crypto=require('node:crypto');
const core=require('./core');
const {assertSpaceOwner,identityError}=require('./identity');
const {applyBlockEdits,materializeOwnedDraft,protocolError,allowsSources}=require('./provenance');
const digest=value=>crypto.createHash('sha256').update(core.stable(value)).digest('hex');
const docId=(family,id)=>`${family}_${id}`;
const error=(code,message)=>Object.assign(new Error(message),{code});
const conflict=()=>{throw error('VERSION_CONFLICT','故事已有变化，请刷新后重试');};
const BLOCK=/^block-[a-f0-9]{64}$/,CHAPTER=/^chapter-[a-z0-9-]{1,60}$/,REQUEST=/^[a-zA-Z0-9-]{8,100}$/,PHOTO=/^photo-[a-z0-9-]{1,120}$/,
  ASSET=/^asset-[a-f0-9]{32}$/;
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>fields.includes(key));
const invalid=message=>error('INVALID_INPUT',message||'章节包内容无效');
// 客户端用 fromChapterPackage 校验并拆包后，只把这些字段交给云函数；云函数再独立校验一次。
function normalize(input){
  if(!exact(input,['requestId','target','chapter','layout','origin','packageId','senderName','lineage','assets','assetPhotos','coverAssetId'])||!REQUEST.test(input.requestId||'')||!input.target)throw invalid();
  if(typeof input.packageId!=='string'||!/^cp_[a-zA-Z0-9-]{8,64}$/.test(input.packageId)||typeof input.senderName!=='string'||input.senderName.length>40)throw invalid();
  if(!exact(input.lineage,['rootPackageId','parentPackageId'])||!/^cp_[a-zA-Z0-9-]{8,64}$/.test(input.lineage.rootPackageId||'')||
    !(input.lineage.parentPackageId===null||/^cp_[a-zA-Z0-9-]{8,64}$/.test(input.lineage.parentPackageId||'')))throw invalid();
  if(!Array.isArray(input.assets)||input.assets.length>12||!input.assetPhotos||typeof input.assetPhotos!=='object'||Array.isArray(input.assetPhotos))throw invalid();
  const assetIds=new Set();
  for(const asset of input.assets){
    if(!exact(asset,['assetId','mime','bytes','sha256','width','height','aiGenerated'])||!ASSET.test(asset.assetId||'')||assetIds.has(asset.assetId)||
      !['image/jpeg','image/png','image/webp'].includes(asset.mime)||!Number.isSafeInteger(asset.bytes)||asset.bytes<1||asset.bytes>2*1024*1024||
      !/^[a-f0-9]{64}$/.test(asset.sha256||'')||!Number.isSafeInteger(asset.width)||asset.width<1||asset.width>20000||
      !Number.isSafeInteger(asset.height)||asset.height<1||asset.height>20000||typeof asset.aiGenerated!=='boolean')throw invalid();
    assetIds.add(asset.assetId);
  }
  if(Object.keys(input.assetPhotos).length!==assetIds.size||[...assetIds].some(id=>!PHOTO.test(input.assetPhotos[id]||''))||
    Object.keys(input.assetPhotos).some(id=>!assetIds.has(id))||input.assets.reduce((sum,asset)=>sum+asset.bytes,0)>8*1024*1024)throw invalid();
  if(input.coverAssetId!==null&&(!ASSET.test(input.coverAssetId||'')||!assetIds.has(input.coverAssetId)))throw invalid();
  const t=input.target;
  if(t.mode==='new'){if(!exact(t,['mode','storyId','title'])||!core.STORY_ID.test(t.storyId||'')||typeof t.title!=='string'||!t.title.trim()||t.title.trim().length>40)throw invalid();}
  else if(t.mode==='append'){if(!exact(t,['mode','storyId','expectedVersion','expectedRevisionId'])||!core.STORY_ID.test(t.storyId||'')||!Number.isSafeInteger(t.expectedVersion)||t.expectedVersion<1||typeof t.expectedRevisionId!=='string')throw invalid();}
  else throw invalid();
  const c=input.chapter;
  if(!exact(c,['id','title','content','containsAiText'])||!CHAPTER.test(c.id||'')||typeof c.title!=='string'||c.title.length>40||typeof c.containsAiText!=='boolean'||!Array.isArray(c.content)||!c.content.length||c.content.length>512)throw invalid();
  const seen=new Set();
  for(const item of c.content){
    if(!exact(item,['text','photoId','blockId'])||!BLOCK.test(item.blockId||'')||seen.has(item.blockId))throw invalid();
    seen.add(item.blockId);
    const isText=typeof item.text==='string'&&item.photoId===undefined,isPhoto=typeof item.photoId==='string'&&PHOTO.test(item.photoId)&&item.text===undefined;
    if(!isText&&!isPhoto)throw invalid();
  }
  if(input.layout!==null&&input.layout!==undefined){
    core.validateChapterLayout({...c,layout:input.layout});
    const layoutAssets=[input.layout.settings.bodyTextureAssetId,...input.layout.pages.flatMap(page=>page.modules.filter(m=>m.kind==='image').map(m=>m.assetId))].filter(Boolean);
    for(const id of layoutAssets)if(!input.assetPhotos[id])throw invalid('排版图片没有对应的本地审核照片');
    if(input.layout.settings.includeCover&&!input.coverAssetId)throw invalid('章节包封面图片没有对应资产');
  }
  if(input.assets.some(asset=>!input.assetPhotos[asset.assetId])||c.content.some(item=>item.photoId&&!Object.values(input.assetPhotos).includes(item.photoId)))throw invalid('正文图片没有对应的章节包资产');
  if(c.content.reduce((n,b)=>n+(b.text?.length||0),0)>20000)throw invalid('正文最多 20000 字');
  if(Buffer.byteLength(JSON.stringify(input),'utf8')>240000)throw error('STORY_COPY_LIMIT','这份章节超过接收上限，请减少章节后重试');
  if(input.origin!==undefined&&(!exact(input.origin,['storyId','chapterId'])||!core.STORY_ID.test(input.origin.storyId||'')||!CHAPTER.test(input.origin.chapterId||'')))throw invalid();
  return input;
}
async function loadRevision(tx,familyId,story){
  const row=await tx.get('biography_drafts',docId(familyId,story.currentRevisionId));
  if(!row||row.familyId!==familyId||row.storyId!==story.id||row.revision?.id!==story.currentRevisionId)throw protocolError();
  return row.revision;
}
/*
 * 从章节包导入：留下成新故事，或作为一章加入已有故事。
 * 从网页来的文字没有经过微信内容安全检查，所以写入之前必须逐段检查；
 * 检测服务故障与内容违规都不导入（故障由 approveText 抛 MODERATION_UNAVAILABLE）。
 * 图片只接受已经过检查并登记在本人名下的 photoId，网页图片字节落地留给文档06。
 */
async function importChapterPackage(repo,ctx,raw,{now=()=>new Date().toISOString(),approveText,approveImage}={}){
  const input=normalize(raw),stamp=now();
  if(typeof approveText!=='function'||typeof approveImage!=='function')throw error('MODERATION_UNAVAILABLE','内容安全检测暂时不可用，请稍后再试');
  for(const photoId of new Set(Object.values(input.assetPhotos)))if(await approveImage(ctx,photoId)!==true)throw error('CONTENT_REJECTED','这一章里有图片没有通过检查，没有导入');
  const texts=[input.chapter.title,input.senderName,...(input.target.mode==='new'?[input.target.title]:[]),
    ...(input.layout?input.layout.pages.map(page=>page.label):[]),...input.chapter.content.filter(i=>typeof i.text==='string').map(i=>i.text)];
  // createTextModerator owns chunking. Keep adjacent lines together and avoid
  // making a remote moderation call for every individual line.
  if(await approveText(texts.join('\n'),ctx.verifiedOpenid,'章节包')!==true)throw error('CONTENT_REJECTED','这一章里有内容没有通过内容安全检测，没有导入');
  const requestKey='request-'+digest([ctx.principalId,input.requestId,'chapter-package']);
  const packageDigest=digest({chapter:input.chapter,layout:input.layout||null,target:input.target,origin:input.origin||null,packageId:input.packageId,
    senderName:input.senderName,lineage:input.lineage,assets:input.assets,assetPhotos:input.assetPhotos,coverAssetId:input.coverAssetId});
  const copyId='copy-'+digest([ctx.principalId,input.packageId,input.chapter.id,input.target.mode,input.target.storyId,'chapter-package-v1']);
  return repo.transaction(async tx=>{
    await assertSpaceOwner(tx,ctx);
    const family=await tx.get('families',ctx.familyId);
    if(family?.storyBooks?.status!=='active')throw identityError();
    const request=await tx.get('story_copy_requests',requestKey);
    if(request){
      if(request.familyId!==ctx.familyId||request.principalId!==ctx.principalId||request.fingerprint!==packageDigest)conflict();
      const done=await tx.get('story_copies',request.copyId);
      if(!done||done.familyId!==ctx.familyId||done.principalId!==ctx.principalId||done.status!=='complete'||done.storyId!==input.target.storyId)throw protocolError();
      return {ok:true,storyId:done.storyId,revisionId:done.revisionId,chapterId:request.chapterId,alreadyReceived:true};
    }
    if(await tx.get('story_copies',copyId))conflict();
    const targetId=docId(ctx.familyId,input.target.storyId),existing=await tx.get('stories',targetId);
    let story,base;
    if(input.target.mode==='new'){
      if(existing)conflict();
      const state=core.apply({contributions:[],stories:[],storyMigration:{status:'active'}},{action:'create',familyId:ctx.familyId,storyId:input.target.storyId,title:input.target.title,writingMode:'objective',memoryIds:[],requestId:input.requestId},stamp);
      story=state.stories[0];
      base={title:story.title,chapters:[],...core.flatten([]),sourceCount:0,generatedAt:stamp,generationMode:'local-demo',provenanceVersion:1};
    }else{
      if(!existing||existing.familyId!==ctx.familyId||existing.id!==input.target.storyId||existing.deletedAt)throw identityError();
      if(existing.version!==input.target.expectedVersion||(existing.currentRevisionId||'')!==input.target.expectedRevisionId)conflict();
      story={...existing};
      if(story.currentRevisionId){
        const current=await loadRevision(tx,ctx.familyId,story);
        if(current.draft?.provenanceVersion!==undefined)base=applyBlockEdits(current.draft,[],{familyId:ctx.familyId,storyId:story.id,requestId:input.requestId});
        else{
          if(story.sourcePolicyRequired)throw protocolError();
          base=materializeOwnedDraft(current.draft,{familyId:ctx.familyId,storyId:story.id,revisionId:current.id});
        }
      }else{
        if(story.sourcePolicyRequired)throw protocolError();
        base={title:story.bookTitle||story.title,chapters:[],...core.flatten([]),sourceCount:0,generatedAt:stamp,generationMode:'local-demo',provenanceVersion:1};
      }
    }
    const nameId=docId(ctx.familyId,core.hash(story.title)),name=await tx.get('story_names',nameId);
    if(name&&name.storyId!==story.id)throw error('DUPLICATE_TITLE','已有同名故事，请换一个名称');
    const chapterId='chapter-'+digest([copyId,input.chapter.id]).slice(0,40);
    if(base.chapters.some(c=>c.id===chapterId))conflict();
    // 导入的块带一个来源凭据，发回时只会带上用户之后自己新写的部分，不会把原文再发一遍。
    const sourceId='source-'+digest([copyId,'chapter-package-v1']);
    // 同一个故事里块编号必须唯一：包里的编号已被占用时（例如把同一份内容再导入一次），按本次导入重新派生，
    // 并同步改写排版里的引用。
    const taken=new Set(base.chapters.flatMap(c=>c.content.map(b=>b.blockId))),idMap=new Map();
    const reserved=new Set([...taken,...input.chapter.content.map(item=>item.blockId)]);
    for(const item of input.chapter.content){
      let id=item.blockId,salt=0;
      if(taken.has(id)){do{id='block-'+digest([copyId,item.blockId,'rekey',salt++]);}while(reserved.has(id));}
      reserved.add(id);idMap.set(item.blockId,id);
    }
    const layout=input.layout?{...input.layout,pages:input.layout.pages.map(page=>({...page,modules:(page.modules||[]).map(m=>
      m.kind==='text'&&m.bind&&m.bind.blockId!==undefined?{...m,bind:{...m.bind,blockId:idMap.get(m.bind.blockId)}}:m)}))}:null;
    const packageSourceBlockIds={},packageBlockDigests={};
    input.chapter.content.forEach(item=>{if(typeof item.text==='string'){
      const savedId=idMap.get(item.blockId);packageSourceBlockIds[savedId]=item.blockId;
      packageBlockDigests[savedId]=digest(item.text.replace(/\r\n?/g,'\n').replace(/\n$/,''));
    }});
    const chapter={id:chapterId,title:input.chapter.title,memoryIds:[],content:input.chapter.content.map(item=>({...item,blockId:idMap.get(item.blockId),sourceIds:[sourceId]})),
      packageLineage:{rootPackageId:input.lineage.rootPackageId,receivedPackageId:input.packageId},
      ...(input.chapter.containsAiText?{containsAiText:true}:{}),...(layout?{layout}:{}),
      packageSourceBlockIds,packageBlockDigests,
      ...(input.assets.length?{packageAssets:Object.fromEntries(input.assets.map(asset=>[asset.assetId,{photoId:input.assetPhotos[asset.assetId],aiGenerated:asset.aiGenerated}]))}:{}),
      ...(input.coverAssetId?{packageCoverAssetId:input.coverAssetId}:{})};
    base.chapters.push(chapter);Object.assign(base,core.flatten(base.chapters));
    base=applyBlockEdits(base,[],{familyId:ctx.familyId,storyId:story.id,requestId:input.requestId});
    core.validateDraft(base,story);
    if(Buffer.byteLength(JSON.stringify(base),'utf8')>240000)throw error('STORY_COPY_LIMIT','这份章节超过接收上限，请减少章节后重试');
    const revisionId='revision-'+digest([copyId,story.id,'chapter-package']);
    if(await tx.get('biography_drafts',docId(ctx.familyId,revisionId)))conflict();
    const revision={id:revisionId,storyId:story.id,memberId:'',kind:'version',label:'导入章节包',savedAt:stamp,sourceFingerprint:'',draft:base};
    // 回信路由只在原章节属于本账号的同账号闭环里建立；跨账号投递留给文档06。
    const route=input.origin?{sourceFamilyId:ctx.familyId,sourceStoryId:input.origin.storyId,sourceChapterId:input.origin.chapterId,destinationChapterId:chapterId,
      sourceOwnerPrincipalId:ctx.principalId,senderName:String(input.senderName||'').slice(0,30),senderMemberId:''}:null;
    if(route){
      const origin=await tx.get('stories',docId(ctx.familyId,input.origin.storyId));
      if(!origin||origin.familyId!==ctx.familyId||origin.deletedAt||!origin.currentRevisionId)throw identityError();
      const original=await loadRevision(tx,ctx.familyId,origin);
      if(!original.draft?.chapters?.some(c=>c.id===input.origin.chapterId))throw identityError();
    }
    story={...story,version:input.target.mode==='new'?1:story.version+1,currentRevisionId:revisionId,sourcePolicyRequired:true,
      receivedSources:[...(Array.isArray(story.receivedSources)?story.receivedSources:[]),...(route?[route]:[])],updatedAt:stamp};
    await tx.set('biography_drafts',docId(ctx.familyId,revisionId),{familyId:ctx.familyId,storyId:story.id,draftType:'story-revision',revision});
    await tx.set('story_source_policies',sourceId,{version:1,parents:[],permissions:{view:true,copy:false,forward:false,publish:false,ai:false,export:false},
      recipientPrincipalId:ctx.principalId,createdAt:stamp});
    await tx.set('stories',targetId,story);
    await tx.set('story_names',nameId,{familyId:ctx.familyId,storyId:story.id,title:story.title});
    await tx.set('story_copies',copyId,{familyId:ctx.familyId,principalId:ctx.principalId,status:'complete',storyId:story.id,revisionId,createdAt:stamp});
    await tx.set('story_copy_requests',requestKey,{familyId:ctx.familyId,principalId:ctx.principalId,fingerprint:packageDigest,copyId,chapterId});
    return {ok:true,storyId:story.id,revisionId,chapterId,alreadyReceived:false};
  });
}
function normalizeRevision(input){
  if(!exact(input,['requestId','storyId','revisionId','expectedVersion','chapterId','edits','layout'])||!REQUEST.test(input.requestId||'')||
    !core.STORY_ID.test(input.storyId||'')||!/^revision-[a-zA-Z0-9-]{1,120}$/.test(input.revisionId||'')||!Number.isSafeInteger(input.expectedVersion)||
    input.expectedVersion<1||!CHAPTER.test(input.chapterId||'')||!Array.isArray(input.edits)||input.edits.length>128||
    (input.layout!==null&&input.layout!==undefined&&typeof input.layout!=='object'))throw invalid('章节修订信息不完整');
  const ids=new Set();
  for(const edit of input.edits){
    if(!exact(edit,['blockId','text'])||!BLOCK.test(edit.blockId||'')||ids.has(edit.blockId)||typeof edit.text!=='string'||edit.text.length>20000)throw invalid('章节修订块无效');
    const line=edit.text.replace(/\r\n?/g,'\n').replace(/\n$/,'');if(line.includes('\n'))throw invalid('每次只能修订一个文字模块');
    edit.text=line+'\n';ids.add(edit.blockId);
  }
  return input;
}
async function reviseReceivedChapter(repo,ctx,raw,{now=()=>new Date().toISOString(),approveText}={}){
  const input=normalizeRevision(raw),stamp=now();
  if(typeof approveText!=='function')throw error('MODERATION_UNAVAILABLE','内容安全检测暂时不可用，请稍后再试');
  const reviewTexts=[...input.edits.map(edit=>edit.text),...(input.layout?.pages||[]).map(page=>page.label)];
  if(reviewTexts.length&&await approveText(reviewTexts.join('\n'),ctx.verifiedOpenid,'章节修订')!==true)
    throw error('CONTENT_REJECTED','修改后的文字没有通过内容安全检测，没有保存');
  const requestKey='chapter-edit-'+digest([ctx.principalId,input.requestId]),fingerprint=digest(input);
  return repo.transaction(async tx=>{
    await assertSpaceOwner(tx,ctx);
    const prior=await tx.get('story_chapter_edits',requestKey);
    if(prior){if(prior.familyId!==ctx.familyId||prior.principalId!==ctx.principalId||prior.fingerprint!==fingerprint)conflict();
      return {ok:true,storyId:prior.storyId,revisionId:prior.revisionId,chapterId:prior.chapterId,version:prior.version,alreadySaved:true};}
    const story=await tx.get('stories',docId(ctx.familyId,input.storyId));
    if(!story||story.familyId!==ctx.familyId||story.deletedAt||story.sourcePolicyRequired!==true||story.version!==input.expectedVersion||story.currentRevisionId!==input.revisionId)conflict();
    const current=await loadRevision(tx,ctx.familyId,story),chapter=current.draft?.chapters?.find(item=>item.id===input.chapterId);
    if(!chapter||current.draft.provenanceVersion!==1)throw protocolError();
    const protectedBlocks=chapter.content.filter(block=>typeof block.text==='string'&&block.sourceIds?.length);
    if(!input.edits.length&&!protectedBlocks.length)throw protocolError();
    if(input.layout!==undefined)for(const block of protectedBlocks)if(!await allowsSources(tx,block.sourceIds,'view'))throw protocolError();
    for(const edit of input.edits){
      const block=chapter.content.find(item=>item.blockId===edit.blockId);
      if(!block||typeof block.text!=='string'||!block.sourceIds?.length||!await allowsSources(tx,block.sourceIds,'view'))throw protocolError();
    }
    let draft=applyBlockEdits(current.draft,input.edits.map(edit=>({action:'edit',blockId:edit.blockId,text:edit.text})),
      {familyId:ctx.familyId,storyId:story.id,requestId:input.requestId});
    const revised=draft.chapters.find(item=>item.id===input.chapterId);
    if(input.layout!==undefined){
      if(input.layout===null)delete revised.layout;
      else {
        core.validateChapterLayout({...revised,layout:input.layout});
        const ids=[input.layout.settings.bodyTextureAssetId,...input.layout.pages.flatMap(page=>page.modules.filter(module=>module.kind==='image').map(module=>module.assetId))].filter(Boolean);
        if(ids.some(id=>!revised.packageAssets?.[id])||(input.layout.settings.includeCover&&!revised.packageCoverAssetId))throw invalid('排版图片不属于这份章节副本');
        revised.layout=input.layout;
      }
    }
    Object.assign(draft,core.flatten(draft.chapters));core.validateDraft(draft,story);
    if(Buffer.byteLength(JSON.stringify(draft),'utf8')>240000)throw error('STORY_COPY_LIMIT','这份章节超过接收上限，请减少章节后重试');
    const revisionId='revision-'+digest([ctx.principalId,input.requestId,'chapter-revision']);
    if(await tx.get('biography_drafts',docId(ctx.familyId,revisionId)))conflict();
    const version=story.version+1;
    await tx.set('biography_drafts',docId(ctx.familyId,revisionId),{familyId:ctx.familyId,storyId:story.id,draftType:'story-revision',revision:{
      id:revisionId,storyId:story.id,memberId:'',kind:'version',label:'修改章节副本',savedAt:stamp,sourceFingerprint:'',draft}});
    await tx.set('stories',docId(ctx.familyId,story.id),{...story,version,currentRevisionId:revisionId,sourcePolicyRequired:true,updatedAt:stamp});
    await tx.set('story_chapter_edits',requestKey,{familyId:ctx.familyId,principalId:ctx.principalId,fingerprint,storyId:story.id,revisionId,chapterId:input.chapterId,version,createdAt:stamp});
    return {ok:true,storyId:story.id,revisionId,chapterId:input.chapterId,version,alreadySaved:false};
  });
}
module.exports={importChapterPackage,normalizeChapterPackageInput:normalize,reviseReceivedChapter,normalizeChapterRevisionInput:normalizeRevision};
