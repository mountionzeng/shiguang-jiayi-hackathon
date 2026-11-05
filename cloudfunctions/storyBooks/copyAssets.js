const crypto=require('node:crypto');
const core=require('./core');
const {identityError}=require('./identity');
const digest=value=>crypto.createHash('sha256').update(core.stable(value)).digest('hex');
// Match the existing story image upload limit, including PNG covers.
const MAX_BYTES=20*1024*1024;
const busy=()=>Object.assign(new Error('图片保存正在处理中，请稍后重试'),{code:'STORY_COPY_BUSY'});
const copiedPath=/^cloud:\/\/[^/]+\/story-sharing\/copies\/copy-[a-f0-9]{64}\/[a-f0-9]{32}\/photo-copy-[a-f0-9]{64}\.jpg$/;
function candidateFile(sourceFileID,operationId,token,photoId){
  const root=/^(cloud:\/\/[^/]+)\//.exec(sourceFileID)?.[1];
  const fileID=`${root}/story-sharing/copies/${operationId}/${token}/${photoId}.jpg`;
  if(!copiedPath.test(fileID))throw identityError();
  return fileID;
}
async function sourceMediaPlan(tx,ctx,input,sourceContext,copyId){
  const {storyMaterials}=require('./sharedMaterials');
  const materials=await storyMaterials(tx,sourceContext,'copy');
  const assets=materials.assets.map(asset=>({sourcePhotoId:asset.key,sourceFileID:asset.sourceFileID,
    photoId:'photo-copy-'+digest([copyId,asset.key]),status:'pending'}));
  return {assets,sourceDigest:digest([sourceContext.selected,sourceContext.source.version,sourceContext.grant,materials.digest])};
}
function validateMetadata(result,expected){
  if(!result || result.fileID!==expected || !copiedPath.test(result.fileID) || !/^[a-f0-9]{64}$/.test(result.sha256 || '') ||
    !Number.isSafeInteger(result.bytes) || result.bytes<1 || result.bytes>MAX_BYTES)throw identityError();
  return {fileID:result.fileID,sha256:result.sha256,bytes:result.bytes};
}
async function readyMedia(tx,ctx,input,sourceContext,copyId,fingerprint,ticket){
  const operation=await tx.get('story_copy_media',copyId);
  if(!operation || operation.id!==copyId || operation.principalId!==ctx.principalId || operation.familyId!==ctx.familyId || operation.fingerprint!==fingerprint ||
    operation.status!=='pending' || operation.leaseToken!==ticket.token || operation.leaseUntilMs<=ticket.nowMs())throw busy();
  const plan=await sourceMediaPlan(tx,ctx,input,sourceContext,copyId);
  if(plan.sourceDigest!==operation.sourceDigest || plan.assets.length!==operation.assets.length)throw identityError();
  for(const expected of plan.assets){
    const asset=operation.assets.find(item=>item.photoId===expected.photoId);
    if(!asset || asset.status!=='ready' || asset.sourcePhotoId!==expected.sourcePhotoId || asset.sourceFileID!==expected.sourceFileID)throw identityError();
    if(!operation.candidates.some(candidate=>candidate.photoId===asset.photoId && candidate.fileID===asset.fileID))throw identityError();
    validateMetadata(asset,asset.fileID);
    if(await tx.get('story_copy_assets',`${ctx.familyId}__${asset.photoId}`))throw identityError();
  }
  return operation;
}
module.exports={sourceMediaPlan,readyMedia,candidateFile,validateMetadata,copiedPath,busy,MAX_BYTES};
