const crypto=require('node:crypto');
const core=require('./core');
const {assertSpaceOwner,identityError}=require('./identity');
const {applyBlockEdits,materializeOwnedDraft,protocolError}=require('./provenance');
const {ownNamesByPrincipal}=require('./displayNames');
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
    const returnedSources=story.returnedSourceEdits&&typeof story.returnedSourceEdits==='object'?story.returnedSourceEdits:{};
    const blocks=chapter.content.filter(block=>typeof block.text==='string'&&Array.isArray(block.sourceIds)&&block.sourceIds.length===0&&!returned.has(block.blockId))
      .map(block=>({blockId:block.blockId,text:block.text}));
    const sourceEdits=chapter.content.filter(block=>typeof block.text==='string'&&Array.isArray(block.sourceIds)&&block.sourceIds.length>0&&
      /^block-[a-f0-9]{64}$/.test(block.blockId||'')&&/^[a-f0-9]{64}$/.test(chapter.packageBlockDigests?.[block.blockId]||'')&&
      digest(block.text.replace(/\r\n?/g,'\n').replace(/\n$/,''))!==chapter.packageBlockDigests[block.blockId]&&
      digest(block.text.replace(/\r\n?/g,'\n').replace(/\n$/,''))!==returnedSources[block.blockId])
      .map(block=>({blockId:block.blockId,sourceBlockId:chapter.packageSourceBlockIds?.[block.blockId]||block.blockId,expectedTextDigest:chapter.packageBlockDigests[block.blockId],
        text:block.text.replace(/\r\n?/g,'\n'),currentTextDigest:digest(block.text.replace(/\r\n?/g,'\n').replace(/\n$/,''))}));
    if(!blocks.length&&!sourceEdits.length)throw error('STORY_RETURN_EMPTY','这一章还没有新的个人经历或原文修改可以发回');
    if(blocks.some(block=>!/^block-[a-f0-9]{64}$/.test(block.blockId)||!block.text.trim()))throw protocolError();
    if(sourceEdits.some(edit=>!/^block-[a-f0-9]{64}$/.test(edit.blockId)||!edit.text.trim()||edit.text.replace(/\n$/,'').includes('\n')))throw protocolError();
    // 本轮排版闭环限同账号。只存匹配摘要，不把其他来源的正文再复制进回信。
    const layout=route.sourceFamilyId===ctx.familyId&&route.sourceOwnerPrincipalId===ctx.principalId&&chapter.layout&&typeof chapter.layout==='object'?chapter.layout:null;
    const senderBindings=layout?chapter.content.filter(block=>typeof block.text==='string').map(block=>({blockId:block.blockId,textDigest:digest(block.text),
      ...(chapter.packageSourceBlockIds?.[block.blockId]?{sourceBlockId:chapter.packageSourceBlockIds[block.blockId]}:{})})):[];
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
      senderChapterId:chapter.id,senderRevisionId:current.id,senderName:route.senderName||'一位亲友',senderMemberId:route.senderMemberId||'',blocks,sourceEdits,...(layout?{layout,senderBindings}:{}),status:'pending',fingerprint,createdAt:stamp});
    await tx.set('story_return_indexes',indexId,{familyId:route.sourceFamilyId,principalId:route.sourceOwnerPrincipalId,returnIds:[...returnIds,returnId],updatedAt:stamp});
    const nextReturnedSources={...returnedSources};sourceEdits.forEach(edit=>{nextReturnedSources[edit.blockId]=edit.currentTextDigest;});
    await tx.set('stories',docId(ctx.familyId,story.id),{...story,returnedOwnBlockIds:[...returned,...blocks.map(block=>block.blockId)],returnedSourceEdits:nextReturnedSources,updatedAt:stamp});
    return {ok:true,returnId,status:'pending',alreadySent:false};
  });
}
async function listReturns(repo,ctx){
  await assertSpaceOwner(repo,ctx);
  const index=await repo.get('story_return_indexes',returnIndexId(ctx.familyId,ctx.principalId));
  if(index&&(index.familyId!==ctx.familyId||index.principalId!==ctx.principalId||!Array.isArray(index.returnIds)||index.returnIds.length>200))throw protocolError();
  const rows=[];for(const id of index?.returnIds||[]){if(RETURN.test(id)){const row=await repo.get('story_returns',id);if(row)rows.push({_id:id,...row});}}
  await assertSpaceOwner(repo,ctx);
  const final=rows.filter(row=>row.sourceOwnerPrincipalId===ctx.principalId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  // 署名用发送者本人的称呼；读不到时退回送出那一刻记下的备注名。只解析最终要返回的行。
  const own=await ownNamesByPrincipal(repo,final.map(row=>row.senderPrincipalId));
  return {returns:final.map(row=>({
    returnId:row._id,status:row.status,sourceStoryId:row.sourceStoryId,sourceChapterId:row.sourceChapterId,senderName:own.get(row.senderPrincipalId)||row.senderName||'一位亲友',senderMemberId:row.senderMemberId||'',blocks:row.blocks,
    sourceEdits:(row.sourceEdits||[]).map(edit=>({text:edit.text})),createdAt:row.createdAt,
    decidedAt:row.decidedAt||'',resultRevisionId:row.resultRevisionId||'',
  }))};
}
function normalizeDecision(input){
  if(!exact(input,['returnId','decision','requestId'])||!RETURN.test(input.returnId||'')||!['accept','reject'].includes(input.decision)||!REQUEST.test(input.requestId||''))throw identityError();
  return input;
}
function applyReturnedSourceEdits(chapter,edits){
  if(!Array.isArray(edits)||!edits.length)return;
  const candidates=[];
  chapter.content.forEach((block,contentIndex)=>{
    if(typeof block.text!=='string')return;
    const lines=block.text.replace(/\r\n?/g,'\n').split('\n');
    lines.forEach((line,lineIndex)=>{if(line.trim())candidates.push({block,contentIndex,lineIndex,digest:digest(line)});});
  });
  const used=new Set(),replacements=new Map();
  for(const edit of edits){
    if(!edit||!/^block-[a-f0-9]{64}$/.test(edit.blockId||'')||!/^block-[a-f0-9]{64}$/.test(edit.sourceBlockId||'')||
      !/^[a-f0-9]{64}$/.test(edit.expectedTextDigest||'')||typeof edit.text!=='string'||edit.text.replace(/\n$/,'').includes('\n'))throw protocolError();
    const matching=candidates.filter(item=>item.digest===edit.expectedTextDigest&&!used.has(`${item.contentIndex}:${item.lineIndex}`));
    const byId=matching.filter(item=>item.block.blockId===edit.sourceBlockId);
    const found=byId.length===1?byId:matching;
    if(found.length!==1)conflict();
    const target=found[0],key=`${target.contentIndex}:${target.lineIndex}`;used.add(key);
    const lines=(replacements.get(target.contentIndex)||target.block.text.replace(/\r\n?/g,'\n').split('\n')).slice();
    lines[target.lineIndex]=edit.text.replace(/\n$/,'');replacements.set(target.contentIndex,lines);
  }
  for(const [contentIndex,lines]of replacements)chapter.content[contentIndex].text=lines.join('\n');
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
    applyReturnedSourceEdits(chapter,record.sourceEdits||[]);
    Object.assign(base,core.flatten(base.chapters));
    const edits=record.blocks.map(block=>({action:'appendOwn',chapterId:chapter.id,text:block.text}));
    let draft=applyBlockEdits(base,edits,{familyId:ctx.familyId,storyId:story.id,requestId:input.requestId});
    const policyId='source-'+digest([input.returnId,'accepted-v1']);
    const appended=edits.length?draft.chapters.find(item=>item.id===chapter.id).content.slice(-edits.length):[];
    appended.forEach(block=>{block.sourceIds=[policyId];});
    // 稳定 ID 优先；旧块仅在两侧摘要都唯一时匹配。重复、删改或无法对位的引用丢弃。
    if(record.layout){
      const target=draft.chapters.find(item=>item.id===chapter.id),used=new Set(),idMap=new Map();
      const returnedIds=record.blocks.map(block=>block.blockId);
      returnedIds.forEach((id,index)=>idMap.set(id,appended[index].blockId));
      const candidates=target.content.filter(block=>typeof block.text==='string'&&!appended.includes(block));
      const bindings=record.senderBindings||[];
      for(const sent of bindings){
        if(idMap.has(sent.blockId))continue;
        let match=candidates.find(block=>!used.has(block.blockId)&&block.blockId===(sent.sourceBlockId||sent.blockId));
        if(!match&&bindings.filter(b=>b.textDigest===sent.textDigest).length===1){
          const matches=candidates.filter(block=>digest(block.text)===sent.textDigest);
          if(matches.length===1&&!used.has(matches[0].blockId))match=matches[0];
        }
        if(match){used.add(match.blockId);idMap.set(sent.blockId,match.blockId);}
      }
      const pages=(record.layout.pages||[]).map(page=>({...page,modules:(page.modules||[]).flatMap(module=>{
        if(module.kind!=='text'||!module.bind||module.bind.blockId===undefined)return [module];
        const mapped=idMap.get(module.bind.blockId);
        return mapped?[{...module,bind:{...module.bind,blockId:mapped}}]:[];
      })})).filter(page=>page.modules.length);
      if(pages.length)target.layout={...record.layout,pages};
    }
    Object.assign(draft,core.flatten(draft.chapters));
    draft=applyBlockEdits(draft,[],{familyId:ctx.familyId,storyId:story.id,requestId:input.requestId});core.validateDraft(draft,story);
    if(Buffer.byteLength(JSON.stringify(draft),'utf8')>240000)throw error('STORY_COPY_LIMIT','这份章节超过接收上限，请减少章节后重试');
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
