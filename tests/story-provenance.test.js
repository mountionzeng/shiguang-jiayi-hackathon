const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../cloudfunctions/storyBooks/core');
const { materializeOwnedDraft, applyBlockEdits, allowsSources, assertLegacyWritable } = require('../cloudfunctions/storyBooks/provenance');
const sourceA='source-'+ 'a'.repeat(64), sourceB='source-'+ 'b'.repeat(64);
const scope={familyId:'family_owner',storyId:'story-a',revisionId:'revision-old'};
function draft() {
  const chapters=[{id:'chapter-one',title:'第一章',memoryIds:[],content:[{text:'原文字'},{text:'第二段'}]}];
  return {title:'故事',chapters,...core.flatten(chapters),sourceCount:0,generatedAt:'',generationMode:'local-demo'};
}
function restricted() {const d=materializeOwnedDraft(draft(),scope);d.chapters[0].content[0].sourceIds=[sourceA];d.chapters[0].content[1].sourceIds=[sourceB];Object.assign(d,core.flatten(d.chapters));return d;}
test('legacy blocks receive deterministic scoped IDs without modifying old snapshots',()=>{
  const original=draft(), before=structuredClone(original), one=materializeOwnedDraft(original,scope);
  assert.deepEqual(one,materializeOwnedDraft(original,scope));assert.deepEqual(original,before);
  assert.notEqual(one.chapters[0].content[0].blockId,materializeOwnedDraft(original,{...scope,storyId:'story-b'}).chapters[0].content[0].blockId);
  assert.deepEqual(one.chapters[0].content[0].sourceIds,[]);
  core.validateDraft(one,{memoryIds:[]});
});
test('rewrite and merge retain source union; explicit own addition does not inherit sources',()=>{
  const original=restricted(), blocks=original.chapters[0].content;
  const changed=applyBlockEdits(original,[{action:'edit',blockId:blocks[0].blockId,text:'改写'},{action:'merge',blockIds:blocks.map(b=>b.blockId),text:'合并后的回忆'},{action:'appendOwn',chapterId:'chapter-one',text:'我的新经历'}],{...scope,requestId:'request-12345678'});
  assert.deepEqual(changed.chapters[0].content[0].sourceIds,[sourceA,sourceB]);
  assert.deepEqual(changed.chapters[0].content[1].sourceIds,[]);
  assert.deepEqual(changed,applyBlockEdits(original,[{action:'edit',blockId:blocks[0].blockId,text:'改写'},{action:'merge',blockIds:blocks.map(b=>b.blockId),text:'合并后的回忆'},{action:'appendOwn',chapterId:'chapter-one',text:'我的新经历'}],{...scope,requestId:'request-12345678'}));
  core.validateDraft(changed,{memoryIds:[]});
  assert.deepEqual(original.chapters[0].content[0].sourceIds,[sourceA]);
});
test('client cannot clear sources, invent block IDs, convert a photo to text or drop protocol',()=>{
  const d=restricted(),id=d.chapters[0].content[0].blockId;
  for(const edits of [[{action:'edit',blockId:id,text:'新文字',sourceIds:[]}],[{action:'edit',blockId:'block-'+ 'f'.repeat(64),text:'新文字'}],[{action:'delete',blockId:id}]]) assert.throws(()=>applyBlockEdits(d,edits,{...scope,requestId:'request-12345678'}));
  const bad=structuredClone(d);delete bad.provenanceVersion;
  assert.throws(()=>applyBlockEdits(bad,[],scope));
  assert.throws(()=>assertLegacyWritable({sourcePolicyRequired:true},draft()),{code:'STORY_PROTOCOL_REQUIRED'});
  assert.throws(()=>assertLegacyWritable({},d),{code:'STORY_PROTOCOL_REQUIRED'});
  const derived=draft();derived.content[0].sourceIds=[];
  assert.throws(()=>assertLegacyWritable({},derived),{code:'STORY_PROTOCOL_REQUIRED'});
  assert.doesNotThrow(()=>assertLegacyWritable({},draft()));
  const photo=structuredClone(d);photo.chapters[0].content[0]={blockId:id,sourceIds:[sourceA],photoId:'photo-example'};Object.assign(photo,core.flatten(photo.chapters));
  assert.throws(()=>applyBlockEdits(photo,[{action:'edit',blockId:id,text:'不能变成文字'}],{...scope,requestId:'request-12345678'}));
});
test('source DAG takes intersection and remains usable without original story records',async()=>{
  const policies=new Map([[sourceA,{version:1,parents:[],permissions:{copy:true,forward:true,publish:false,view:true,ai:false,export:false}}],[sourceB,{version:1,parents:[sourceA],permissions:{copy:true,forward:false,publish:true,view:true,ai:true,export:true}}]]);
  const reader={get:async(table,id)=>{assert.equal(table,'story_source_policies');return policies.get(id);}};
  assert.equal(await allowsSources(reader,[sourceB],'copy'),true);
  for(const action of ['forward','publish','ai','export'])assert.equal(await allowsSources(reader,[sourceB],action),false);
  assert.equal(await allowsSources(reader,[],'publish'),true);
});
test('missing, cyclic, too-deep, malformed and unavailable policy data fail closed',async()=>{
  const allow={version:1,parents:[],permissions:{copy:true}};
  for(const get of [async()=>undefined,async()=>({...allow,parents:[sourceA]}),async()=>({...allow,permissions:{copy:'true'}}),async()=>{throw new Error('offline');}])assert.equal(await allowsSources({get},[sourceA],'copy'),false);
  const ids=Array.from({length:10},(_,i)=>'source-'+String(i).padStart(64,'0'));
  assert.equal(await allowsSources({get:async(t,id)=>({...allow,parents:ids.indexOf(id)<9?[ids[ids.indexOf(id)+1]]:[]})},[ids[0]],'copy'),false);
  assert.equal(await allowsSources({get:async()=>allow},[], '__proto__'),false);
});
test('legacy service rejects stripped protected saves and AI context without leaving a revision',async()=>{
  const {fixture}=require('./helpers/story-access-fixture');
  const {createStoryService}=require('../cloudfunctions/storyBooks/service');
  const f=fixture();f.account('owner');const service=createStoryService(f.repo);
  const call=input=>service({OPENID:'owner'},input);
  await call({action:'create',storyId:'story-a',title:'故事',writingMode:'objective',memoryIds:[],requestId:'create-story-a'});
  const story=f.tables.get('stories:family_owner_story-a');story.sourcePolicyRequired=true;story.currentRevisionId='revision-old';
  f.tables.set('biography_drafts:family_owner_revision-old',{familyId:'family_owner',storyId:'story-a',revision:{id:'revision-old',storyId:'story-a',draft:restricted()}});
  const command={action:'save',storyId:'story-a',expectedVersion:1,expectedRevisionId:'revision-old',requestId:'request-protected-save',revision:{id:'revision-new',storyId:'story-a',draft:draft()}};
  await assert.rejects(call(command),{code:'STORY_PROTOCOL_REQUIRED'});
  await assert.rejects(call({action:'context',storyId:'story-a'}),{code:'STORY_PROTOCOL_REQUIRED'});
  assert.equal(f.tables.has('biography_drafts:family_owner_revision-new'),false);
  assert.equal(f.tables.has('story_operations:family_owner_request-protected-save'),false);
  assert.equal(f.tables.get('stories:family_owner_story-a').version,1);
});
test('transaction rechecks provenance even if a source marker appears after the initial read',async()=>{
  const {fixture}=require('./helpers/story-access-fixture');const {createStoryService}=require('../cloudfunctions/storyBooks/service');
  const f=fixture();f.account('owner');const service=createStoryService(f.repo),context={OPENID:'owner'};
  await service(context,{action:'create',storyId:'story-a',title:'故事',writingMode:'objective',memoryIds:[],requestId:'create-story-a'});
  const transaction=f.repo.transaction;f.repo.transaction=fn=>{f.tables.get('stories:family_owner_story-a').sourcePolicyRequired=true;return transaction(fn);};
  await assert.rejects(service(context,{action:'update',storyId:'story-a',expectedVersion:1,patch:{title:'偷换'},requestId:'request-update-policy'}),{code:'STORY_PROTOCOL_REQUIRED'});
  assert.equal(f.tables.get('stories:family_owner_story-a').title,'故事');
});
