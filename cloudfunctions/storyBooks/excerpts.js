const crypto=require('node:crypto');
const core=require('./core');
const {assertSpaceOwner,identityError}=require('./identity');
const {assertLegacyWritable}=require('./provenance');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const digest=value=>crypto.createHash('sha256').update(core.stable(value)).digest('hex');
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>fields.includes(key));

function normalize(input){
  if(!exact(input,['storyId','revisionId','expectedVersion','chapterId','text','recipientMemberIds','requestId'])||
    !core.STORY_ID.test(input.storyId||'')||!/^revision-[a-zA-Z0-9-]{1,120}$/.test(input.revisionId||'')||
    !Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||
    !/^chapter-[a-z0-9-]{1,60}$/.test(input.chapterId||'')||
    typeof input.text!=='string'||!input.text.trim()||input.text!==input.text.trim()||input.text.length>500||
    !Array.isArray(input.recipientMemberIds)||!input.recipientMemberIds.length||input.recipientMemberIds.length>20||
    new Set(input.recipientMemberIds).size!==input.recipientMemberIds.length||
    input.recipientMemberIds.some(id=>typeof id!=='string'||id==='owner'||id.length>120||!/^[0-9A-Za-z_-]+$/.test(id))||
    typeof input.requestId!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId))fail('INVALID_INPUT','选段信息无效，请重新选择');
  return {...input,recipientMemberIds:[...input.recipientMemberIds].sort()};
}

async function shareExcerpt(repo,ctx,raw,{approve,now=()=>new Date().toISOString()}={}){
  const input=normalize(raw);
  const operationId=ctx.familyId+'_excerpt_'+digest([ctx.principalId,input.requestId]);
  const fingerprint=digest(input);
  const replay=await repo.transaction(async tx=>{
    await assertSpaceOwner(tx,ctx);
    const prior=await tx.get('story_excerpt_operations',operationId);
    if(!prior)return undefined;
    if(prior.principalId!==ctx.principalId||prior.fingerprint!==fingerprint)fail('VERSION_CONFLICT','这次发送请求已用于其他选段');
    return prior.result;
  });
  if(replay)return replay;
  if(typeof approve!=='function'||await approve(input.text)!==true)fail('CONTENT_REJECTED','这段内容没有通过内容安全检测，请修改后重试');
  return repo.transaction(async tx=>{
    await assertSpaceOwner(tx,ctx);
    const family=await tx.get('families',ctx.familyId);
    if(family?.storyBooks?.status!=='active')fail('MIGRATION_NOT_READY','故事库正在准备，请稍后重试');
    const prior=await tx.get('story_excerpt_operations',operationId);
    if(prior){
      if(prior.principalId!==ctx.principalId||prior.fingerprint!==fingerprint)fail('VERSION_CONFLICT','这次发送请求已用于其他选段');
      return prior.result;
    }
    const story=await tx.get('stories',ctx.familyId+'_'+input.storyId);
    if(!story||story.familyId!==ctx.familyId||story.id!==input.storyId||story.deletedAt)throw identityError();
    if(story.version!==input.expectedVersion||story.currentRevisionId!==input.revisionId)fail('VERSION_CONFLICT','故事已有更新，请重新选择');
    const record=await tx.get('biography_drafts',ctx.familyId+'_'+input.revisionId);
    const revision=record?.revision,draft=revision?.draft;
    if(record?.familyId!==ctx.familyId||record.storyId!==story.id||revision?.id!==input.revisionId||revision.storyId!==story.id)throw identityError();
    assertLegacyWritable(story,draft);
    const chapter=draft?.chapters?.find(item=>item.id===input.chapterId);
    if(!chapter)fail('STORY_EXCERPT_MISMATCH','保存的章节已经变化，请重新选择');
    const matches=[];
    chapter.content.forEach((block,index)=>{
      if(typeof block.text==='string'&&block.photoId===undefined&&block.text.includes(input.text))matches.push(index);
    });
    if(matches.length!==1)fail('STORY_EXCERPT_MISMATCH','选段必须来自当前保存章节中的一段连续文字');
    const owner=await tx.get('family_members',ctx.familyId+'_owner');
    if(!owner||owner.familyId!==ctx.familyId||owner.deletedAt)throw identityError();
    for(const memberId of input.recipientMemberIds){
      const member=await tx.get('family_members',ctx.familyId+'_'+memberId);
      if(!member||member.familyId!==ctx.familyId||!['contributor','owner'].includes(member.role)||member.deletedAt)throw identityError();
    }
    const stamp=now(),contributionId='excerpt-'+digest([ctx.principalId,input.requestId]).slice(0,40);
    const titleParts=[draft.title,chapter.title].map(value=>String(value||'').trim()).filter(Boolean);
    const title=((titleParts.length?'《'+titleParts.join('·')+'》':'人生之书')+'摘录').slice(0,40);
    const sourceRecordId='src_'+ctx.familyId+'_owner_'+contributionId;
    const shared={
      familyId:ctx.familyId,sourceRecordId,frontendContributionId:contributionId,
      authorMemberId:owner.memberId||owner.id,authorName:owner.name,relation:owner.relation,
      text:input.text,title,scope:'personal',visibility:'private',reviewStatus:'confirmed',
      relatedMemberIds:input.recipientMemberIds,sharedWithMemberIds:input.recipientMemberIds,
      sourceStoryId:story.id,sourceRevisionId:revision.id,sourceChapterId:chapter.id,sourceBlockIndex:matches[0],
      createdAt:stamp,updatedAt:stamp,
    };
    await tx.set('source_records',sourceRecordId,{...shared,contributorMemberId:shared.authorMemberId,contributorName:shared.authorName,sourceType:'story-excerpt',rawText:input.text,submittedAt:stamp});
    await tx.set('memories',ctx.familyId+'_'+contributionId,shared);
    const result={ok:true,contributionId,recipientMemberIds:input.recipientMemberIds};
    await tx.set('story_excerpt_operations',operationId,{familyId:ctx.familyId,principalId:ctx.principalId,fingerprint,result,createdAt:stamp});
    return result;
  });
}

module.exports={normalizeExcerptInput:normalize,shareExcerpt};
