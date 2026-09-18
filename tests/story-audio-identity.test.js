const test=require('node:test');
const assert=require('node:assert/strict');
const {accountDocumentIdFor,resolveStoryAudioIdentity}=require('../cloudfunctions/storyAudio/identity');

test('story audio follows the migrated stable account and family mapping',async()=>{
  const openid='new-app-openid',documentId=accountDocumentIdFor(openid);
  const db={collection:()=>({doc:id=>({async get(){assert.equal(id,documentId);return {data:{accountId:'account_111111111111111111111111',primaryFamilyId:'family_original',status:'active'}};}})})};
  assert.deepEqual(await resolveStoryAudioIdentity(db,openid),{openid,accountId:'account_111111111111111111111111',familyId:'family_original'});
});

test('story audio fails closed to the current account namespace when mapping is absent or malformed',async()=>{
  const missing={collection:()=>({doc:()=>({async get(){throw new Error('not found');}})})};
  const result=await resolveStoryAudioIdentity(missing,'new-openid');
  assert.equal(result.familyId,'family_new-openid');
  assert.match(result.accountId,/^account_[0-9a-f]{24}$/);
});
