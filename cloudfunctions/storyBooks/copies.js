const crypto=require('node:crypto');
const core=require('./core');
const {FAMILY_ID,assertSpaceOwner,identityError}=require('./identity');
const {evaluateStoryAccess,grantIdFor}=require('./access');
const {materializeOwnedDraft,applyBlockEdits,allowsSources,protocolError}=require('./provenance');
const {readyMedia}=require('./copyAssets');
const digest=value=>crypto.createHash('sha256').update(core.stable(value)).digest('hex');
const docId=(family,id)=>`${family}_${id}`;
const error=(code,message)=>Object.assign(new Error(message),{code});
const conflict=()=>{throw error('VERSION_CONFLICT','故事或接收请求已有变化，请刷新后重试');};
const exact=(value,fields)=>value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(key=>fields.includes(key));
const REVISION=/^revision-[a-zA-Z0-9-]{1,120}$/;
const CHAPTER=/^chapter-[a-z0-9-]{1,60}$/;

function normalize(input){
  if(!exact(input,['sourceFamilyId','sourceStoryId','sourceRevisionId','chapterIds','requestId','target']) ||
    !FAMILY_ID.test(input.sourceFamilyId || '') || !core.STORY_ID.test(input.sourceStoryId || '') || !REVISION.test(input.sourceRevisionId || '') ||
    !/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId || '') || !Array.isArray(input.chapterIds) || !input.chapterIds.length || input.chapterIds.length>30 ||
    new Set(input.chapterIds).size!==input.chapterIds.length || input.chapterIds.some(id=>typeof id!=='string' || !/^chapter-[a-z0-9-]{1,60}$/.test(id)))throw identityError();
  const target=input.target;
  if(!exact(target,target?.mode==='new'?['mode','storyId','title']:['mode','storyId','expectedVersion','expectedRevisionId']) || !core.STORY_ID.test(target.storyId || ''))throw identityError();
  if(target.mode==='new'){
    if(typeof target.title!=='string' || !target.title.trim() || target.title.trim().length>40)throw error('INVALID_INPUT','故事名称不能为空，且不能超过 40 字');
  }else if(target.mode!=='append' || !Number.isSafeInteger(target.expectedVersion) || target.expectedVersion<1 ||
    (target.expectedRevisionId!=='' && !REVISION.test(target.expectedRevisionId || '')))throw identityError();
  return {...input,chapterIds:[...input.chapterIds].sort(),target:target.mode==='new'?{...target,title:target.title.trim()}:{...target}};
}
async function loadRevision(tx,familyId,story){
  if(!REVISION.test(story.currentRevisionId || ''))throw protocolError();
  const record=await tx.get('biography_drafts',docId(familyId,story.currentRevisionId));
  if(record?.familyId!==familyId || record.storyId!==story.id || record.revision?.id!==story.currentRevisionId || record.revision.storyId!==story.id)throw protocolError();
  return record.revision;
}
function protectedDraft(draft,scope,required){
  if(draft?.provenanceVersion!==undefined)return applyBlockEdits(draft,[],{...scope,requestId:'validate-copy-draft'});
  if(required)throw protocolError();
  return materializeOwnedDraft(draft,scope);
}
function assertBounded(draft){
  // Bound one transaction/document rather than silently splitting a chapter.
  if(Buffer.byteLength(JSON.stringify(draft),'utf8')>240000)throw error('STORY_COPY_LIMIT','这份章节超过接收上限，请减少章节后重试');
}
function copyKeys(ctx,input){
  return {copyId:'copy-'+digest([ctx.principalId,input.sourceFamilyId,input.sourceStoryId,input.sourceRevisionId,input.chapterIds,'receive-text-v1']),
    requestId:'request-'+digest([ctx.principalId,input.requestId]),fingerprint:digest(input)};
}
async function loadCopySource(tx,ctx,input){
  const sourceFamily=await tx.get('families',input.sourceFamilyId),space=await tx.get('story_principal_spaces',input.sourceFamilyId);
  if(sourceFamily?.storyBooks?.status!=='active' || space?.status!=='active' || sourceFamily.ownerAccountId!==space.accountId || input.sourceFamilyId===ctx.familyId)throw identityError();
  const source=await tx.get('stories',docId(input.sourceFamilyId,input.sourceStoryId));
  if(!source || source.id!==input.sourceStoryId || source.familyId!==input.sourceFamilyId)throw identityError();
  const grant=await tx.get('story_grants',grantIdFor(input.sourceFamilyId,input.sourceStoryId,ctx.principalId));
  const permitted=action=>evaluateStoryAccess({principalId:ctx.principalId,ownerPrincipalId:space.principalId,story:source,grant,action,chapterIds:input.chapterIds});
  if(!permitted('copy'))throw identityError();
  if(source.currentRevisionId!==input.sourceRevisionId)conflict();
  const sourceRevision=await loadRevision(tx,input.sourceFamilyId,source);
  const prepared=protectedDraft(sourceRevision.draft,{familyId:input.sourceFamilyId,storyId:source.id,revisionId:sourceRevision.id},source.sourcePolicyRequired);
  const selected=prepared.chapters.filter(chapter=>input.chapterIds.includes(chapter.id));
  if(selected.length!==input.chapterIds.length)throw identityError();
  return {sourceFamily,space,source,grant,sourceRevision,selected,permitted};
}

// Internal-only until U5 closes ALL legacy export/generation paths. This is not
// wired to dispatch or advertised as a capability. ctx must be server-resolved.
// Media requires a server-issued lease and verified private copies. This final
// transaction never performs external storage I/O or drops unsupported images.
async function commitCopy(repo,ctx,raw,{now=()=>new Date().toISOString(),mediaTicket}={}){
  const input=normalize(raw),stamp=now();
  return repo.transaction(async tx=>{
    await assertSpaceOwner(tx,ctx);
    const recipient=await tx.get('families',ctx.familyId);
    if(recipient.storyBooks?.status!=='active')throw identityError();
    const {copyId,requestId,fingerprint}=copyKeys(ctx,input),request=await tx.get('story_copy_requests',requestId);
    if(request && (request.principalId!==ctx.principalId || request.fingerprint!==fingerprint))conflict();
    const received=await tx.get('story_copies',copyId);
    if(received){
      if(received.principalId!==ctx.principalId || received.familyId!==ctx.familyId || received.status!=='complete')throw identityError();
      // A completed receipt survives source revocation/deletion. Do not recreate
      // a user-deleted destination or require the original grant to replay it.
      if(!request)await tx.set('story_copy_requests',requestId,{principalId:ctx.principalId,familyId:ctx.familyId,fingerprint,copyId});
      return {ok:true,storyId:received.storyId,revisionId:received.revisionId,alreadyReceived:true};
    }
    if(request)throw protocolError();
    const sourceContext=await loadCopySource(tx,ctx,input),{space,source,grant,sourceRevision,selected,permitted}=sourceContext;
    let media;
    if(mediaTicket)media=await readyMedia(tx,ctx,input,sourceContext,copyId,fingerprint,mediaTicket);
    if(selected.some(chapter=>chapter.backdropImageId || chapter.content.some(block=>typeof block.text!=='string' && !media?.assets.some(asset=>asset.sourcePhotoId===block.photoId))))throw error('STORY_COPY_MEDIA_PENDING','这些图片尚未完成独立保留，故事没有保存');

    const targetId=docId(ctx.familyId,input.target.storyId),existing=await tx.get('stories',targetId);
    let story,base;
    if(input.target.mode==='new'){
      if(existing)conflict();
      const state=core.apply({contributions:[],stories:[],storyMigration:{status:'active'}},{action:'create',familyId:ctx.familyId,storyId:input.target.storyId,title:input.target.title,writingMode:'objective',memoryIds:[],requestId:input.requestId},stamp);
      story=state.stories[0];
      base={title:story.title,chapters:[],...core.flatten([]),sourceCount:0,generatedAt:stamp,generationMode:'local-demo',provenanceVersion:1};
    }else{
      if(!existing || existing.familyId!==ctx.familyId || existing.id!==input.target.storyId || existing.deletedAt)throw identityError();
      if(existing.version!==input.target.expectedVersion || (existing.currentRevisionId || '')!==input.target.expectedRevisionId)conflict();
      story={...existing};
      if(story.currentRevisionId){
        const revision=await loadRevision(tx,ctx.familyId,story);
        base=protectedDraft(revision.draft,{familyId:ctx.familyId,storyId:story.id,revisionId:revision.id},story.sourcePolicyRequired);
      }else{
        if(story.sourcePolicyRequired)throw protocolError();
        base={title:story.bookTitle || story.title,chapters:[],...core.flatten([]),sourceCount:0,generatedAt:stamp,generationMode:'local-demo',provenanceVersion:1};
      }
    }
    const nameId=docId(ctx.familyId,core.hash(story.title)),name=await tx.get('story_names',nameId);
    if(name && name.storyId!==story.id)throw error('DUPLICATE_TITLE','已有同名故事，请换一个名称');
    const receipts=[],receivedSources=[];
    for(const chapter of selected){
      const parents=[...new Set(chapter.content.flatMap(block=>block.sourceIds))].sort();
      if(parents.length>16 || !await allowsSources(tx,parents,'copy'))throw identityError();
      // Per-chapter receipt prevents overlapping selections from duplicating a
      // previously received chapter; reject the whole mixed selection atomically.
      const sourceId='source-'+digest([ctx.principalId,input.sourceFamilyId,source.id,sourceRevision.id,chapter.id,'receive-text-v1']);
      if(await tx.get('story_source_policies',sourceId))conflict();
      const publicPublish=permitted('publish');
      receipts.push([sourceId,{version:1,parents,permissions:{view:true,copy:true,forward:permitted('forward'),publish:publicPublish,ai:false,export:publicPublish},
        sourceFamilyId:input.sourceFamilyId,sourceStoryId:source.id,sourceRevisionId:sourceRevision.id,sourceChapterId:chapter.id,
        sourceOwnerPrincipalId:space.principalId,recipientPrincipalId:ctx.principalId,grantVersion:grant.version,createdAt:stamp}]);
      const destinationChapterId='chapter-'+digest([copyId,chapter.id]).slice(0,40);
      receivedSources.push({copyId,sourceId,destinationChapterId,sourceFamilyId:input.sourceFamilyId,sourceStoryId:source.id,
        sourceRevisionId:sourceRevision.id,sourceChapterId:chapter.id,sourceOwnerPrincipalId:space.principalId});
      base.chapters.push({id:destinationChapterId,title:chapter.title,memoryIds:[],
        content:chapter.content.map((block,index)=>({...(typeof block.text==='string'?{text:block.text}:{photoId:media.assets.find(asset=>asset.sourcePhotoId===block.photoId).photoId}),blockId:'block-'+digest([copyId,chapter.id,index]),sourceIds:[sourceId]}))});
    }
    const pendingPolicies=new Map(receipts),policyReader={get:(table,id)=>table==='story_source_policies' && pendingPolicies.has(id)?pendingPolicies.get(id):tx.get(table,id)};
    // Validate the resulting graph, not just its parents: adding a receipt must
    // not exceed depth/node limits or create a copy that cannot itself be read.
    const roots=receipts.map(([id])=>id);
    if(!await allowsSources(policyReader,roots,'copy') || !await allowsSources(policyReader,roots,'view'))throw identityError();
    Object.assign(base,core.flatten(base.chapters));
    // Reuse the same protocol validation as protected edits, including unique
    // block IDs, draft/derived-text consistency, chapter and block limits.
    base=applyBlockEdits(base,[],{familyId:ctx.familyId,storyId:story.id,requestId:input.requestId});
    core.validateDraft(base,story);assertBounded(base);
    const revisionId='revision-'+digest([copyId,story.id]);
    if(await tx.get('biography_drafts',docId(ctx.familyId,revisionId)))conflict();
    const revision={id:revisionId,storyId:story.id,memberId:'',kind:'version',label:'收入亲友章节',savedAt:stamp,sourceFingerprint:'',draft:base};
    story={...story,version:input.target.mode==='new'?1:story.version+1,currentRevisionId:revisionId,sourcePolicyRequired:true,
      receivedSources:[...(Array.isArray(story.receivedSources)?story.receivedSources:[]),...receivedSources],updatedAt:stamp};
    if(media){
      for(const asset of media.assets){
        const sourceIds=[...new Set(base.chapters.flatMap(chapter=>chapter.content.filter(block=>block.photoId===asset.photoId).flatMap(block=>block.sourceIds)))];
        await tx.set('story_copy_assets',`${ctx.familyId}__${asset.photoId}`,{familyId:ctx.familyId,storyId:story.id,photoId:asset.photoId,status:'active',sourcePolicyRequired:true,sourceIds,fileID:asset.fileID,sha256:asset.sha256,bytes:asset.bytes,operationId:copyId});
      }
      await tx.set('story_copy_media',copyId,{...media,status:'complete',leaseToken:'',leaseUntilMs:0,completedAt:stamp});
    }
    for(const [id,receipt] of receipts)await tx.set('story_source_policies',id,receipt);
    await tx.set('biography_drafts',docId(ctx.familyId,revisionId),{familyId:ctx.familyId,storyId:story.id,draftType:'story-revision',revision});
    await tx.set('story_names',nameId,{familyId:ctx.familyId,storyId:story.id,title:story.title});
    await tx.set('stories',targetId,story);
    await tx.set('story_copies',copyId,{familyId:ctx.familyId,principalId:ctx.principalId,status:'complete',storyId:story.id,revisionId,createdAt:stamp});
    await tx.set('story_copy_requests',requestId,{familyId:ctx.familyId,principalId:ctx.principalId,fingerprint,copyId});
    return {ok:true,storyId:story.id,revisionId,alreadyReceived:false};
  });
}
const receiveTextCopy=(repo,ctx,input,{now}={})=>commitCopy(repo,ctx,input,{now});
function normalizeAppend(input){
  if(!exact(input,['storyId','revisionId','expectedVersion','chapterId','text','requestId']) ||
    !core.STORY_ID.test(input.storyId || '') || !REVISION.test(input.revisionId || '') ||
    !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion<1 || !CHAPTER.test(input.chapterId || '') ||
    typeof input.text!=='string' || !input.text.trim() || input.text.length>20000 ||
    !/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId || ''))throw error('INVALID_INPUT','补充内容不完整或超过 20000 字');
  return {...input,text:input.text.trim()};
}
async function appendOwnExperience(repo,ctx,raw,{now=()=>new Date().toISOString()}={}){
  const input=normalizeAppend(raw),stamp=now();
  const operationId='copy-edit-'+digest([ctx.principalId,input.requestId]),fingerprint=digest(input);
  return repo.transaction(async tx=>{
    await assertSpaceOwner(tx,ctx);
    const family=await tx.get('families',ctx.familyId);
    if(family?.storyBooks?.status!=='active')throw identityError();
    const prior=await tx.get('story_copy_edits',operationId);
    if(prior){
      if(prior.familyId!==ctx.familyId || prior.principalId!==ctx.principalId || prior.fingerprint!==fingerprint || prior.status!=='complete')conflict();
      return {ok:true,storyId:prior.storyId,revisionId:prior.revisionId,alreadyAppended:true};
    }
    const story=await tx.get('stories',docId(ctx.familyId,input.storyId));
    if(!story || story.familyId!==ctx.familyId || story.id!==input.storyId || story.deletedAt || story.sourcePolicyRequired!==true)throw identityError();
    if(story.version!==input.expectedVersion || story.currentRevisionId!==input.revisionId)conflict();
    const current=await loadRevision(tx,ctx.familyId,story);
    const base=protectedDraft(current.draft,{familyId:ctx.familyId,storyId:story.id,revisionId:current.id},true);
    if(!base.chapters.some(chapter=>chapter.content.some(block=>block.sourceIds.length)))throw protocolError();
    const draft=applyBlockEdits(base,[{action:'appendOwn',chapterId:input.chapterId,text:input.text}],{
      familyId:ctx.familyId,storyId:story.id,requestId:input.requestId,
    });
    core.validateDraft(draft,story);assertBounded(draft);
    const revisionId='revision-'+digest([operationId,story.id]);
    if(await tx.get('biography_drafts',docId(ctx.familyId,revisionId)))conflict();
    const revision={id:revisionId,storyId:story.id,memberId:'',kind:'version',label:'补充我的经历',savedAt:stamp,sourceFingerprint:'',draft};
    await tx.set('biography_drafts',docId(ctx.familyId,revisionId),{familyId:ctx.familyId,storyId:story.id,draftType:'story-revision',revision});
    await tx.set('stories',docId(ctx.familyId,story.id),{...story,version:story.version+1,currentRevisionId:revisionId,updatedAt:stamp});
    await tx.set('story_copy_edits',operationId,{familyId:ctx.familyId,principalId:ctx.principalId,status:'complete',fingerprint,
      storyId:story.id,baseRevisionId:input.revisionId,chapterId:input.chapterId,revisionId,createdAt:stamp});
    return {ok:true,storyId:story.id,revisionId,alreadyAppended:false};
  });
}
module.exports={receiveTextCopy,appendOwnExperience,commitMediaCopy:commitCopy,normalizeCopyInput:normalize,normalizeAppendInput:normalizeAppend,copyKeys,loadCopySource};
