const {assertCurrentIdentity,identityError,FAMILY_ID}=require('./identity');
const {evaluateStoryAccess,grantIdFor}=require('./access');
const {allowsSources}=require('./provenance');
const deny=()=>{throw identityError();};
async function descriptor(repo,ctx,input){
  if(!input || !FAMILY_ID.test(input.familyId || '') || !/^story-[a-z0-9-]{1,100}$/.test(input.storyId || '') ||
    !/^chapter-[a-z0-9-]{1,60}$/.test(input.chapterId || '') || !/^photo-[a-z0-9-]{1,80}$/.test(input.photoId || '') || input.purpose!=='view')deny();
  return repo.transaction(async tx=>{
    await assertCurrentIdentity(tx,ctx);
    const family=await tx.get('families',input.familyId),space=await tx.get('story_principal_spaces',input.familyId);
    if(family?.storyBooks?.status!=='active' || space?.status!=='active' || family.ownerAccountId!==space.accountId)deny();
    const story=await tx.get('stories',`${input.familyId}_${input.storyId}`);
    if(!story || story.familyId!==input.familyId || story.id!==input.storyId || story.deletedAt)deny();
    const grant=await tx.get('story_grants',grantIdFor(input.familyId,input.storyId,ctx.principalId));
    if(!evaluateStoryAccess({principalId:ctx.principalId,ownerPrincipalId:space.principalId,story,grant,action:'read',chapterIds:[input.chapterId]}))deny();
    if(!/^revision-[a-zA-Z0-9-]{1,120}$/.test(story.currentRevisionId || ''))deny();
    const record=await tx.get('biography_drafts',`${input.familyId}_${story.currentRevisionId}`);
    if(record?.familyId!==input.familyId || record.storyId!==input.storyId || record.revision?.id!==story.currentRevisionId || record.revision.storyId!==input.storyId)deny();
    const draft=record.revision.draft,chapter=draft?.chapters?.find(c=>c.id===input.chapterId);
    const blocks=chapter?.content?.filter(b=>b.photoId===input.photoId);
    if(!blocks?.length)deny();
    if(story.sourcePolicyRequired && draft.provenanceVersion!==1)deny();
    for(const block of blocks){
      if((draft.provenanceVersion!==undefined || block.sourceIds!==undefined) &&
        (draft.provenanceVersion!==1 || !Array.isArray(block.sourceIds) || !await allowsSources(tx,block.sourceIds,'view')))deny();
    }
    if(input.photoId.startsWith('photo-copy-')){
      const asset=await tx.get('story_copy_assets',`${input.familyId}__${input.photoId}`);
      const {copiedPath}=require('./copyAssets');
      if(!asset || asset.familyId!==input.familyId || asset.storyId!==input.storyId || asset.photoId!==input.photoId || asset.status!=='active' ||
        asset.sourcePolicyRequired!==true || !Array.isArray(asset.sourceIds) || !asset.sourceIds.length || !await allowsSources(tx,asset.sourceIds,'view') ||
        !copiedPath.test(asset.fileID || '') || !asset.fileID.includes(`/copies/${asset.operationId}/`))deny();
      return {fileID:asset.fileID,revisionId:story.currentRevisionId,storyVersion:story.version,grantVersion:grant?.version || 0};
    }
    const photo=await tx.get('photos',`${input.familyId}__${input.photoId}`);
    // Original uploaded photos only. AI/backdrop and cross-family retained copies
    // need their own verified asset bindings; do not infer them from a path.
    if(!photo || photo.familyId!==input.familyId || photo.photoId!==input.photoId || !family._openid || photo._openid!==family._openid ||
      photo.deletedAt || photo.sourcePolicyRequired || photo.sourceIds!==undefined || photo.moderation?.ok!==true || photo.moderation.suggest!=='pass')deny();
    const fileID=photo.displayFileID;
    if(typeof fileID!=='string' || !fileID.startsWith('cloud://') || !fileID.endsWith(`/user-photos/${input.familyId}/${input.photoId}/display.jpg`))deny();
    return {fileID,revisionId:story.currentRevisionId,storyVersion:story.version,grantVersion:grant?.version || 0};
  });
}
async function readStoryMedia(repo,ctx,input,sign){
  if(typeof sign!=='function')deny();
  const before=await descriptor(repo,ctx,input);
  const url=await sign(before.fileID,300);
  if(typeof url!=='string' || !url.startsWith('https://'))deny();
  // Signing happens outside the DB transaction; recheck before releasing bytes.
  const after=await descriptor(repo,ctx,input);
  if(JSON.stringify(before)!==JSON.stringify(after))deny();
  return {photoId:input.photoId,purpose:'view',url,requestedMaxAgeSeconds:300};
}
module.exports={readStoryMedia};
