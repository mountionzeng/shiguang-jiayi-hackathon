const crypto = require('node:crypto');
const { canonicalJson } = require('../drinkingTimeBridge/core');
const { materializeOwnedDraft, applyBlockEdits, allowsSources, protocolError } = require('../storyBooks/provenance');

const READ_PATH = '/v1/story/read';
const WRITE_PATH = '/v1/story/write';
const MEDIA_PATH = '/v1/story/media';
const CARD_PATH = '/v1/story/card';
const GRANT = /^desktop-grant-[a-f0-9]{64}$/;
const NONCE = /^[0-9A-Za-z_-]{16,64}$/;
const SIGNATURE = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function sign(secret, timestamp, nonce, body, path=READ_PATH) {
  return crypto.createHmac('sha256', secret).update(`POST\n${path}\n${timestamp}\n${nonce}\n${canonicalJson(body)}`).digest('hex');
}

function verifyRequest(request, { secret, now = Date.now() }, path=READ_PATH, fields=['grantId']) {
  const timestamp=String(request?.headers?.['x-shiguang-timestamp']||''),nonce=String(request?.headers?.['x-shiguang-nonce']||'');
  const signature=String(request?.headers?.['x-shiguang-signature']||''),body=request?.body;
  if(request?.method!=='POST'||request?.path!==path||!exact(body,fields)||!GRANT.test(body.grantId||'')||
    !/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>300000||!NONCE.test(nonce)||!SIGNATURE.test(signature))fail('invalid_authority_signature');
  const expected=sign(secret,timestamp,nonce,body,path);
  if(!secret||secret.length<32||!crypto.timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))fail('invalid_authority_signature');
  return {grantId:body.grantId,timestampMs:Number(timestamp),nonce};
}

async function claimNonce(tx, timestampMs, nonce) {
  const epochMinute=Math.floor(timestampMs/60000),id=`slot-${String(((epochMinute%12)+12)%12).padStart(2,'0')}`;
  const row=await tx.get('story_desktop_nonces',id),nonceHash=digest(nonce);
  const hashes=row?.epochMinute===epochMinute&&Array.isArray(row.nonceHashes)?row.nonceHashes:[];
  if(hashes.includes(nonceHash))fail('replayed_authority_request');
  if(hashes.length>=500)fail('authority_rate_limited');
  await tx.set('story_desktop_nonces',id,{epochMinute,nonceHashes:[...hashes,nonceHash],updatedAtMs:timestampMs});
}

async function normalizeDraft(tx, grant, story, revision) {
  let draft=revision.draft;
  if(draft?.provenanceVersion===undefined)draft=materializeOwnedDraft(draft,{familyId:grant.familyId,storyId:story.id,revisionId:revision.id});
  else if(draft?.provenanceVersion===1)draft=applyBlockEdits(draft,[],{familyId:grant.familyId,storyId:story.id,requestId:'desktop-read-validate'});
  else throw protocolError();
  const roots=[...new Set(draft.chapters.flatMap(chapter=>chapter.content.flatMap(block=>block.sourceIds)))];
  if(roots.length&&!await allowsSources(tx,roots,'view'))fail('story_access_revoked');
  return draft;
}

async function authorizedStory(tx,grantId,now){
  const grant=await tx.get('story_desktop_grants',grantId);
  if(!grant||grant.grantId!==grantId||grant.status!=='active'||grant.expiresAtMs<=now||!GRANT.test(grant.grantId)||
    !/^principal_[a-f0-9]{32}$/.test(grant.principalId||'')||!/^family_[0-9A-Za-z_-]{1,120}$/.test(grant.familyId||'')||
    !/^story-[a-z0-9-]{1,100}$/.test(grant.storyId||''))fail('story_access_revoked');
  const principal=await tx.get('story_principals',grant.principalId),space=await tx.get('story_principal_spaces',grant.familyId),family=await tx.get('families',grant.familyId);
  if(principal?.status!=='active'||principal.familyId!==grant.familyId||space?.status!=='active'||space.principalId!==grant.principalId||
    space.accountId!==principal.accountId||family?.ownerAccountId!==principal.accountId||family.storyBooks?.status!=='active')fail('story_access_revoked');
  const story=await tx.get('stories',`${grant.familyId}_${grant.storyId}`);
  if(!story||story.familyId!==grant.familyId||story.id!==grant.storyId||story.deletedAt||!Number.isSafeInteger(story.version)||story.version<1||
    !/^revision-[a-zA-Z0-9-]{1,120}$/.test(story.currentRevisionId||''))fail('story_access_revoked');
  const record=await tx.get('biography_drafts',`${grant.familyId}_${story.currentRevisionId}`),revision=record?.revision;
  if(record?.familyId!==grant.familyId||record.storyId!==story.id||revision?.id!==story.currentRevisionId||revision.storyId!==story.id)fail('story_access_revoked');
  return {grant,story,record,revision};
}

async function readAuthoritativeStory(repo, request, options) {
  const verified=verifyRequest(request,options);
  // Claim in its own transaction so a valid signed request cannot be replayed
  // merely because later authorization or document validation fails.
  await repo.transaction(tx=>claimNonce(tx,verified.timestampMs,verified.nonce));
  return repo.transaction(async tx=>{
    const {grant,story,revision}=await authorizedStory(tx,verified.grantId,options.now());
    const draft=await normalizeDraft(tx,grant,story,revision);
    const chapters=draft.chapters.map(chapter=>({id:chapter.id,title:chapter.title,content:chapter.content.map(block=>({
      ...(typeof block.text==='string'?{text:block.text}:{photoId:block.photoId}),blockId:block.blockId,sourceIds:block.sourceIds,
    }))}));
    const document={familyId:grant.familyId,storyId:story.id,revisionId:revision.id,version:story.version,title:String(draft.title||story.bookTitle||story.title||'').trim(),
      updatedAt:String(story.updatedAt||revision.savedAt||''),provenanceVersion:1,chapters};
    if(!document.title||document.title.length>120||!Number.isFinite(Date.parse(document.updatedAt))||Buffer.byteLength(JSON.stringify(document))>512000)fail('story_document_invalid');
    return document;
  });
}

function normalizeWrite(body){
  if(!/^revision-[a-zA-Z0-9-]{1,120}$/.test(body.revisionId||'')||!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1||
    !/^[a-zA-Z0-9-]{8,100}$/.test(body.requestId||'')||!Array.isArray(body.edits)||body.edits.length<1||body.edits.length>128)fail('invalid_input');
  if(body.edits.reduce((length,edit)=>length+(typeof edit?.text==='string'?edit.text.length:0),0)>20000)fail('invalid_input');
  return {grantId:body.grantId,revisionId:body.revisionId,expectedVersion:body.expectedVersion,requestId:body.requestId,edits:body.edits};
}

async function writeAuthoritativeStory(repo,request,options){
  const fields=['grantId','revisionId','expectedVersion','requestId','edits'];
  const verified=verifyRequest(request,options,WRITE_PATH,fields),input=normalizeWrite(request.body);
  await repo.transaction(tx=>claimNonce(tx,verified.timestampMs,verified.nonce));
  return repo.transaction(async tx=>{
    const {grant,story,record,revision}=await authorizedStory(tx,verified.grantId,options.now());
    const fingerprint=digest(canonicalJson(input)),operationId='desktop-write-'+digest([grant.grantId,input.requestId].join(':'));
    const receipt=await tx.get('story_desktop_operations',operationId);
    if(receipt){if(receipt.grantId!==grant.grantId||receipt.principalId!==grant.principalId||receipt.fingerprint!==fingerprint)fail('version_conflict');return {...receipt.result,replayed:true};}
    if(story.version!==input.expectedVersion||story.currentRevisionId!==input.revisionId)fail('version_conflict');
    const base=await normalizeDraft(tx,grant,story,revision);
    const draft=applyBlockEdits(base,input.edits,{familyId:grant.familyId,storyId:story.id,requestId:input.requestId});
    if(canonicalJson(draft)===canonicalJson(base))fail('invalid_input');
    const savedAt=(options.isoNow?options.isoNow():new Date(options.now()).toISOString());
    const revisionId='revision-desktop-'+digest([grant.principalId,input.requestId].join(':')).slice(0,32);
    if(await tx.get('biography_drafts',`${grant.familyId}_${revisionId}`))fail('version_conflict');
    const nextRevision={...record.revision,id:revisionId,storyId:story.id,savedAt,draft,kind:'draft',label:'电脑端编辑',sourceRevisionId:input.revisionId,
      expectedStoryVersion:story.version,editedByPrincipalId:grant.principalId};
    const nextStory={...story,currentRevisionId:revisionId,version:story.version+1,updatedAt:savedAt,sourcePolicyRequired:true};
    const result={ok:true,storyId:story.id,revisionId,version:nextStory.version};
    await tx.set('biography_drafts',`${grant.familyId}_${revisionId}`,{familyId:grant.familyId,storyId:story.id,draftType:'story-revision',revision:nextRevision});
    await tx.set('stories',`${grant.familyId}_${story.id}`,nextStory);
    await tx.set('story_desktop_operations',operationId,{grantId:grant.grantId,principalId:grant.principalId,familyId:grant.familyId,storyId:story.id,
      requestId:input.requestId,fingerprint,result,createdAt:savedAt});
    return {...result,replayed:false};
  });
}

async function mediaDescriptor(repo,input,now){
  return repo.transaction(async tx=>{
    const {grant,story,revision}=await authorizedStory(tx,input.grantId,now);
    if(revision.id!==input.revisionId)fail('version_conflict');
    const draft=await normalizeDraft(tx,grant,story,revision),chapter=draft.chapters.find(item=>item.id===input.chapterId);
    const blocks=chapter?.content?.filter(block=>block.photoId===input.photoId);
    if(!blocks?.length)fail('story_access_revoked');
    for(const block of blocks)if(!await allowsSources(tx,block.sourceIds,'view'))fail('story_access_revoked');
    if(input.photoId.startsWith('photo-copy-')){
      const asset=await tx.get('story_copy_assets',`${grant.familyId}__${input.photoId}`),{copiedPath}=require('../storyBooks/copyAssets');
      if(!asset||asset.familyId!==grant.familyId||asset.storyId!==story.id||asset.photoId!==input.photoId||asset.status!=='active'||asset.sourcePolicyRequired!==true||
        !Array.isArray(asset.sourceIds)||!asset.sourceIds.length||!await allowsSources(tx,asset.sourceIds,'view')||!copiedPath.test(asset.fileID||'')||
        !asset.fileID.includes(`/copies/${asset.operationId}/`))fail('story_access_revoked');
      return {fileID:asset.fileID,revisionId:revision.id,storyVersion:story.version,photoId:input.photoId};
    }
    const family=await tx.get('families',grant.familyId),photo=await tx.get('photos',`${grant.familyId}__${input.photoId}`);
    if(!photo||photo.familyId!==grant.familyId||photo.photoId!==input.photoId||!family?._openid||photo._openid!==family._openid||photo.deletedAt||
      photo.sourcePolicyRequired||photo.sourceIds!==undefined||photo.moderation?.ok!==true||photo.moderation.suggest!=='pass')fail('story_access_revoked');
    const fileID=photo.displayFileID;
    if(typeof fileID!=='string'||!fileID.startsWith('cloud://')||!fileID.endsWith(`/user-photos/${grant.familyId}/${input.photoId}/display.jpg`))fail('story_access_revoked');
    return {fileID,revisionId:revision.id,storyVersion:story.version,photoId:input.photoId};
  });
}

async function readAuthoritativeMedia(repo,request,options){
  const fields=['grantId','revisionId','chapterId','photoId'],verified=verifyRequest(request,options,MEDIA_PATH,fields),body=request.body;
  if(!/^revision-[a-zA-Z0-9-]{1,120}$/.test(body.revisionId||'')||!/^chapter-[a-z0-9-]{1,60}$/.test(body.chapterId||'')||
    !/^photo-[a-z0-9-]{1,120}$/.test(body.photoId||'')||typeof options.signMedia!=='function')fail('invalid_input');
  await repo.transaction(tx=>claimNonce(tx,verified.timestampMs,verified.nonce));
  const input={grantId:verified.grantId,revisionId:body.revisionId,chapterId:body.chapterId,photoId:body.photoId};
  const before=await mediaDescriptor(repo,input,options.now()),url=await options.signMedia(before.fileID,300);
  if(typeof url!=='string'||url.length>4096){fail('story_access_revoked');}
  let parsed;try{parsed=new URL(url);}catch{fail('story_access_revoked');}
  if(parsed.protocol!=='https:'||parsed.username||parsed.password)fail('story_access_revoked');
  const after=await mediaDescriptor(repo,input,options.now());
  if(canonicalJson(before)!==canonicalJson(after))fail('story_access_revoked');
  return {photoId:input.photoId,url,expiresInSeconds:300};
}

async function authoritativeShareCard(repo,request,options){
  const verified=verifyRequest(request,options,CARD_PATH,['grantId','operation','revisionId','chapterId','blockIds','photoIds','descriptorId']);
  await repo.transaction(tx=>claimNonce(tx,verified.timestampMs,verified.nonce));
  if(options.shareCardEnabled!==true)fail('story_access_revoked');
  const initial=await repo.transaction(tx=>authorizedStory(tx,verified.grantId,options.now()));
  const ctx={principalId:initial.grant.principalId,familyId:initial.grant.familyId,async verifyIdentity(tx){
    const current=await authorizedStory(tx,verified.grantId,options.now());
    if(current.grant.principalId!==initial.grant.principalId||current.grant.familyId!==initial.grant.familyId||current.story.id!==initial.story.id)fail('story_access_revoked');
  }};
  const {listShareCardSource,previewShareCard,exportShareCard}=require('../storyBooks/exports');
  const body=request.body,ref={familyId:ctx.familyId,storyId:initial.story.id};
  if(body.operation==='source'){
    if(!exact(body,['grantId','operation']))fail('invalid_input');
    return listShareCardSource(repo,ctx,ref);
  }
  const input={...ref,revisionId:body.revisionId,chapterId:body.chapterId,blockIds:body.blockIds,photoIds:body.photoIds};
  const approve=async text=>{
    if(typeof options.approveShareCard!=='function')return false;
    const family=await repo.transaction(async tx=>{await ctx.verifyIdentity(tx);return tx.get('families',ctx.familyId);});
    return options.approveShareCard(text,family?._openid);
  };
  if(body.operation==='preview'&&body.descriptorId===undefined)return previewShareCard(repo,ctx,input,{approve});
  if(body.operation==='export')return exportShareCard(repo,ctx,{...input,descriptorId:body.descriptorId},{approve,sign:options.signMedia});
  fail('invalid_input');
}

module.exports={PATH:READ_PATH,READ_PATH,WRITE_PATH,MEDIA_PATH,CARD_PATH,sign,verifyRequest,claimNonce,readAuthoritativeStory,writeAuthoritativeStory,readAuthoritativeMedia,authoritativeShareCard};
