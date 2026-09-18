const test=require('node:test');
const assert=require('node:assert/strict');
const {shareExcerpt}=require('../cloudfunctions/storyBooks/excerpts');

function fixture(){
  const tables=new Map(),familyId='family_owner',principalId='principal_'+'1'.repeat(32),accountId='account_'+'2'.repeat(24);
  const key=(table,id)=>table+'/'+id;
  const seed=(table,id,value)=>tables.set(key(table,id),structuredClone(value));
  const repo={
    async get(table,id){return structuredClone(tables.get(key(table,id)));},
    async set(table,id,value){tables.set(key(table,id),structuredClone(value));},
    transaction:fn=>fn(repo),
  };
  const story={id:'story-a',familyId,title:'院子',bookTitle:'院子里的夏天',version:2,currentRevisionId:'revision-a'};
  const draft={title:'院子里的夏天',generatedAt:'2026-09-18T00:00:00Z',chapters:[{
    id:'chapter-a',title:'桂花树',memoryIds:[],content:[{text:'第一段。'},{photoId:'photo-one'},{text:'外公撑着伞在巷口等我。'}],
  }]};
  const ctx={familyId,principalId,accountId,aliasId:'a'.repeat(64),appId:'wx-app'};
  seed('story_identity_aliases',ctx.aliasId,{status:'active',appId:ctx.appId,principalId});
  seed('story_principals',principalId,{status:'active',familyId,accountId});
  seed('story_principal_spaces',familyId,{status:'active',principalId,accountId});
  seed('families',familyId,{ownerAccountId:accountId,storyBooks:{status:'active'}});
  seed('family_members',familyId+'_owner',{id:'owner',memberId:'owner',familyId,name:'岱',relation:'自己',role:'owner'});
  seed('family_members',familyId+'_member-1',{id:'member-1',memberId:'member-1',familyId,name:'林秋',relation:'家人',role:'contributor'});
  seed('stories',familyId+'_story-a',story);
  seed('biography_drafts',familyId+'_revision-a',{familyId,storyId:story.id,revision:{id:'revision-a',storyId:story.id,draft}});
  const input={storyId:'story-a',revisionId:'revision-a',expectedVersion:2,chapterId:'chapter-a',
    text:'外公撑着伞在巷口等我。',recipientMemberIds:['member-1'],requestId:'excerpt-request-1'};
  return {repo,tables,seed,key,ctx,story,draft,input};
}

test('saved owner excerpt creates one server-bound private memory',async()=>{
  const f=fixture();
  const result=await shareExcerpt(f.repo,f.ctx,f.input,{approve:async()=>true,now:()=> '2026-09-18T01:00:00Z'});
  assert.equal(result.ok,true);
  const memory=f.tables.get(f.key('memories','family_owner_'+result.contributionId));
  assert.equal(memory.text,f.input.text);
  assert.deepEqual(memory.sharedWithMemberIds,['member-1']);
  assert.equal(memory.sourceStoryId,'story-a');
  assert.equal(memory.sourceRevisionId,'revision-a');
  assert.equal(memory.sourceChapterId,'chapter-a');
  assert.equal(memory.sourceBlockIndex,2);
  const replay=await shareExcerpt(f.repo,f.ctx,f.input,{approve:async()=>true});
  assert.deepEqual(replay,result);
});

test('excerpt rejects client text outside the saved block and cross-block joins',async()=>{
  for(const text of ['被替换的正文','第一段。外公撑着伞在巷口等我。']){
    const f=fixture();
    await assert.rejects(shareExcerpt(f.repo,f.ctx,{...f.input,text},{approve:async()=>true}),{code:'STORY_EXCERPT_MISMATCH'});
    assert.equal([...f.tables.keys()].some(id=>id.includes('story_excerpt_operations/')),false);
  }
});

test('excerpt rejects protected, stale, deleted and foreign records',async()=>{
  for(const mode of ['story','draft','stale','deleted','foreign']){
    const f=fixture();
    if(mode==='story')f.story.sourcePolicyRequired=true;
    if(mode==='draft')f.draft.provenanceVersion=1;
    if(mode==='stale')f.story.version=3;
    if(mode==='deleted')f.story.deletedAt='now';
    if(mode==='foreign')f.story.familyId='family_other';
    f.seed('stories','family_owner_story-a',f.story);
    f.seed('biography_drafts','family_owner_revision-a',{familyId:'family_owner',storyId:'story-a',revision:{id:'revision-a',storyId:'story-a',draft:f.draft}});
    await assert.rejects(shareExcerpt(f.repo,f.ctx,f.input,{approve:async()=>true}));
  }
});

test('excerpt validates active recipients and content approval before writing',async()=>{
  for(const mode of ['missing','deleted','rejected']){
    const f=fixture();
    if(mode==='missing')f.tables.delete(f.key('family_members','family_owner_member-1'));
    if(mode==='deleted')f.seed('family_members','family_owner_member-1',{id:'member-1',memberId:'member-1',familyId:'family_owner',deletedAt:'now'});
    await assert.rejects(shareExcerpt(f.repo,f.ctx,f.input,{approve:async()=>mode!=='rejected'}));
    assert.equal([...f.tables.keys()].some(id=>id.startsWith('memories/')),false);
  }
});

test('excerpt request IDs are idempotent but cannot be reused with another payload',async()=>{
  const f=fixture();
  await shareExcerpt(f.repo,f.ctx,f.input,{approve:async()=>true});
  let approvalCalls=0;
  await shareExcerpt(f.repo,f.ctx,f.input,{approve:async()=>{approvalCalls++;return false;}});
  assert.equal(approvalCalls,0,'a lost response retry must not depend on another moderation call');
  await assert.rejects(shareExcerpt(f.repo,f.ctx,{...f.input,text:'第一段。'},{approve:async()=>true}),{code:'VERSION_CONFLICT'});
});
