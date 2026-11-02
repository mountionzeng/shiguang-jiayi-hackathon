const {verifyRequest,claimNonce}=require('./core');
const {materializeOwnedDraft,applyBlockEdits,allowsSources}=require('../storyBooks/provenance');
const {canonicalJson}=require('../drinkingTimeBridge/core');
const PATH='/v1/web-import';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);

async function identity(tx,grantId,now){
  const grant=await tx.get('story_desktop_grants',grantId);
  if(grant?.kind!=='web-import'||grant.grantId!==grantId||grant.status!=='active'||
    !Number.isSafeInteger(grant.expiresAtMs)||grant.expiresAtMs<=now||
    !/^principal_[a-f0-9]{32}$/.test(grant.principalId||'')||!/^family_[0-9A-Za-z_-]{1,120}$/.test(grant.familyId||''))fail('story_access_revoked');
  const principal=await tx.get('story_principals',grant.principalId);
  const space=await tx.get('story_principal_spaces',grant.familyId);
  const family=await tx.get('families',grant.familyId);
  if(principal?.status!=='active'||principal.familyId!==grant.familyId||space?.status!=='active'||
    space.principalId!==grant.principalId||space.accountId!==principal.accountId||
    family?.ownerAccountId!==principal.accountId||family.storyBooks?.status!=='active')fail('story_access_revoked');
  return {grant,family};
}

async function load(tx,grantId,input,now){
  const {grant,family}=await identity(tx,grantId,now);
  const story=await tx.get('stories',`${grant.familyId}_${input.storyId}`);
  if(!story||story.familyId!==grant.familyId||story.id!==input.storyId||story.deletedAt||story.sourcePolicyRequired)fail('story_access_revoked');
  if(story.version!==input.version||story.currentRevisionId!==input.revisionId)fail('version_conflict');
  const record=await tx.get('biography_drafts',`${grant.familyId}_${input.revisionId}`),revision=record?.revision;
  if(record?.familyId!==grant.familyId||record.storyId!==story.id||revision?.id!==input.revisionId||revision.storyId!==story.id)fail('story_access_revoked');
  const scope={familyId:grant.familyId,storyId:story.id,revisionId:revision.id,requestId:'web-import-read'};
  const draft=revision.draft?.provenanceVersion===undefined?materializeOwnedDraft(revision.draft,scope):applyBlockEdits(revision.draft,[],scope);
  // A webpage copy must not strip restrictions carried by contributed content.
  for(const chapter of draft.chapters)for(const block of chapter.content){
    // The web editor currently has no restricted-source capability system.
    // Do not silently grant AI/publishing rights by flattening a restricted copy.
    for(const action of ['view','copy','export','ai','publish','forward'])
      if(!await allowsSources(tx,block.sourceIds,action))fail('story_access_revoked');
  }
  return {grant,family,story,revision,draft};
}

async function imageFile(tx,loaded,ref){
  const {grant,family,story}=loaded;
  if(ref.startsWith('cover:')||ref.startsWith('photo-ai-')){
    const imageId=ref.startsWith('cover:')?ref.slice(6):`${grant.familyId}_img_${ref.slice(9)}`;
    const image=await tx.get('story_images',imageId);
    if(!image||image.familyId!==grant.familyId||image.storyId!==story.id||image.deletedAtMs!==undefined||image.moderation!=='pass'||
      image.sourcePolicyRequired||image.sourceIds!==undefined||!String(image.fileID||'').startsWith('cloud://')||
      !image.fileID.includes(`/story-images/${grant.familyId}/${story.id}/`)||!/\.(jpg|jpeg|png|webp)$/.test(image.fileID))return null;
    if(ref.startsWith('cover:')&&(story.coverImageId!==imageId||image.purpose!=='cover'))return null;
    return image.fileID;
  }
  if(ref.startsWith('photo-copy-')){
    const asset=await tx.get('story_copy_assets',`${grant.familyId}__${ref}`),{copiedPath}=require('../storyBooks/copyAssets');
    if(!asset||asset.familyId!==grant.familyId||asset.storyId!==story.id||asset.photoId!==ref||asset.status!=='active'||
      !Array.isArray(asset.sourceIds)||!asset.sourceIds.length||
      !copiedPath.test(asset.fileID||'')||!asset.fileID.includes(`/copies/${asset.operationId}/`))return null;
    for(const action of ['view','copy','export','ai','publish','forward'])
      if(!await allowsSources(tx,asset.sourceIds,action))return null;
    return asset.fileID;
  }
  const photo=await tx.get('photos',`${grant.familyId}__${ref}`);
  if(!photo||photo.familyId!==grant.familyId||photo.photoId!==ref||!family._openid||photo._openid!==family._openid||photo.deletedAt||
    photo.sourcePolicyRequired||photo.sourceIds!==undefined||photo.moderation?.ok!==true||photo.moderation.suggest!=='pass'||
    !String(photo.displayFileID||'').startsWith('cloud://')||!photo.displayFileID.endsWith(`/user-photos/${grant.familyId}/${ref}/display.jpg`))return null;
  return photo.displayFileID;
}

async function webImport(repo,request,options){
  const verified=verifyRequest(request,options,PATH,['grantId','operation','cursor','storyId','revisionId','version','mediaRef']);
  await repo.transaction(tx=>claimNonce(tx,verified.timestampMs,verified.nonce));
  const input=request.body;
  if(input.operation==='list'){
    if(Object.keys(input).some(k=>!['grantId','operation','cursor'].includes(k))||!Number.isSafeInteger(input.cursor)||input.cursor<0||input.cursor>10000)fail('invalid_input');
    const {grant}=await repo.transaction(tx=>identity(tx,verified.grantId,options.now()));
    const rows=await repo.listStories(grant.familyId,input.cursor,51);
    await repo.transaction(tx=>identity(tx,verified.grantId,options.now()));
    return {stories:rows.slice(0,50).filter(s=>!s.deletedAt&&!s.sourcePolicyRequired&&s.familyId===grant.familyId&&s.currentRevisionId)
      .map(s=>({storyId:s.id,revisionId:s.currentRevisionId,version:s.version,title:String(s.title||s.bookTitle||'未命名故事'),updatedAt:String(s.updatedAt||'')})),
      nextCursor:rows.length>50?input.cursor+50:null};
  }
  if(!['read','media'].includes(input.operation)||!/^story-[a-z0-9-]{1,100}$/.test(input.storyId||'')||
    !/^revision-[a-zA-Z0-9-]{1,120}$/.test(input.revisionId||'')||!Number.isSafeInteger(input.version)||input.version<1||
    input.cursor!==undefined||(input.operation==='read'&&input.mediaRef!==undefined))fail('invalid_input');
  if(input.operation==='media'){
    if(typeof input.mediaRef!=='string'||input.mediaRef.length>240)fail('invalid_input');
    const descriptor=async()=>repo.transaction(async tx=>{
      const loaded=await load(tx,verified.grantId,input,options.now());
      const refs=loaded.draft.chapters.flatMap(c=>c.content.flatMap(b=>b.photoId?[b.photoId]:[]));
      if(loaded.story.coverImageId)refs.push('cover:'+loaded.story.coverImageId);
      if(!refs.includes(input.mediaRef))fail('story_access_revoked');
      const fileID=await imageFile(tx,loaded,input.mediaRef);
      if(!fileID)fail('media_unavailable');
      return {fileID,version:loaded.story.version,revisionId:loaded.revision.id};
    });
    const before=await descriptor(),bytes=Buffer.from(await options.download(before.fileID));
    if(bytes.length>2*1024*1024||bytes.length===0)fail('media_too_large');
    if(!same(before,await descriptor()))fail('version_conflict');
    return {base64:bytes.toString('base64')};
  }
  return repo.transaction(async tx=>{
    const loaded=await load(tx,verified.grantId,input,options.now()),{story,revision,draft}=loaded;
    const warnings=new Set(),chapters=[];
    const photo=async ref=>{const available=Boolean(await imageFile(tx,loaded,ref));if(!available)warnings.add('部分图片仅存于微信本机或无法导出，网页将保留原位置提示。');return {ref,available};};
    for(const chapter of draft.chapters){
      const modules=chapter.layout?.pages?.flatMap(p=>p.modules)||[];
      if(chapter.layout||chapter.backdropImageId)warnings.add('文字字号尽量保留；微信分页、底图与自由布局会按网页书稿重新排布。');
      const content=[];
      for(const block of chapter.content){
        const style=modules.find(m=>m.kind==='text'&&m.bind?.blockId===block.blockId);
        content.push({id:block.blockId,...(typeof block.text==='string'?{text:block.text}:{photo:await photo(block.photoId)}),
          sourceIds:block.sourceIds,...(Number.isFinite(style?.fontSize)?{fontSize:Math.max(12,Math.min(120,style.fontSize))}:{})});
      }
      chapters.push({id:chapter.id,title:chapter.title||'',content});
    }
    const cover=story.coverImageId?await photo('cover:'+story.coverImageId):null;
    const result={storyId:story.id,revisionId:revision.id,version:story.version,title:String(draft.title||story.title||'未命名故事'),
      updatedAt:String(story.updatedAt||revision.savedAt||''),chapters,cover,
      containsAiText:draft.generationMode==='cloud-ai'||draft.chapters.some(c=>c.containsAiText||c.generationMode==='cloud-ai'),
      ...(revision.editorName?{editorName:revision.editorName}:{}),...(revision.receivedFromName?{receivedFromName:revision.receivedFromName}:{}),
      ...(revision.changeSummary?{changeSummary:revision.changeSummary}:{}),warnings:[...warnings]};
    if(Buffer.byteLength(JSON.stringify(result))>600000)fail('payload_too_large');
    return result;
  });
}
module.exports={webImport,PATH};
