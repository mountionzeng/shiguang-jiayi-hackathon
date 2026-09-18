const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/story-access-fixture');
const {resolveStoryIdentity}=require('../cloudfunctions/storyBooks/identity');
const {grantIdFor}=require('../cloudfunctions/storyBooks/access');
const {createStoryService}=require('../cloudfunctions/storyBooks/service');
const {receiveTextCopy,appendOwnExperience}=require('../cloudfunctions/storyBooks/copies');
const {sendOwnReturn,listReturns,decideReturn}=require('../cloudfunctions/storyBooks/returns');
const {allowsSources,applyBlockEdits}=require('../cloudfunctions/storyBooks/provenance');
const core=require('../cloudfunctions/storyBooks/core');
async function setup(){
  const f=fixture();f.account('owner');f.account('reader');f.account('stranger');
  const identity=who=>resolveStoryIdentity(f.repo,{APPID:'wx-original',OPENID:who},{bootstrapAppId:'wx-original'});
  const owner=await identity('owner'),reader=await identity('reader'),stranger=await identity('stranger');
  const chapters=[{id:'chapter-one',title:'不共享',memoryIds:[],content:[{text:'秘密正文'}]},{id:'chapter-three',title:'共同回忆',memoryIds:[],content:[{text:'那年的夏天'}]}];
  f.tables.set('stories:family_owner_story-original',{id:'story-original',familyId:'family_owner',title:'原书',bookTitle:'原书',writingMode:'objective',memoryIds:[],version:3,currentRevisionId:'revision-source'});
  f.tables.set('biography_drafts:family_owner_revision-source',{familyId:'family_owner',storyId:'story-original',revision:{id:'revision-source',storyId:'story-original',draft:{title:'原书',chapters,...core.flatten(chapters),sourceCount:0,generatedAt:'',generationMode:'local-demo',privatePrompt:'不要复制'}}});
  const grantId=grantIdFor('family_owner','story-original',reader.principalId);
  f.tables.set('story_grants:'+grantId,{familyId:'family_owner',storyId:'story-original',principalId:reader.principalId,ownerPrincipalId:owner.principalId,status:'active',version:1,scope:{type:'chapters',chapterIds:['chapter-three']},permissions:{read:true,copy:true,forward:false,publish:false}});
  const input={sourceFamilyId:'family_owner',sourceStoryId:'story-original',sourceRevisionId:'revision-source',chapterIds:['chapter-three'],requestId:'receive-request-001',target:{mode:'new',storyId:'story-copy',title:'我的夏天'}};
  return {...f,owner,reader,stranger,grantId,input};
}
function copied(f,id='story-copy'){
  const story=f.tables.get('stories:family_reader_'+id);
  return {story,revision:f.tables.get('biography_drafts:family_reader_'+story.currentRevisionId).revision};
}
test('authorized text copy is an independent sanitized snapshot with immutable source receipt',async()=>{
  const f=await setup(),before=structuredClone(f.tables.get('stories:family_owner_story-original'));
  const result=await receiveTextCopy(f.repo,f.reader,f.input);
  assert.equal(result.storyId,'story-copy');assert.equal(result.alreadyReceived,false);
  const {story,revision}=copied(f);assert.equal(story.sourcePolicyRequired,true);
  assert.equal(revision.draft.chapters.length,1);assert.deepEqual(revision.draft.chapters[0].memoryIds,[]);
  assert.equal(JSON.stringify(revision).includes('秘密正文'),false);assert.equal(JSON.stringify(revision).includes('privatePrompt'),false);
  const ids=revision.draft.chapters[0].content[0].sourceIds;
  assert.equal(ids.length,1);assert.equal(await allowsSources(f.repo,ids,'view'),true);
  for(const action of ['forward','publish','ai','export'])assert.equal(await allowsSources(f.repo,ids,action),false);
  assert.deepEqual(f.tables.get('stories:family_owner_story-original'),before);
  f.tables.delete('stories:family_owner_story-original');f.tables.delete('biography_drafts:family_owner_revision-source');f.tables.delete('story_grants:'+f.grantId);
  assert.equal(copied(f).revision.draft.chapters[0].content[0].text,'那年的夏天');
  assert.equal(await allowsSources(f.repo,ids,'view'),true);
  assert.equal((await receiveTextCopy(f.repo,f.reader,f.input)).alreadyReceived,true);
});
test('concurrent requests and new request IDs for same source selection create only one copy',async()=>{
  const f=await setup();const results=await Promise.all([receiveTextCopy(f.repo,f.reader,f.input),receiveTextCopy(f.repo,f.reader,{...f.input,requestId:'receive-request-002'})]);
  assert.equal(results.filter(r=>!r.alreadyReceived).length,1);
  const repeated=await receiveTextCopy(f.repo,f.reader,{...f.input,requestId:'receive-request-003',target:{mode:'new',storyId:'story-second',title:'另一本'}});
  assert.equal(repeated.storyId,'story-copy');assert.equal(repeated.alreadyReceived,true);
  assert.equal([...f.tables.keys()].filter(k=>k.startsWith('stories:family_reader_')).length,1);
  await assert.rejects(receiveTextCopy(f.repo,f.reader,{...f.input,target:{...f.input.target,title:'冲突请求'}}),{code:'VERSION_CONFLICT'});
});
test('append preserves existing own blocks and old revision, and explicit new experiences remain independent',async()=>{
  const f=await setup();await receiveTextCopy(f.repo,f.reader,f.input);
  const service=createStoryService(f.repo);await service({OPENID:'reader'},{action:'create',storyId:'story-existing',title:'旧故事',writingMode:'objective',memoryIds:[],requestId:'create-existing-story'});
  const chapters=[{id:'chapter-mine',title:'我的',memoryIds:[],content:[{text:'我的旧经历'}]}];
  await service({OPENID:'reader'},{action:'save',storyId:'story-existing',expectedVersion:1,expectedRevisionId:'',requestId:'save-existing-story',revision:{id:'revision-mine',storyId:'story-existing',draft:{title:'旧故事',chapters,...core.flatten(chapters)}}});
  // Another version is a new received snapshot, even if its text happens to match.
  const source=f.tables.get('biography_drafts:family_owner_revision-source');source.revision.id='revision-source-two';
  f.tables.set('biography_drafts:family_owner_revision-source-two',source);f.tables.get('stories:family_owner_story-original').currentRevisionId='revision-source-two';
  const old=structuredClone(f.tables.get('biography_drafts:family_reader_revision-mine'));
  await receiveTextCopy(f.repo,f.reader,{...f.input,sourceRevisionId:'revision-source-two',requestId:'append-request-001',target:{mode:'append',storyId:'story-existing',expectedVersion:2,expectedRevisionId:'revision-mine'}});
  const {story,revision}=copied(f,'story-existing');assert.equal(story.version,3);assert.equal(revision.draft.chapters.length,2);
  assert.deepEqual(revision.draft.chapters[0].content[0].sourceIds,[]);assert.equal(revision.draft.chapters[1].content[0].sourceIds.length,1);
  assert.deepEqual(f.tables.get('biography_drafts:family_reader_revision-mine'),old);
  const edited=applyBlockEdits(revision.draft,[{action:'appendOwn',chapterId:revision.draft.chapters[1].id,text:'我后来又回去了'}],{familyId:'family_reader',storyId:story.id,requestId:'append-own-experience'});
  assert.deepEqual(edited.chapters[1].content[1].sourceIds,[]);
  await assert.rejects(service({OPENID:'reader'},{action:'context',storyId:story.id}),{code:'STORY_PROTOCOL_REQUIRED'});
});
test('protected copy append creates an immutable revision containing only a new owned block',async()=>{
  const f=await setup();await receiveTextCopy(f.repo,f.reader,f.input);
  const before=copied(f),sourceBefore=structuredClone(before.revision.draft.chapters[0].content[0]);
  const input={storyId:before.story.id,revisionId:before.story.currentRevisionId,expectedVersion:before.story.version,
    chapterId:before.revision.draft.chapters[0].id,text:'我后来又回到了这里',requestId:'append-own-request-001'};
  const result=await appendOwnExperience(f.repo,f.reader,input),after=copied(f);
  assert.equal(result.alreadyAppended,false);assert.equal(after.story.version,before.story.version+1);
  assert.equal(after.revision.draft.chapters[0].content.length,2);
  assert.deepEqual(after.revision.draft.chapters[0].content[0],sourceBefore);
  assert.equal(after.revision.draft.chapters[0].content[1].text,input.text);
  assert.deepEqual(after.revision.draft.chapters[0].content[1].sourceIds,[]);
  assert.deepEqual(copied(f).revision,after.revision);
  assert.equal((await appendOwnExperience(f.repo,f.reader,input)).alreadyAppended,true);
  assert.equal(copied(f).story.version,after.story.version);
});
test('protected copy append rejects stale, cross-story and caller-shaped edits atomically',async()=>{
  for(const change of [
    input=>{input.expectedVersion=99;},input=>{input.chapterId='chapter-guessed';},input=>{input.text='';},
    input=>{input.sourceIds=[];},input=>{input.action='edit';},
  ]){
    const f=await setup();await receiveTextCopy(f.repo,f.reader,f.input);const {story,revision}=copied(f);
    const input={storyId:story.id,revisionId:story.currentRevisionId,expectedVersion:story.version,
      chapterId:revision.draft.chapters[0].id,text:'我的补充',requestId:'append-own-request-002'};
    change(input);const before=structuredClone(f.tables);
    await assert.rejects(appendOwnExperience(f.repo,f.reader,input));assert.deepEqual(f.tables,before);
  }
});
test('copy append is available only through the receive gate and ignores unrelated client fields',async()=>{
  const f=await setup();await receiveTextCopy(f.repo,f.reader,f.input);const {story,revision}=copied(f),context={APPID:'wx-original',OPENID:'reader'};
  const input={storyId:story.id,revisionId:story.currentRevisionId,expectedVersion:story.version,
    chapterId:revision.draft.chapters[0].id,text:'我记得那天很热',requestId:'append-own-request-003'};
  const closed=createStoryService(f.repo,{accessEnabled:true,rulesReady:true,bootstrapAppId:'wx-original',sharedReadFamilyIds:['family_reader']});
  await assert.rejects(closed(context,{action:'copyAppendOwn',...input}),{code:'STORY_ACCESS_DISABLED'});
  const open=createStoryService(f.repo,{accessEnabled:true,rulesReady:true,copyReceiveEnabled:true,bootstrapAppId:'wx-original',sharedReadFamilyIds:['family_reader']});
  const result=await open(context,{action:'copyAppendOwn',...input,edits:[{action:'edit'}],sourceIds:['forged']});
  assert.equal(result.ok,true);assert.equal(copied(f).revision.draft.chapters[0].content.at(-1).text,input.text);
});
test('recipient can return only own appended blocks and owner acceptance creates a protected immutable revision',async()=>{
  const f=await setup();await receiveTextCopy(f.repo,f.reader,f.input);let copy=copied(f),chapterId=copy.revision.draft.chapters[0].id;
  await appendOwnExperience(f.repo,f.reader,{storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,
    chapterId,text:'我记得你当时还带着一把蓝伞',requestId:'append-returnable-001'});
  copy=copied(f);const send={storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,chapterId,requestId:'send-return-001'};
  const sent=await sendOwnReturn(f.repo,f.reader,send);assert.equal(sent.status,'pending');
  const pending=await listReturns(f.repo,f.owner);assert.equal(pending.returns.length,1);
  assert.deepEqual(pending.returns[0].blocks.map(block=>block.text),['我记得你当时还带着一把蓝伞']);
  assert.equal(JSON.stringify(pending).includes('那年的夏天'),false);
  const decided=await decideReturn(f.repo,f.owner,{returnId:sent.returnId,decision:'accept',requestId:'accept-return-001'});
  assert.equal(decided.status,'accepted');const original=f.tables.get('stories:family_owner_story-original');
  assert.equal(original.sourcePolicyRequired,true);assert.equal(original.version,4);
  const accepted=f.tables.get('biography_drafts:family_owner_'+original.currentRevisionId).revision;
  const added=accepted.draft.chapters.find(chapter=>chapter.id==='chapter-three').content.at(-1);
  assert.equal(added.text,'我记得你当时还带着一把蓝伞');assert.equal(added.sourceIds.length,1);
  assert.equal(await allowsSources(f.repo,added.sourceIds,'view'),true);assert.equal(await allowsSources(f.repo,added.sourceIds,'copy'),false);
  assert.equal((await decideReturn(f.repo,f.owner,{returnId:sent.returnId,decision:'accept',requestId:'accept-return-001'})).alreadyDecided,true);
  await assert.rejects(sendOwnReturn(f.repo,f.reader,{...send,requestId:'send-return-002'}),{code:'STORY_RETURN_EMPTY'});
});
test('rejecting a returned memory does not alter the original story',async()=>{
  const f=await setup();await receiveTextCopy(f.repo,f.reader,f.input);let copy=copied(f),chapterId=copy.revision.draft.chapters[0].id;
  await appendOwnExperience(f.repo,f.reader,{storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,
    chapterId,text:'我的不同记忆',requestId:'append-returnable-002'});copy=copied(f);
  const sent=await sendOwnReturn(f.repo,f.reader,{storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,
    chapterId,requestId:'send-return-003'}),before=structuredClone(f.tables.get('stories:family_owner_story-original'));
  const result=await decideReturn(f.repo,f.owner,{returnId:sent.returnId,decision:'reject',requestId:'reject-return-001'});
  assert.equal(result.status,'rejected');assert.deepEqual(f.tables.get('stories:family_owner_story-original'),before);
});
test('read permission alone, guessed chapters, stale revisions and caller-supplied policies cannot copy',async()=>{
  for(const modify of [f=>{f.tables.get('story_grants:'+f.grantId).permissions.copy=false;},f=>{f.input.chapterIds=['chapter-one'];},f=>{f.input.sourceRevisionId='revision-stale';},f=>{f.input.permissions={publish:true};},f=>{f.input.target.familyId='family_owner';},f=>{f.tables.get('story_grants:'+f.grantId).status='revoked';}]){
    const f=await setup();modify(f);const before=structuredClone(f.tables);
    await assert.rejects(receiveTextCopy(f.repo,f.reader,f.input));assert.deepEqual(f.tables,before);
  }
  const f=await setup();await assert.rejects(receiveTextCopy(f.repo,f.stranger,f.input));
});
test('photos and backdrops reject the entire copy instead of silently dropping media',async()=>{
  for(const modify of [c=>{c.content.push({photoId:'photo-original'});},c=>{c.backdropImageId='family_owner_img_req-example12';}]){
    const f=await setup(),draft=f.tables.get('biography_drafts:family_owner_revision-source').revision.draft;
    modify(draft.chapters[1]);Object.assign(draft,core.flatten(draft.chapters));const before=structuredClone(f.tables);
    await assert.rejects(receiveTextCopy(f.repo,f.reader,f.input),{code:'STORY_COPY_MEDIA_PENDING'});assert.deepEqual(f.tables,before);
  }
});
test('duplicate target title, target version conflict and transactional write failure leave no partial copy',async()=>{
  for(const mode of ['title','version','failure']){
    const f=await setup(),service=createStoryService(f.repo);
    await service({OPENID:'reader'},{action:'create',storyId:'story-existing',title:'我的夏天',writingMode:'objective',memoryIds:[],requestId:'create-existing-story'});
    if(mode==='version')f.input.target={mode:'append',storyId:'story-existing',expectedVersion:0,expectedRevisionId:''};
    if(mode==='failure'){
      f.input.target.title='唯一名称';const transaction=f.repo.transaction;
      f.repo.transaction=fn=>transaction(tx=>fn({...tx,set:async(table,id,value)=>{if(table==='stories')throw new Error('storage offline');return tx.set(table,id,value);}}));
    }
    const before=structuredClone(f.tables);await assert.rejects(receiveTextCopy(f.repo,f.reader,f.input));assert.deepEqual(f.tables,before);
  }
});
test('identity and source access are checked inside the write transaction',async()=>{
  const f=await setup(),transaction=f.repo.transaction;
  f.repo.transaction=fn=>{f.tables.get('story_grants:'+f.grantId).status='revoked';return transaction(fn);};
  await assert.rejects(receiveTextCopy(f.repo,f.reader,f.input),{code:'STORY_FORBIDDEN'});
  assert.equal(f.tables.has('stories:family_reader_story-copy'),false);
});
test('completed replay cannot bypass identity revocation or resurrect a deleted destination',async()=>{
  const f=await setup();await receiveTextCopy(f.repo,f.reader,f.input);
  f.tables.get('stories:family_reader_story-copy').deletedAt='2026-09-18';
  assert.equal((await receiveTextCopy(f.repo,f.reader,f.input)).alreadyReceived,true);
  assert.equal(f.tables.get('stories:family_reader_story-copy').deletedAt,'2026-09-18');
  f.tables.get('story_identity_aliases:'+f.reader.aliasId).status='revoked';
  await assert.rejects(receiveTextCopy(f.repo,f.reader,f.input),{code:'STORY_FORBIDDEN'});
});
test('copy count and protocol bounds fail without persisting receipts',async()=>{
  for(const mode of ['version','blocks']){
    const f=await setup(),draft=f.tables.get('biography_drafts:family_owner_revision-source').revision.draft;
    if(mode==='version')draft.provenanceVersion=99;
    else {draft.chapters[1].content=Array.from({length:513},()=>({text:'字'}));Object.assign(draft,core.flatten(draft.chapters));}
    const before=structuredClone(f.tables);await assert.rejects(receiveTextCopy(f.repo,f.reader,f.input));assert.deepEqual(f.tables,before);
  }
});
test('late failure rolls back manuscript, receipts, name reservation and operation together',async()=>{
  const f=await setup(),before=structuredClone(f.tables),transaction=f.repo.transaction;
  f.repo.transaction=fn=>transaction(tx=>fn({...tx,set:async(table,id,value)=>{if(table==='story_copy_requests')throw new Error('last write failed');return tx.set(table,id,value);}}));
  await assert.rejects(receiveTextCopy(f.repo,f.reader,f.input),/last write failed/);assert.deepEqual(f.tables,before);
  f.repo.transaction=transaction;assert.equal((await receiveTextCopy(f.repo,f.reader,f.input)).alreadyReceived,false);
});
test('copy implementation stays closed at the public dispatcher while its dedicated gate is off',async()=>{
  const f=await setup(),before=structuredClone(f.tables),service=createStoryService(f.repo,{accessEnabled:true,rulesReady:true,bootstrapAppId:'wx-original',sharedReadFamilyIds:['family_owner','family_reader']});
  assert.equal((await service({APPID:'wx-original',OPENID:'reader'},{action:'capabilities'})).copy,false);
  await assert.rejects(service({APPID:'wx-original',OPENID:'reader'},{action:'copyReceive',...f.input}));
  assert.deepEqual(f.tables,before);
});
test('gated dispatcher receives only a source reference and creates the server-read snapshot',async()=>{
  const f=await setup(),service=createStoryService(f.repo,{accessEnabled:true,rulesReady:true,copyReceiveEnabled:true,
    bootstrapAppId:'wx-original',sharedReadFamilyIds:['family_owner','family_reader']});
  const context={APPID:'wx-original',OPENID:'reader'};
  assert.equal((await service(context,{action:'capabilities'})).copy,true);
  const read=await service(context,{action:'sharedRead',familyId:'family_owner',storyId:'story-original'});
  assert.equal(read.capabilities.copy,true);
  const result=await service(context,{action:'copyReceive',...f.input,clientDraft:{chapters:[{content:[{text:'伪造正文'}]}]}});
  assert.equal(result.storyId,'story-copy');
  const saved=copied(f).revision;
  assert.equal(JSON.stringify(saved).includes('伪造正文'),false);
  assert.equal(saved.draft.chapters[0].content[0].text,'那年的夏天');
});
test('overlapping chapter selections cannot receive the same source chapter twice',async()=>{
  const f=await setup();f.tables.get('story_grants:'+f.grantId).scope.chapterIds=['chapter-one','chapter-three'];
  await receiveTextCopy(f.repo,f.reader,f.input);const before=structuredClone(f.tables);
  await assert.rejects(receiveTextCopy(f.repo,f.reader,{...f.input,requestId:'receive-overlapping-001',chapterIds:['chapter-one','chapter-three'],target:{mode:'new',storyId:'story-another',title:'两章'}}),{code:'VERSION_CONFLICT'});
  assert.deepEqual(f.tables,before);
});
test('inherited policies must still permit retained viewing and fit bounds after adding the copy receipt',async()=>{
  const {materializeOwnedDraft}=require('../cloudfunctions/storyBooks/provenance');
  for(const mode of ['denied-view','too-deep','allowed']){
    const f=await setup(),record=f.tables.get('biography_drafts:family_owner_revision-source');
    record.revision.draft=materializeOwnedDraft(record.revision.draft,{familyId:'family_owner',storyId:'story-original',revisionId:'revision-source'});
    const ids=Array.from({length:mode==='too-deep'?9:1},(_,i)=>'source-'+String(i).padStart(64,'0'));
    for(let i=0;i<ids.length;i++)f.tables.set('story_source_policies:'+ids[i],{version:1,parents:ids[i+1]?[ids[i+1]]:[],permissions:{copy:true,view:mode!=='denied-view',forward:false,publish:false}});
    record.revision.draft.chapters[1].content[0].sourceIds=[ids[0]];Object.assign(record.revision.draft,core.flatten(record.revision.draft.chapters));
    const before=structuredClone(f.tables);
    if(mode==='allowed'){
      await receiveTextCopy(f.repo,f.reader,f.input);
      const sources=copied(f).revision.draft.chapters[0].content[0].sourceIds;
      assert.equal(await allowsSources(f.repo,sources,'view'),true);assert.equal(await allowsSources(f.repo,sources,'publish'),false);
    }else {await assert.rejects(receiveTextCopy(f.repo,f.reader,f.input),{code:'STORY_FORBIDDEN'});assert.deepEqual(f.tables,before);}
  }
});
