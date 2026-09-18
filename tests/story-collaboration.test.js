const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const { aliasIdFor } = require('../cloudfunctions/storyBooks/identity');
const { grantIdFor } = require('../cloudfunctions/storyBooks/access');
const core = require('../cloudfunctions/storyBooks/core');

async function setup() {
  const f = fixture(); f.account('owner'); f.account('editor');
  let approvals = 0;
  const options = {accessEnabled:true,rulesReady:true,invitationsEnabled:true,sharedEditEnabled:true,bootstrapAppId:'wx-original',
    sharedReadFamilyIds:['family_owner','family_editor'],approveSharedEdit:async()=>{approvals++;return true;}};
  const service=createStoryService(f.repo,options),call=(who,action,input={})=>service({APPID:'wx-original',OPENID:who},{action,...input});
  await call('owner','create',{storyId:'story-a',title:'故事',writingMode:'objective',memoryIds:[],requestId:'create-story-a'});
  await call('editor','capabilities');
  const principal=who=>f.tables.get(`story_identity_aliases:${aliasIdFor('wx-original',who)}`).principalId;
  const chapters=[
    {id:'chapter-one',title:'第一章',memoryIds:[],content:[{text:'不能读取'}]},
    {id:'chapter-three',title:'第三章',memoryIds:[],content:[{text:'开头',sourcePolicyId:'policy-a'},{photoId:'photo-kept'},{text:'结尾'}]},
  ];
  const draft={title:'故事',chapters,...core.flatten(chapters),sourceCount:0,generatedAt:'2026-09-18T00:00:00.000Z',generationMode:'local-demo'};
  const story=f.tables.get('stories:family_owner_story-a');story.currentRevisionId='revision-a';
  f.tables.set('biography_drafts:family_owner_revision-a',{familyId:'family_owner',storyId:'story-a',draftType:'story-revision',
    revision:{id:'revision-a',storyId:'story-a',memberId:'owner',kind:'draft',label:'原稿',savedAt:'2026-09-18T00:00:00.000Z',sourceFingerprint:'source-a',draft}});
  const grantId=grantIdFor('family_owner','story-a',principal('editor'));
  f.tables.set(`story_grants:${grantId}`,{familyId:'family_owner',storyId:'story-a',principalId:principal('editor'),ownerPrincipalId:principal('owner'),
    status:'active',version:1,scope:{type:'chapters',chapterIds:['chapter-three']},permissions:{read:true,edit:true}});
  const input={familyId:'family_owner',storyId:'story-a',chapterId:'chapter-three',revisionId:'revision-a',expectedVersion:1,
    requestId:'collab-request-1',title:'第三章（合写）',textBlocks:[{index:0,text:'新的开头'},{index:2,text:'新的结尾'}]};
  return {...f,call,service,options,principal,grantId,input,approvals:()=>approvals};
}

test('authorized editor changes only the granted chapter and the server preserves media and provenance',async()=>{
  const f=await setup();
  const before=await f.call('editor','sharedRead',{familyId:'family_owner',storyId:'story-a'});
  assert.equal(before.capabilities.sharedEdit,true);
  assert.deepEqual(before.chapters[0].textBlocks,[{index:0,text:'开头'},{index:2,text:'结尾'}]);
  const result=await f.call('editor','sharedEdit',f.input);
  assert.equal(result.version,2);
  const saved=f.tables.get(`biography_drafts:family_owner_${result.revisionId}`).revision;
  assert.equal(saved.editedByPrincipalId,f.principal('editor'));
  assert.deepEqual(saved.editedChapterIds,['chapter-three']);
  assert.equal(saved.draft.chapters[0].content[0].text,'不能读取');
  assert.deepEqual(saved.draft.chapters[1].content,[{text:'新的开头',sourcePolicyId:'policy-a'},{photoId:'photo-kept'},{text:'新的结尾'}]);
  assert.equal(saved.draft.content.some(item=>item.photoId==='photo-kept'),true);
});

test('replay is idempotent, while stale concurrent edits and tampered blocks keep the current manuscript',async()=>{
  const f=await setup();
  const first=await f.call('editor','sharedEdit',f.input);
  assert.deepEqual(await f.call('editor','sharedEdit',f.input),first);
  assert.equal(f.approvals(),1);
  await assert.rejects(f.call('editor','sharedEdit',{...f.input,requestId:'collab-request-2',textBlocks:[{index:0,text:'覆盖'}]}),{code:'VERSION_CONFLICT'});
  assert.equal(f.approvals(),1,'invalid chapter shape is denied before content review');
  await assert.rejects(f.call('editor','sharedEdit',{...f.input,requestId:'collab-request-3'}),{code:'VERSION_CONFLICT'});
  assert.equal(f.tables.get('stories:family_owner_story-a').currentRevisionId,first.revisionId);
});

test('revocation and cross-chapter guesses are denied before moderation or writes',async()=>{
  const f=await setup();
  await assert.rejects(f.call('editor','sharedEdit',{...f.input,chapterId:'chapter-one',requestId:'collab-request-4'}),{code:'STORY_FORBIDDEN'});
  f.tables.get(`story_grants:${f.grantId}`).status='revoked';
  await assert.rejects(f.call('editor','sharedEdit',f.input),{code:'STORY_FORBIDDEN'});
  assert.equal(f.approvals(),0);
  assert.equal(f.tables.get('stories:family_owner_story-a').currentRevisionId,'revision-a');
});

test('owner can grant edit only when the dedicated rollout gate is enabled',async()=>{
  const f=await setup();
  const created=await f.call('owner','inviteCreate',{familyId:'family_owner',storyId:'story-a',chapterIds:['chapter-three'],permissions:{read:true,forward:false,edit:true}});
  assert.match(created.token,/^[a-f0-9]{48}$/);
  await assert.rejects(createStoryService(f.repo,{...f.options,sharedEditEnabled:false})({APPID:'wx-original',OPENID:'owner'},
    {action:'inviteCreate',familyId:'family_owner',storyId:'story-a',chapterIds:['chapter-three'],permissions:{read:true,forward:false,edit:true}}),
  {code:'STORY_ACCESS_NOT_READY'});
});
