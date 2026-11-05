const {identityError}=require('./identity');
const {allowsSources}=require('./provenance');
const {getMemory}=require('./memoryExports');
const {stable}=require('./core');
const {createHash}=require('node:crypto');
const hash=value=>createHash('sha256').update(stable(value)).digest('hex');
const fail=message=>{throw Object.assign(new Error(message),{code:'STORY_COPY_MEDIA_PENDING'});};
// Called only after the caller has authorized the selected chapters. Never scan
// all family memories or infer associations from titles.
async function storyMaterials(tx,context,action='view') {
  const {source:story,sourceFamily:family,selected}=context;
  const memoryIds=[...new Set(selected.flatMap(c=>c.memoryIds || []))];
  if(memoryIds.length>100)fail('这份故事关联材料过多，请分章节发送');
  // CloudBase permits only one in-flight operation per transaction.
  const memories=[];
  for(const id of memoryIds){
    const row=await getMemory(tx,story.familyId,id);
    if(!row || row.deletedAt)continue;
    if(row.reviewStatus!=='confirmed')fail('关联记忆尚未确认，暂时不能发送');
    if(row.sourcePolicyRequired && (!Array.isArray(row.sourceIds) || !await allowsSources(tx,row.sourceIds,action)))throw identityError();
    memories.push({id,title:row.title || '',text:row.text || '',photoIds:row.photoIds || []});
  }
  const refs=new Map();
  const add=(key,type,id,chapterId,memoryId)=>{
    if(!refs.has(key))refs.set(key,{key,type,id,chapterId,memoryId});
    else if(memoryId)refs.get(key).memoryId=memoryId;
  };
  if(story.coverImageId)add('cover:'+story.coverImageId,'image',story.coverImageId);
  for(const chapter of selected){
    if(chapter.backdropImageId)add('backdrop:'+chapter.id,'image',chapter.backdropImageId,chapter.id);
    for(const block of chapter.content)if(block.photoId)add(block.photoId,'photo',block.photoId,chapter.id);
    for(const asset of Object.values(chapter.packageAssets || {}))if(asset.photoId)add(asset.photoId,'photo',asset.photoId,chapter.id);
  }
  for(const memory of memories)for(const id of memory.photoIds)add(id,'photo',id,undefined,memory.id);
  if(refs.size>100)fail('这份故事图片过多，请分章节发送');
  const assets=[];
  for(const ref of refs.values()){
    let fileID;
    if(ref.id.startsWith('photo-copy-')){
      const row=await tx.get('story_copy_assets',`${story.familyId}__${ref.id}`);
      if(!row || row.storyId!==story.id || row.familyId!==story.familyId || row.status!=='active' || !row.sourceIds?.length || !await allowsSources(tx,row.sourceIds,action))throw identityError();
      if(!/^cloud:\/\/[^/]+\/story-sharing\/copies\/copy-[a-f0-9]{64}\/[a-f0-9]{32}\/photo-copy-[a-f0-9]{64}\.jpg$/.test(row.fileID || ''))throw identityError();
      fileID=row.fileID;
    }else if(ref.type==='image' || ref.id.startsWith('photo-ai-')){
      const imageId=ref.type==='image'?ref.id:`${story.familyId}_img_${ref.id.slice(9)}`;
      const row=await tx.get('story_images',imageId);
      if(!row || row.familyId!==story.familyId || row.deletedAtMs!==undefined || row.moderation!=='pass' ||
        !(row.storyId===story.id || (ref.memoryId && row.memoryId===ref.memoryId)) ||
        (row.sourcePolicyRequired && (!row.sourceIds?.length || !await allowsSources(tx,row.sourceIds,action))))throw identityError();
      if(ref.key.startsWith('cover:') && row.purpose!=='cover')throw identityError();
      if(ref.key.startsWith('backdrop:') && (row.purpose!=='backdrop' || row.chapterId!==ref.chapterId))throw identityError();
      fileID=row.fileID;
      if(typeof fileID!=='string' || !fileID.startsWith('cloud://') || !fileID.includes(`/story-images/${story.familyId}/`) || !/\.(jpg|jpeg|png|webp)$/.test(fileID))throw identityError();
    }else{
      const row=await tx.get('photos',`${story.familyId}__${ref.id}`);
      if(!row || row.familyId!==story.familyId || row.photoId!==ref.id || !family._openid || row._openid!==family._openid || row.deletedAt || row.sourcePolicyRequired || row.sourceIds!==undefined || row.moderation?.ok!==true || row.moderation.suggest!=='pass')throw identityError();
      fileID=row.displayFileID;
      if(typeof fileID!=='string' || !fileID.startsWith('cloud://') || !fileID.endsWith(`/user-photos/${story.familyId}/${ref.id}/display.jpg`))throw identityError();
    }
    assets.push({key:ref.key,sourceFileID:fileID});
  }
  const inheritedCover=selected.map(chapter=>chapter.packageAssets?.[chapter.packageCoverAssetId]?.photoId).find(Boolean);
  const result={memories,assets,coverKey:story.coverImageId?'cover:'+story.coverImageId:(inheritedCover || '')};
  return {...result,digest:hash(result)};
}
module.exports={storyMaterials};
