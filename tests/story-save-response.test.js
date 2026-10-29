const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const { aliasIdFor } = require('../cloudfunctions/storyBooks/identity');
const context = {APPID:'wx-original', OPENID:'owner'};
async function setup() {
  const f=fixture(); f.account('owner');
  const service=createStoryService(f.repo,{accessEnabled:true,rulesReady:true,bootstrapAppId:'wx-original'});
  await service(context,{action:'create',storyId:'story-test',title:'测试',writingMode:'objective',memoryIds:[],requestId:'create-story-test'});
  const revision={id:'revision-inline',storyId:'story-test',memberId:'owner',kind:'version',label:'保存',savedAt:'',sourceFingerprint:'',
    draft:{title:'测试',chapters:[],content:[],paragraphs:[],sourceCount:0,generatedAt:'',generationMode:'local-demo'}};
  const save={action:'save',storyId:'story-test',expectedVersion:1,expectedRevisionId:'',revision,requestId:revision.id};
  return {...f,service,save};
}
test('save returns authoritative current state in the receipt without changing replay fingerprints',async()=>{
  const {service,save,tables}=await setup();
  const legacy=await service(context,save);
  assert.equal(legacy.savedState,undefined);
  const result=await service(context,{...save,returnState:'home'});
  assert.equal(result.ok,true);
  assert.equal(result.savedState.roomStateVersion,1);
  assert.equal(result.savedState.stories[0].currentRevisionId,save.revision.id);
  assert.equal(result.savedState.manuscriptRevisions[0].id,save.revision.id);
  assert.equal([...tables.keys()].filter(key=>key.startsWith('biography_drafts:')).length,1);
  await assert.rejects(service(context,{...save,returnState:'home',requestId:'different-request',revision:{...save.revision,id:'revision-other'}}));
  await assert.rejects(service({}, {...save,returnState:'home'}),{code:'AUTH_REQUIRED'});
});
test('save readback failure keeps a confirmed receipt so the client can retry the read',async()=>{
  const {service,save,repo,tables}=await setup();
  const all=repo.all;
  repo.all=async(table,id)=>{if(table==='family_members' && tables.has('biography_drafts:family_owner_revision-inline'))throw new Error('read temporarily down');return all(table,id);};
  const result=await service(context,{...save,returnState:'home'});
  assert.deepEqual(result,{ok:true,storyId:'story-test'});
  repo.all=all;
  const retry=await service(context,{...save,returnState:'home'});
  assert.equal(retry.savedState.stories[0].currentRevisionId,save.revision.id);
});
test('large save readbacks fall back to chunked state reads instead of overflowing the receipt',async()=>{
  const {service,save,tables}=await setup();
  tables.get('families:family_owner').roomName='测'.repeat(200000);
  const result=await service(context,{...save,returnState:'home'});
  assert.deepEqual(result,{ok:true,storyId:'story-test'});
  const state=await service(context,{action:'state',view:'home',stateTransport:1});
  assert.equal(state.stateTransport,1);
});
test('revocation during save readback never releases the resulting room state',async()=>{
  const {service,save,repo,tables}=await setup();
  const all=repo.all;
  repo.all=async(table,id)=>{
    const result=await all(table,id);
    if(table==='family_members' && tables.has('biography_drafts:family_owner_revision-inline'))tables.get('story_identity_aliases:'+aliasIdFor('wx-original','owner')).status='revoked';
    return result;
  };
  await assert.rejects(service(context,{...save,returnState:'home'}),{code:'STORY_FORBIDDEN'});
});
