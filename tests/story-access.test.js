const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateStoryAccess, grantIdFor, readAuthorizedStory } = require('../cloudfunctions/storyBooks/access');
const { resolveStoryIdentity } = require('../cloudfunctions/storyBooks/identity');
const { fixture } = require('./helpers/story-access-fixture');

const principalId = 'principal_' + 'a'.repeat(32);
const ownerPrincipalId = 'principal_' + 'b'.repeat(32);
const resource = { familyId: 'family_owner', id: 'story-a', version: 2 };
const grant = { principalId, ownerPrincipalId, familyId: resource.familyId, storyId: resource.id, status: 'active', version: 1,
  scope: { type: 'chapters', chapterIds: ['chapter-three'] }, permissions: { read: true, edit: true } };
const input = { principalId, ownerPrincipalId, story: resource, grant, action: 'read', chapterIds: ['chapter-three'], nowMs: 100 };

test('chapter permissions are independent capabilities and deny unspecified/management operations', () => {
  assert.equal(evaluateStoryAccess(input), true);
  assert.equal(evaluateStoryAccess({ ...input, action: 'edit' }), true);
  for (const action of ['copy', 'forward', 'publish', 'delete', 'manage', '__proto__']) {
    assert.equal(evaluateStoryAccess({ ...input, action }), false, action);
  }
  for (const chapterIds of [[], ['chapter-other'], ['chapter-three', 'chapter-other']]) {
    assert.equal(evaluateStoryAccess({ ...input, chapterIds }), false);
  }
  assert.equal(evaluateStoryAccess({ ...input, grant: { ...grant, permissions: { read: true, publish: true } }, action: 'publish' }), true);
});

test('wrong principal/resource, revoked/expired grants and malformed permissions fail closed', () => {
  for (const patch of [{ status: 'revoked' }, { principalId: ownerPrincipalId }, { storyId: 'story-b' }, { familyId: 'family_other' },
    { ownerPrincipalId: principalId }, { expiresAtMs: 100 }, { expiresAtMs: 'bad' }, { version: 0 }, { permissions: { read: 'true' } }]) {
    assert.equal(evaluateStoryAccess({ ...input, grant: { ...grant, ...patch } }), false, JSON.stringify(patch));
  }
  assert.equal(evaluateStoryAccess({ ...input, story: { ...resource, deletedAt: 'today' } }), false);
  assert.equal(evaluateStoryAccess({ ...input, grant: undefined }), false);
  assert.notEqual(grantIdFor('family_owner', 'story-a', principalId), grantIdFor('family_other', 'story-a', principalId));
});

test('story scope covers explicit chapters but owner cannot bypass unresolved source restrictions', () => {
  assert.equal(evaluateStoryAccess({ ...input, grant: { ...grant, scope: { type: 'story' } }, chapterIds: ['chapter-other'] }), true);
  const owner = { ...input, principalId: ownerPrincipalId, grant: undefined };
  assert.equal(evaluateStoryAccess({ ...owner, action: 'manage' }), true);
  assert.equal(evaluateStoryAccess({ ...owner, story: { ...resource, sourcePolicyRequired: true }, action: 'publish' }), false);
});

async function sharedFixture() {
  const setup = fixture(); setup.account('owner'); setup.account('reader');
  const owner = await resolveStoryIdentity(setup.repo, { APPID: 'wx-original', OPENID: 'owner' }, { bootstrapAppId: 'wx-original' });
  const reader = await resolveStoryIdentity(setup.repo, { APPID: 'wx-original', OPENID: 'reader' }, { bootstrapAppId: 'wx-original' });
  const story = { ...resource, currentRevisionId: 'revision-current', title: '故事标题', memoryIds: ['secret-memory'], coverImageId: 'secret-cover' };
  setup.tables.set('stories:family_owner_story-a', story);
  const chapters = [
    { id: 'chapter-one', title: '私密章', content: [{ text: '绝不泄露的全文' }] },
    { id: 'chapter-three', title: '获准章', memoryIds: ['secret-memory'], backdropImageId: 'secret-backdrop', content: [{ text: '允许阅读' }, { photoId: 'photo-secret' }] },
  ];
  setup.tables.set('biography_drafts:family_owner_revision-current', { familyId: 'family_owner', storyId: 'story-a', revision: {
    id: 'revision-current', storyId: 'story-a', sourceFingerprint: 'secret-source-text', draft: { chapters, paragraphs: ['绝不泄露的全文'], content: [{ text: '绝不泄露的全文' }] },
  } });
  const grantId = grantIdFor('family_owner', 'story-a', reader.principalId);
  setup.tables.set(`story_grants:${grantId}`, { ...grant, principalId: reader.principalId, ownerPrincipalId: owner.principalId });
  return { ...setup, owner, reader, grantId };
}

test('real authorization and repository chain projects only current authorized text without loading family state', async () => {
  const { repo, reader } = await sharedFixture();
  repo.all = () => { throw new Error('must not read whole family'); };
  const result = await readAuthorizedStory(repo, reader, { familyId: 'family_owner', storyId: 'story-a', chapterIds: ['chapter-three'] });
  assert.deepEqual(result.chapters.map(chapter => chapter.id), ['chapter-three']);
  assert.equal(result.chapters[0].content[0].text, '允许阅读');
  for (const secret of ['绝不泄露', 'secret-', 'photo-secret', 'memoryIds', 'backdropImageId']) assert.equal(JSON.stringify(result).includes(secret), false, secret);
  assert.equal(result.capabilities.sharedEdit, false, 'U1 does not advertise unimplemented collaborative writes');
  await assert.rejects(readAuthorizedStory(repo, reader, { familyId: 'family_owner', storyId: 'story-a', chapterIds: ['chapter-one'] }), { code: 'STORY_FORBIDDEN' });
});

test('revocation/deletion/mismatched revision deny reads and never fall back to older history', async () => {
  for (const mutate of [
    setup => { setup.tables.get(`story_grants:${setup.grantId}`).status = 'revoked'; },
    setup => { setup.tables.get('stories:family_owner_story-a').deletedAt = 'today'; },
    setup => { setup.tables.get('biography_drafts:family_owner_revision-current').revision.storyId = 'story-other'; },
    setup => { setup.tables.delete('biography_drafts:family_owner_revision-current'); },
  ]) {
    const setup = await sharedFixture(); mutate(setup);
    await assert.rejects(readAuthorizedStory(setup.repo, setup.reader, { familyId: 'family_owner', storyId: 'story-a', chapterIds: ['chapter-three'] }), { code: 'STORY_FORBIDDEN' });
  }
});
