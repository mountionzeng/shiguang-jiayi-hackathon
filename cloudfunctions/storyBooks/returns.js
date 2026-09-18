const crypto=require('node:crypto');
const core=require('./core');
const {assertSpaceOwner,identityError}=require('./identity');
const {applyBlockEdits,materializeOwnedDraft,protocolError}=require('./provenance');
const digest=value=>crypto.createHash('sha256').update(core.stable(value)).digest('hex');
const docId=(family,id)=>`${family}_${id}`;
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>fields.includes(key));
const error=(code,message)=>Object.assign(new Error(message),{code});
const conflict=()=>{throw error('VERSION_CONFLICT','故事已有变化，请刷新后重试');};
const RETURN=/^return-[a-f0-9]{64}$/;
const REQUEST=/^[a-zA-Z0-9-]{8,100}$/;
const returnIndexId=(familyId,principalId)=>`${familyId}_${principalId}`;
async function revision(tx,familyId,story){
  const row=await tx.get('biography_drafts',docId(familyId,story.currentRevisionId));
  if(!row||row.familyId!==familyId||row.storyId!==story.id||row.revision?.id!==story.currentRevisionId)throw protocolError();
  return row.revision;
}
function normalizeSend(input){
  if(!exact(input,['storyId','revisionId','expectedVersion','chapterId','requestId'])||!core.STORY_ID.test(input.storyId||'')||
    !/^revision-[a-zA-Z0-9-]{1,120}$/.test(input.revisionId||'')||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||
    !/^chapter-[a-z0-9-]{1,60}$/.test(input.chapterId||'')||!REQUEST.test(input.requestId||''))throw identityError();
  return input;
}
async function sendOwnReturn(repo,ctx,raw,{now=()=>new Date().toISOString()}={}){
  const input=normalizeSend(raw),stamp=now(),returnId='return-'+digest([ctx.principalId,input.requestId]),fingerprint=digest(input);
  return repo.transaction(async tx=>{
    await assertSpaceOwner(tx,ctx);
    const prior=await tx.get('story_returns',returnId);
    if(prior){if(prior.senderPrincipalId!==ctx.principalId||prior.fingerprint!==fingerprint)conflict();return {ok:true,returnId,status:prior.status,alreadySent:true};}
    const story=await tx.get('stories',docId(ctx.familyId,input.storyId));
    if(!story||story.familyId!==ctx.familyId||story.deletedAt||story.sourcePolicyRequired!==true||story.version!==input.expectedVersion||story.currentRevisionId!==input.revisionId)conflict();
    const route=(Array.isArray(story.receivedSources)?story.receivedSources:[]).find(item=>item.destinationChapterId===input.chapterId);
    if(!route||!/^principal_[0-9a-f]{32}$/.test(route.sourceOwnerPrincipalId||''))throw identityError();
    const current=await revision(tx,ctx.familyId,story),chapter=current.draft?.chapters?.find(item=>item.id===input.chapterId);
    if(!chapter)throw identityError();
    const returned=new Set(Array.isArray(story.returnedOwnBlockIds)?story.returnedOwnBlockIds:[]);
    const blocks=chapter.content.filter(block=>typeof block.text==='string'&&Array.isArray(block.sourceIds)&&block.sourceIds.length===0&&!returned.has(block.blockId))
      .map(block=>({blockId:block.blockId,text:block.text}));
    if(!blocks.length)throw error('STORY_RETURN_EMPTY','这一章还没有新的个人经历可以发回');
    if(blocks.some(block=>!/^block-[a-f0-9]{64}$/.test(block.blockId)||!block.text.trim()))throw protocolError();
    const indexId=returnIndexId(route.sourceFamilyId,route.sourceOwnerPrincipalId),existingIndex=await tx.get('story_return_indexes',indexId);
    if(existingIndex&&(existingIndex.familyId!==route.sourceFamilyId||existingIndex.principalId!==route.sourceOwnerPrincipalId||!Array.isArray(existingIndex.returnIds)))throw protocolError();
    let returnIds=existingIndex?.returnIds||[];
    if(returnIds.length>=200){
      const retained=[];
      for(const id of returnIds){const item=await tx.get('story_returns',id);if(item?.status==='pending')retained.push(id);}
      if(retained.length>=200)throw error('STORY_RETURN_LIMIT','待处理的亲友记忆太多，请先处理后再接收');
      returnIds=retained;
    }
    await tx.set('story_returns',returnId,{familyId:route.sourceFamilyId,sourceStoryId:route.sourceStoryId,sourceChapterId:route.sourceChapterId,
      sourceOwnerPrincipalId:route.sourceOwnerPrincipalId,senderFamilyId:ctx.familyId,senderPrincipalId:ctx.principalId,senderStoryId:story.id,
      senderChapterId:chapter.id,senderRevisionId:current.id,blocks,status:'pending',fingerprint,createdAt:stamp});
    await tx.set('story_return_indexes',indexId,{familyId:route.sourceFamilyId,principalId:route.sourceOwnerPrincipalId,returnIds:[...returnIds,returnId],updatedAt:stamp});
    await tx.set('stories',docId(ctx.familyId,story.id),{...story,returnedOwnBlockIds:[...returned,...blocks.map(block=>block.blockId)],updatedAt:stamp});
    return {ok:true,returnId,status:'pending',alreadySent:false};
  });
}
async function listReturns(repo,ctx){
  await assertSpaceOwner(repo,ctx);
  const index=await repo.get('story_return_indexes',returnIndexId(ctx.familyId,ctx.principalId));
  if(index&&(index.familyId!==ctx.familyId||index.principalId!==ctx.principalId||!Array.isArray(index.returnIds)||index.returnIds.length>200))throw protocolError();
  const rows=[];for(const id of index?.returnIds||[]){if(RETURN.test(id)){const row=await repo.get('story_returns',id);if(row)rows.push({_id:id,...row});}}
  await assertSpaceOwner(repo,ctx);
  return {returns:rows.filter(row=>row.sourceOwnerPrincipalId===ctx.principalId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(row=>({
    returnId:row._id,status:row.status,sourceStoryId:row.sourceStoryId,sourceChapterId:row.sourceChapterId,blocks:row.blocks,createdAt:row.createdAt,
    decidedAt:row.decidedAt||'',resultRevisionId:row.resultRevisionId||'',
  }))};
}
function normalizeDecision(input){
  if(!exact(input,['returnId','decision','requestId'])||!RETURN.test(input.returnId||'')||!['accept','reject'].includes(input.decision)||!REQUEST.test(input.requestId||''))throw identityError();
  return input;
}
async function decideReturn(repo,ctx,raw,{now=()=>new Date().toISOString()}={}){
  const input=normalizeDecision(raw),stamp=now(),decisionFingerprint=digest(input);
  return repo.transaction(async tx=>{
    await assertSpaceOwner(tx,ctx);
    const record=await tx.get('story_returns',input.returnId);
    if(!record||record.familyId!==ctx.familyId||record.sourceOwnerPrincipalId!==ctx.principalId)throw identityError();
    if(record.status!=='pending'){
      if(record.decisionFingerprint!==decisionFingerprint)conflict();
      return {ok:true,status:record.status,revisionId:record.resultRevisionId||'',alreadyDecided:true};
    }
    if(input.decision==='reject'){
      await tx.set('story_returns',input.returnId,{...record,status:'rejected',decisionFingerprint,decidedAt:stamp});
      return {ok:true,status:'rejected',revisionId:'',alreadyDecided:false};
    }
    const story=await tx.get('stories',docId(ctx.familyId,record.sourceStoryId));
    if(!story||story.familyId!==ctx.familyId||story.deletedAt||!story.currentRevisionId)throw identityError();
    const current=await revision(tx,ctx.familyId,story);
    let base=current.draft;
    if(base?.provenanceVersion===undefined)base=materializeOwnedDraft(base,{familyId:ctx.familyId,storyId:story.id,revisionId:current.id});
    const chapter=base.chapters.find(item=>item.id===record.sourceChapterId);if(!chapter)conflict();
    const edits=record.blocks.map(block=>({action:'appendOwn',chapterId:chapter.id,text:block.text}));
    let draft=applyBlockEdits(base,edits,{familyId:ctx.familyId,storyId:story.id,requestId:input.requestId});
    const policyId='source-'+digest([input.returnId,'accepted-v1']);
    const appended=draft.chapters.find(item=>item.id===chapter.id).content.slice(-edits.length);
    appended.forEach(block=>{block.sourceIds=[policyId];});Object.assign(draft,core.flatten(draft.chapters));
    draft=applyBlockEdits(draft,[],{familyId:ctx.familyId,storyId:story.id,requestId:input.requestId});core.validateDraft(draft,story);
    const revisionId='revision-'+digest([input.returnId,input.requestId,'accept-v1']);
    if(await tx.get('biography_drafts',docId(ctx.familyId,revisionId)))conflict();
    await tx.set('story_source_policies',policyId,{version:1,parents:[],permissions:{view:true,copy:false,forward:false,publish:false,ai:false,export:false},
      contributorPrincipalId:record.senderPrincipalId,sourceReturnId:input.returnId,createdAt:stamp});
    await tx.set('biography_drafts',docId(ctx.familyId,revisionId),{familyId:ctx.familyId,storyId:story.id,draftType:'story-revision',revision:{
      id:revisionId,storyId:story.id,memberId:'',kind:'version',label:'收下亲友补充',savedAt:stamp,sourceFingerprint:'',draft}});
    await tx.set('stories',docId(ctx.familyId,story.id),{...story,version:story.version+1,currentRevisionId:revisionId,sourcePolicyRequired:true,updatedAt:stamp});
    await tx.set('story_returns',input.returnId,{...record,status:'accepted',decisionFingerprint,decidedAt:stamp,resultRevisionId:revisionId});
    return {ok:true,status:'accepted',revisionId,alreadyDecided:false};
  });
}
module.exports={sendOwnReturn,listReturns,decideReturn};
