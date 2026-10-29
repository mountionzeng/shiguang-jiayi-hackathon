const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');

async function setup() {
  const f = fixture();
  f.account('owner'); f.account('other');
  const options = { accessEnabled:true, rulesReady:true, bootstrapAppId:'wx-original' };
  const service = createStoryService(f.repo, options);
  const call = (action, input={}, who='owner') => service({APPID:'wx-original',OPENID:who},{action,...input});
  await call('create',{storyId:'story-one',title:'One',writingMode:'objective',requestId:'create-story-one'});
  for (const [id, storyId, savedAt] of [['revision-old','story-one','2026-01-01'],['revision-new','story-one','2026-02-01'],['revision-other','story-other','2026-03-01']]) {
    f.tables.set('biography_drafts:family_owner_'+id,{familyId:'family_owner',storyId,revision:{id,storyId,kind:'version',label:id,savedAt,sourceFingerprint:'keep',draft:{title:id,paragraphs:['x'.repeat(600000)]}}});
  }
  return {...f,call,options};
}
test('history lists only the selected story metadata in one small response, with full detail on demand',async()=>{
  const f=await setup();
  const result=await f.call('history',{storyId:'story-one',familyId:'family_other'});
  assert.deepEqual(result.history.map(r=>r.id),['revision-new','revision-old']);
  assert.ok(JSON.stringify(result).length<1000);
  assert.ok(result.history.every(r=>!('draft' in r) && !('sourceFingerprint' in r)));
  const detail=await f.call('revision',{storyId:'story-one',revisionId:'revision-old'});
  assert.equal(detail.revision.sourceFingerprint,'keep');
  assert.equal(detail.revision.draft.paragraphs[0].length,600000);
  await assert.rejects(f.call('revision',{storyId:'story-one',revisionId:'revision-other'}));
  await assert.rejects(f.call('history',{storyId:'story-one'},'other'));
});
test('history fails closed on deleted stories, mismatched revision ownership and revocation during a read',async()=>{
  const f=await setup();
  f.tables.get('biography_drafts:family_owner_revision-old').familyId='family_other';
  await assert.rejects(f.call('revision',{storyId:'story-one',revisionId:'revision-old'}));
  f.tables.get('stories:family_owner_story-one').deletedAt='today';
  await assert.rejects(f.call('history',{storyId:'story-one'}));
  delete f.tables.get('stories:family_owner_story-one').deletedAt;
  const all=f.repo.all;
  f.repo.all=async (...args)=>{const rows=await all(...args); f.tables.get('story_principal_spaces:family_owner').status='revoked'; return rows;};
  await assert.rejects(f.call('history',{storyId:'story-one'}),{code:'STORY_FORBIDDEN'});
});

test('history scopes its database query to the selected story before loading revision metadata',async()=>{
  const f=await setup();
  const reads=[];const all=f.repo.all;
  f.repo.all=async (...args)=>{reads.push(args);return all(...args)};
  await f.call('history',{storyId:'story-one',familyId:'family_other'});
  const read=reads.find(([table])=>table==='biography_drafts');
  assert.equal(read[1],'family_owner');
  assert.deepEqual(read[3],{storyId:'story-one'});
  assert.equal(read[2]['revision.draft'],undefined);
});
