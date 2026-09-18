const crypto=require('node:crypto');
const {assertSpaceOwner,identityError}=require('./identity');
const {normalizeCopyInput,copyKeys,loadCopySource,receiveTextCopy,commitMediaCopy}=require('./copies');
const {sourceMediaPlan,candidateFile,validateMetadata,copiedPath,busy}=require('./copyAssets');
const conflict=()=>Object.assign(new Error('接收内容或目标已变化，请重新确认'),{code:'VERSION_CONFLICT'});

// Internal orchestration only; no public dispatcher or production worker yet.
// Persist destination candidates BEFORE uploading. Attempts get unique paths,
// so a timed-out worker can never overwrite the winning worker's objects.
async function receiveMediaCopy(repo,ctx,raw,storage,{nowMs=Date.now}={}){
  if(!storage || typeof storage.copy!=='function' || typeof storage.verify!=='function')throw identityError();
  const input=normalizeCopyInput(raw),keys=copyKeys(ctx,input),token=crypto.randomBytes(16).toString('hex');
  const claimed=await repo.transaction(async tx=>{
    await assertSpaceOwner(tx,ctx);
    if((await tx.get('families',ctx.familyId))?.storyBooks?.status!=='active')throw identityError();
    const request=await tx.get('story_copy_requests',keys.requestId);
    if(request && (request.principalId!==ctx.principalId || request.fingerprint!==keys.fingerprint))throw conflict();
    const received=await tx.get('story_copies',keys.copyId);
    if(received?.status==='complete' && received.principalId===ctx.principalId && received.familyId===ctx.familyId)return {complete:true};
    const previous=await tx.get('story_copy_media',keys.copyId);
    if(previous && (previous.fingerprint!==keys.fingerprint || previous.principalId!==ctx.principalId || previous.familyId!==ctx.familyId || previous.status!=='pending'))throw conflict();
    if(previous?.leaseUntilMs>nowMs())throw busy();
    if((previous?.attempts || 0)>=5)throw Object.assign(new Error('重试次数已达上限，请取消本次图片保存'),{code:'STORY_COPY_LIMIT'});
    const source=await loadCopySource(tx,ctx,input),plan=await sourceMediaPlan(tx,ctx,input,source,keys.copyId);
    if(previous && previous.sourceDigest!==plan.sourceDigest)throw conflict();
    const assets=previous?.assets || plan.assets;
    const candidates=[...(previous?.candidates || []),...assets.filter(asset=>asset.status!=='ready').map(asset=>({photoId:asset.photoId,token,fileID:candidateFile(asset.sourceFileID,keys.copyId,token,asset.photoId)}))];
    const operation={id:keys.copyId,familyId:ctx.familyId,principalId:ctx.principalId,fingerprint:keys.fingerprint,status:'pending',sourceDigest:plan.sourceDigest,
      assets,candidates,attempts:(previous?.attempts || 0)+1,leaseToken:token,leaseUntilMs:nowMs()+120000};
    await tx.set('story_copy_media',keys.copyId,operation);return operation;
  });
  if(claimed.complete)return receiveTextCopy(repo,ctx,input);
  try{
    for(const asset of claimed.assets){
      if(asset.status==='ready')continue;
      const destination=claimed.candidates.find(candidate=>candidate.token===token && candidate.photoId===asset.photoId).fileID;
      const result=validateMetadata(await storage.copy(asset.sourceFileID,destination),destination);
      await repo.transaction(async tx=>{
        await assertSpaceOwner(tx,ctx);
        const operation=await tx.get('story_copy_media',keys.copyId);
        if(operation?.status!=='pending' || operation.leaseToken!==token || operation.leaseUntilMs<=nowMs())throw busy();
        operation.assets=operation.assets.map(item=>item.photoId===asset.photoId?{...item,...result,status:'ready'}:item);
        await tx.set('story_copy_media',keys.copyId,operation);
      });
    }
    const ready=await repo.get('story_copy_media',keys.copyId);
    if(ready?.status!=='pending' || ready.leaseToken!==token || ready.leaseUntilMs<=nowMs())throw busy();
    for(const asset of ready.assets)await storage.verify(asset);
    return await commitMediaCopy(repo,ctx,input,{mediaTicket:{token,nowMs}});
  }catch(error){
    // Release only this attempt; a newer lease/completed copy must stay intact.
    await repo.transaction(async tx=>{
      const operation=await tx.get('story_copy_media',keys.copyId);
      if(operation?.status==='pending' && operation.leaseToken===token)await tx.set('story_copy_media',keys.copyId,{...operation,leaseToken:'',leaseUntilMs:0});
    });
    throw error;
  }
}

// Explicit cancellation (pending) or removal of unused candidates (complete).
// Tombstones remain retryable: unknown/delayed upload outcomes need repeated
// cleanup by a future trusted sweeper. Never drop paths after one delete call.
async function cleanupMediaCopy(repo,ctx,operationId,storage){
  if(!/^copy-[a-f0-9]{64}$/.test(operationId || '') || typeof storage?.remove!=='function')throw identityError();
  const files=await repo.transaction(async tx=>{
    await assertSpaceOwner(tx,ctx);
    const operation=await tx.get('story_copy_media',operationId);
    if(!operation || operation.principalId!==ctx.principalId || operation.familyId!==ctx.familyId || operation.id!==operationId)throw identityError();
    const keep=new Set(operation.status==='complete'?operation.assets.map(asset=>asset.fileID):[]);
    const candidates=operation.candidates.filter(candidate=>!keep.has(candidate.fileID));
    for(const candidate of candidates){
      if(!copiedPath.test(candidate.fileID) || !candidate.fileID.includes(`/copies/${operationId}/${candidate.token}/${candidate.photoId}.jpg`))throw identityError();
    }
    if(operation.status!=='complete')await tx.set('story_copy_media',operationId,{...operation,status:'cancelled',leaseToken:'',leaseUntilMs:0});
    return [...new Set(candidates.map(candidate=>candidate.fileID))];
  });
  if(files.length)await storage.remove(files);
  return {removedCandidates:files.length};
}
module.exports={receiveMediaCopy,cleanupMediaCopy};
