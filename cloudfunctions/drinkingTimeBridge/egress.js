const crypto=require('node:crypto');
const {requestBody}=require('./core');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const id=(value,prefix)=>typeof value==='string'&&value.startsWith(prefix)&&value.length<=140&&/^[a-zA-Z0-9_-]+$/.test(value);

// Independently deployed bridge: resolve only server-held identity records.
// Never bootstrap or link identities as a side effect of exporting a story.
async function ownedSpace(reader,context,options){
  const {APPID:appId,OPENID:openid}=context||{};
  if(typeof appId!=='string'||!/^wx[0-9A-Za-z_-]{1,80}$/.test(appId)||
    typeof openid!=='string'||! /^[0-9A-Za-z_-]{1,128}$/.test(openid))fail('AUTH_REQUIRED');
  const alias=await reader.get('story_identity_aliases',hash(JSON.stringify([appId,openid])));
  let familyId,accountId,principalId;
  if(alias){
    if(alias.status!=='active'||alias.appId!==appId||!/^principal_[0-9a-f]{32}$/.test(alias.principalId))fail('STORY_FORBIDDEN');
    const principal=await reader.get('story_principals',alias.principalId);
    if(principal?.status!=='active'||!/^family_[0-9A-Za-z_-]{1,120}$/.test(principal.familyId)||!/^account_[0-9a-f]{24}$/.test(principal.accountId))fail('STORY_FORBIDDEN');
    familyId=principal.familyId;accountId=principal.accountId;principalId=alias.principalId;
    const space=await reader.get('story_principal_spaces',familyId);
    if(space?.status!=='active'||space.principalId!==alias.principalId||space.accountId!==accountId)fail('STORY_FORBIDDEN');
  }else{
    if(!options.bootstrapAppId||appId!==options.bootstrapAppId)fail('IDENTITY_UNLINKED');
    familyId='family_'+openid;
    if(await reader.get('story_principal_spaces',familyId))fail('IDENTITY_UNLINKED');
  }
  const family=await reader.get('families',familyId);
  if(!family||(accountId?family.ownerAccountId!==accountId:family._openid!==openid))fail('STORY_FORBIDDEN');
  return {familyId,family,principalId};
}

function unrestricted(value){
  const pending=[value];let count=0;
  while(pending.length){
    const item=pending.pop();
    if(!item||typeof item!=='object')continue;
    if(++count>5000)fail('invalid_input');
    if(item.sourcePolicyRequired||['sourceIds','blockId','provenanceVersion'].some(key=>Object.hasOwn(item,key)))fail('STORY_PROTOCOL_REQUIRED');
    pending.push(...Object.values(item).filter(child=>child&&typeof child==='object'));
  }
}

async function prepareDesktopBody(repo,event,context,options={}){
  if(event?.action!=='issueDesktop')fail('invalid_input');
  return repo.transaction(async tx=>{
    const {familyId,family,principalId}=await ownedSpace(tx,context,options);
    if(!family.storyBooks){
      if(event.storyRef)fail('MIGRATION_NOT_READY');
      unrestricted(event.story);
      return requestBody(event.action,event,context);
    }
    if(family.storyBooks.status!=='active')fail('MIGRATION_NOT_READY');
    const ref=event.storyRef;
    if(!ref)fail('STORY_PROTOCOL_REQUIRED');
    if(!id(ref.storyId,'story-')||!id(ref.revisionId,'revision-')||!Number.isSafeInteger(ref.version)||ref.version<0)fail('STORY_SAVE_REQUIRED');
    const story=await tx.get('stories',familyId+'_'+ref.storyId);
    if(!story||story.familyId!==familyId||story.id!==ref.storyId||story.deletedAt)fail('STORY_FORBIDDEN');
    if(story.version!==ref.version||story.currentRevisionId!==ref.revisionId)fail('REVISION_CHANGED');
    const record=await tx.get('biography_drafts',familyId+'_'+ref.revisionId);
    const revision=record?.revision,draft=revision?.draft;
    if(record?.familyId!==familyId||record.storyId!==story.id||revision?.id!==ref.revisionId||revision.storyId!==story.id||!Array.isArray(draft?.chapters))fail('STORY_FORBIDDEN');
    if(options.authorityEnabled===true){
      if(!principalId)fail('IDENTITY_UNLINKED');
      const grantId='desktop-grant-'+(options.randomBytes?options.randomBytes(32):crypto.randomBytes(32)).toString('hex');
      const createdAtMs=(options.now?options.now():Date.now()),expiresAtMs=createdAtMs+30*24*60*60*1000;
      await tx.set('story_desktop_grants',grantId,{grantId,status:'active',familyId,principalId,storyId:story.id,revisionId:revision.id,
        version:story.version,title:story.title,createdAtMs,expiresAtMs});
      return requestBody(event.action,{storyAccess:{grantId,familyId,storyId:story.id,revisionId:revision.id,version:story.version,title:story.title}},context);
    }
    unrestricted(story);
    unrestricted(draft);
    // Export the saved manuscript, not unrelated source memories or hidden fields.
    const manuscript={title:draft.title,generatedAt:draft.generatedAt,chapters:draft.chapters.map(chapter=>({
      id:chapter.id,title:chapter.title,memoryIds:[],
      content:chapter.content.map(item=>{
        if(typeof item.text==='string'&&item.photoId===undefined)return {text:item.text};
        if(typeof item.photoId==='string'&&item.text===undefined)return item.photoId.startsWith('photo-ai-')?{text:'〔AI 插图请在小程序查看〕'}:{photoId:item.photoId};
        fail('invalid_input');
      }),
    }))};
    if(!manuscript.chapters.some(chapter=>chapter.content.length))fail('STORY_SAVE_REQUIRED');
    const snapshot={sourceKey:story.id,sourceRevision:hash(JSON.stringify({version:story.version,revisionId:revision.id,manuscript})).slice(0,16),
      title:story.title,updatedAt:story.updatedAt,memories:[],manuscript};
    if(Buffer.byteLength(JSON.stringify(snapshot))>512000)fail('payload_too_large');
    return requestBody(event.action,{story:snapshot},context);
  });
}

module.exports={prepareDesktopBody};
