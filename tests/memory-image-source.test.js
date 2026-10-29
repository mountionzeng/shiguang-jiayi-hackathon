const test = require('node:test');
const assert = require('node:assert/strict');
const {memorySource, assertMemoryImage} = require('../cloudfunctions/storyImages/memory');
const {normalizeSubmitInput} = require('../cloudfunctions/storyImages/core');
const familyId = 'family_test';
const memoryId = 'memory-fixture';
const source = () => ({familyId, scope:'personal', reviewStatus:'confirmed', authorMemberId:'owner', title:'虚构片段', text:'虚构人物在树下读书。', photoIds:['photo-user','photo-ai-req-12345678']});
const image = () => ({_id:familyId+'_img_req-12345678', familyId, memoryId, requestId:'req-12345678', purpose:'illustration', moderation:'pass', fileID:`cloud://env.bucket/story-images/${familyId}/memory-${memoryId}/req-12345678.png`});

test('memory source uses saved words and user photos, without recycling AI illustrations as evidence', () => {
 const result = memorySource(source(),'owner',familyId,memoryId);
 assert.equal(result.scope,'memory'); assert.equal(result.text,source().text);
 assert.deepEqual(result.photoIds,['photo-user']);
 assert.notEqual(result.fullTextHash,memorySource({...source(),text:'另一个虚构片段。'},'owner',familyId,memoryId).fullTextHash);
 assert.notEqual(result.fullTextHash,memorySource({...source(),title:'新标题'},'owner',familyId,memoryId).fullTextHash);
});
test('memory generation refuses another author, deleted, shared, unconfirmed and restricted sources', () => {
 for (const change of [{authorMemberId:'other'},{deletedAt:'now'},{scope:'family'},{reviewStatus:'pending'},{sourcePolicyRequired:true}]) {
  assert.throws(()=>memorySource({...source(),...change},'owner',familyId,memoryId),{code:'MEMORY_NOT_FOUND'});
 }
});
test('memory images must pass moderation and match the exact memory file and image identity', () => {
 assert.doesNotThrow(()=>assertMemoryImage(image(),familyId,memoryId));
 for (const change of [{moderation:'pending'},{memoryId:'other'},{storyId:'story-other'},{_id:'another'},{deletedAtMs:0},{fileID:`cloud://env.bucket/story-images/${familyId}/memory-${memoryId}/nested/req-12345678.png`}]) {
  assert.throws(()=>assertMemoryImage({...image(),...change},familyId,memoryId),{code:'IMAGE_NOT_READY'});
 }
});
test('memory scope cannot be combined with a story, member, backdrop or numeric memory ID', () => {
 const input={familyId,memoryId,requestId:'req-12345678',purpose:'illustration'};
 assert.equal(normalizeSubmitInput(input).chapterId,'memory');
 for (const change of [{storyId:'story-other'},{memberId:'owner'},{purpose:'backdrop'},{memoryId:123}]) {
  assert.throws(()=>normalizeSubmitInput({...input,...change}),{code:'INVALID_MEMORY'});
 }
});
