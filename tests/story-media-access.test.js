const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/story-access-fixture');
const {resolveStoryIdentity}=require('../cloudfunctions/storyBooks/identity');
const {grantIdFor}=require('../cloudfunctions/storyBooks/access');
const {readStoryMedia}=require('../cloudfunctions/storyBooks/media');
async function setup(){
  const f=fixture();f.account('owner');f.account('reader');
  const identity=who=>resolveStoryIdentity(f.repo,{APPID:'wx-original',OPENID:who},{bootstrapAppId:'wx-original'});
  const owner=await identity('owner'),reader=await identity('reader');
  f.tables.set('stories:family_owner_story-a',{id:'story-a',familyId:'family_owner',currentRevisionId:'revision-a',version:1});
  f.tables.set('biography_drafts:family_owner_revision-a',{familyId:'family_owner',storyId:'story-a',revision:{id:'revision-a',storyId:'story-a',draft:{chapters:[{id:'chapter-one',content:[{photoId:'photo-other'}]},{id:'chapter-three',content:[{photoId:'photo-visible'}]}]}}});
  const grantId=grantIdFor('family_owner','story-a',reader.principalId);
  f.tables.set('story_grants:'+grantId,{familyId:'family_owner',storyId:'story-a',principalId:reader.principalId,ownerPrincipalId:owner.principalId,status:'active',version:1,scope:{type:'chapters',chapterIds:['chapter-three']},permissions:{read:true}});
  f.tables.set('photos:family_owner__photo-visible',{familyId:'family_owner',photoId:'photo-visible',_openid:'owner',displayFileID:'cloud://env/user-photos/family_owner/photo-visible/display.jpg',moderation:{ok:true,suggest:'pass'}});
  const input={familyId:'family_owner',storyId:'story-a',chapterId:'chapter-three',photoId:'photo-visible',purpose:'view'};
  return {...f,reader,grantId,input};
}
test('shared photo access is exact-chapter, view-only, moderated and returns no raw file ID',async()=>{
  const f=await setup();let signed=0;
  const sign=async(fileID,maxAge)=>{signed++;assert.equal(maxAge,300);assert.match(fileID,/photo-visible/);return 'https://example.com/signed';};
  const result=await readStoryMedia(f.repo,f.reader,f.input,sign);
  assert.equal(result.url,'https://example.com/signed');assert.equal(JSON.stringify(result).includes('cloud://'),false);
  for(const patch of [{purpose:'export'},{purpose:'ai-reference'},{chapterId:'chapter-one'},{photoId:'photo-other'}])await assert.rejects(readStoryMedia(f.repo,f.reader,{...f.input,...patch},sign));
  assert.equal(signed,1);
  f.tables.get('photos:family_owner__photo-visible').moderation.ok=false;
  await assert.rejects(readStoryMedia(f.repo,f.reader,f.input,sign));assert.equal(signed,1);
});
test('revocation while signing or stale photo descriptor never releases a signed URL',async()=>{
  for(const mutate of [f=>{f.tables.get('story_grants:'+f.grantId).status='revoked';},f=>{f.tables.get('photos:family_owner__photo-visible').deletedAt='today';}]) {
    const f=await setup();await assert.rejects(readStoryMedia(f.repo,f.reader,f.input,async()=>{mutate(f);return 'https://example.com/signed';}));
  }
});
test('source-bound photo with missing receipt is denied even though read grant exists',async()=>{
  const f=await setup();f.tables.get('stories:family_owner_story-a').sourcePolicyRequired=true;
  await assert.rejects(readStoryMedia(f.repo,f.reader,f.input,async()=>{throw new Error('must not sign');}),{code:'STORY_FORBIDDEN'});
});
test('source-marked asset cannot bypass policies through an unmarked chapter',async()=>{
  for(const marker of [{sourcePolicyRequired:true},{sourceIds:[]}]){
    const f=await setup();let signed=false;
    Object.assign(f.tables.get('photos:family_owner__photo-visible'),marker);
    await assert.rejects(readStoryMedia(f.repo,f.reader,f.input,async()=>{signed=true;return 'https://example.com/signed';}),{code:'STORY_FORBIDDEN'});
    assert.equal(signed,false);
  }
});
test('media dispatcher requires explicit opt-in, both canaries and a current grant',async()=>{
  const {createStoryService}=require('../cloudfunctions/storyBooks/service');
  const f=await setup();let signed=0;
  const options={accessEnabled:true,rulesReady:true,bootstrapAppId:'wx-original',sharedMediaEnabled:true,sharedReadFamilyIds:['family_owner','family_reader'],signMedia:async()=>{signed++;return 'https://example.com/signed';}};
  const context={APPID:'wx-original',OPENID:'reader'},event={...f.input,action:'sharedMedia'};
  for(const patch of [{accessEnabled:false},{sharedMediaEnabled:false},{sharedMediaEnabled:undefined},{sharedReadFamilyIds:['family_owner']},{sharedReadFamilyIds:['family_reader']}]){
    await assert.rejects(createStoryService(f.repo,{...options,...patch})(context,event),{code:'STORY_ACCESS_DISABLED'});
  }
  assert.equal(signed,0);
  assert.equal((await createStoryService(f.repo,options)(context,event)).purpose,'view');
  f.tables.get('story_grants:'+f.grantId).status='revoked';
  await assert.rejects(createStoryService(f.repo,options)(context,event),{code:'STORY_FORBIDDEN'});
  assert.equal(signed,1);
});
