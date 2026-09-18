const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const { aliasIdFor } = require('../cloudfunctions/storyBooks/identity');
const { grantIdFor } = require('../cloudfunctions/storyBooks/access');

const options = { accessEnabled: true, rulesReady: true, bootstrapAppId: 'wx-original', sharedReadFamilyIds: ['family_owner', 'family_reader'] };
const context = { APPID: 'wx-original', OPENID: 'owner' };
const create = { action: 'create', storyId: 'story-a', title: '我的故事', writingMode: 'objective', memoryIds: [], requestId: 'create-story-a' };

test('default-off preserves existing owner behavior and does not register identity or open sharing', async () => {
  const { repo, tables, account } = fixture(); account('owner');
  const service = createStoryService(repo);
  await service(context, create);
  assert.equal((await service(context, { action: 'state', familyId: 'family_other' })).stories[0].title, '我的故事');
  assert.equal([...tables.keys()].some(key => key.startsWith('story_identity')), false);
  await assert.rejects(service(context, { action: 'sharedRead', familyId: 'family_other', storyId: 'story-a' }), { code: 'STORY_ACCESS_DISABLED' });
});

test('enabled service ignores caller-supplied identity and guards all legacy whole-space operations', async () => {
  const { repo, account } = fixture(); account('owner'); account('reader');
  const service = createStoryService(repo, options);
  await service(context, { ...create, principalId: 'pretend-owner', familyId: 'family_reader', OPENID: 'reader' });
  const state = await service({ APPID: 'wx-original', OPENID: 'reader' }, { action: 'state', familyId: 'family_owner', principalId: 'pretend-owner' });
  assert.deepEqual(state.stories, []);
  await assert.rejects(service({ APPID: 'wx-original', OPENID: 'reader' }, { action: 'update', familyId: 'family_owner', storyId: 'story-a', expectedVersion: 1, patch: { title: '偷改' }, requestId: 'update-foreign' }));
  assert.equal((await service(context, { action: 'state' })).stories[0].title, '我的故事');
});

test('owner identity is revalidated inside commit transaction and on operation replay', async () => {
  const { repo, tables, account } = fixture(); account('owner');
  const service = createStoryService(repo, options);
  await service(context, create);
  const originalTransaction = repo.transaction;
  let calls = 0;
  repo.transaction = fn => {
    calls++;
    if (calls === 2) tables.get(`story_identity_aliases:${aliasIdFor('wx-original', 'owner')}`).status = 'revoked';
    return originalTransaction(fn);
  };
  await assert.rejects(service(context, { action: 'update', storyId: 'story-a', expectedVersion: 1, patch: { title: '不应保存' }, requestId: 'update-revoked' }), { code: 'STORY_FORBIDDEN' });
  assert.equal(tables.get('stories:family_owner_story-a').version, 1);
  assert.equal(tables.has('story_operations:family_owner_update-revoked'), false);
  await assert.rejects(service(context, create), { code: 'STORY_FORBIDDEN' });
});

test('access cannot be enabled before rule verification and allowlist defaults to no shared reads', async () => {
  const { repo, tables, account } = fixture(); account('owner');
  await assert.rejects(createStoryService(repo, { ...options, rulesReady: false })(context, create), { code: 'STORY_ACCESS_NOT_READY' });
  assert.equal([...tables.keys()].some(key => key.startsWith('story_identity')), false);
  const service = createStoryService(repo, { ...options, sharedReadFamilyIds: [] });
  await assert.rejects(service(context, { action: 'sharedRead', familyId: 'family_owner', storyId: 'story-a' }), { code: 'STORY_ACCESS_DISABLED' });
  const capabilities = await service(context, { action: 'capabilities' });
  assert.equal(capabilities.sharedRead, false);
  assert.equal(capabilities.sharedEdit, false);
  assert.equal(capabilities.identityVersion, 1);
});

test('sharedRead service enforces chapter grants, both canaries and immediate revocation', async () => {
  const { repo, tables, account } = fixture(); account('owner'); account('reader');
  const service = createStoryService(repo, options);
  const readerContext = { APPID: 'wx-original', OPENID: 'reader' };
  await service(context, create);
  await service(readerContext, { action: 'capabilities' });
  const principal = openid => tables.get(`story_identity_aliases:${aliasIdFor('wx-original', openid)}`).principalId;
  const grantId = grantIdFor('family_owner', 'story-a', principal('reader'));
  tables.set(`story_grants:${grantId}`, { familyId: 'family_owner', storyId: 'story-a',
    principalId: principal('reader'), ownerPrincipalId: principal('owner'), status: 'active', version: 1,
    permissions: { read: true }, scope: { type: 'chapters', chapterIds: ['chapter-three'] } });
  tables.get('stories:family_owner_story-a').currentRevisionId = 'revision-current';
  tables.set('biography_drafts:family_owner_revision-current', { familyId: 'family_owner', storyId: 'story-a',
    revision: { id: 'revision-current', storyId: 'story-a', sourceFingerprint: 'secret-source', draft: { chapters: [
      { id: 'chapter-one', title: 'secret-title', content: [{ text: 'secret-manuscript' }] },
      { id: 'chapter-three', title: '第三章', content: [{ text: '允许阅读' }, { photoId: 'secret-photo' }] },
    ] } } });
  const request = { action: 'sharedRead', familyId: 'family_owner', storyId: 'story-a' };
  const result = await service(readerContext, request);
  assert.deepEqual(result.chapters, [{ id: 'chapter-three', title: '第三章', content: [
    { text: '允许阅读' }, { text: '〔图片共享尚未开放〕' },
  ], textBlocks:[{index:0,text:'允许阅读'}] }]);
  assert.equal(JSON.stringify(result).includes('secret-'), false);
  await assert.rejects(service(readerContext, { ...request, chapterIds: ['chapter-one'] }), { code: 'STORY_FORBIDDEN' });
  for (const sharedReadFamilyIds of [['family_owner'], ['family_reader']]) {
    await assert.rejects(createStoryService(repo, { ...options, sharedReadFamilyIds })(readerContext, request), { code: 'STORY_ACCESS_DISABLED' });
  }
  tables.get(`story_grants:${grantId}`).status = 'revoked';
  await assert.rejects(service(readerContext, request), { code: 'STORY_FORBIDDEN' });
  tables.get(`story_grants:${grantId}`).status = 'active';
  tables.get(`story_identity_aliases:${aliasIdFor('wx-original', 'reader')}`).status = 'revoked';
  await assert.rejects(service(readerContext, request), { code: 'STORY_FORBIDDEN' });
});

test('shareExcerpt dispatch uses the resolved owner and server revision',async()=>{
  const {repo,tables,account}=fixture();const owner=account('owner');
  const service=createStoryService(repo,{...options,excerptSharingEnabled:true,approveExcerpt:async text=>text==='保存的正文'});
  await service(context,{action:'capabilities'});
  tables.set('family_members:family_owner_owner',{familyId:'family_owner',id:'owner',memberId:'owner',name:'岱',relation:'自己',role:'owner'});
  tables.set('family_members:family_owner_member-1',{familyId:'family_owner',id:'member-1',memberId:'member-1',name:'林秋',relation:'家人',role:'contributor'});
  tables.set('stories:family_owner_story-a',{id:'story-a',familyId:'family_owner',title:'故事',version:1,currentRevisionId:'revision-a'});
  const chapter={id:'chapter-a',title:'一章',memoryIds:[],content:[{text:'保存的正文'}]};
  const core=require('../cloudfunctions/storyBooks/core');
  tables.set('biography_drafts:family_owner_revision-a',{familyId:'family_owner',storyId:'story-a',revision:{id:'revision-a',storyId:'story-a',draft:{title:'故事',chapters:[chapter],...core.flatten([chapter])}}});
  const event={action:'shareExcerpt',storyId:'story-a',revisionId:'revision-a',expectedVersion:1,chapterId:'chapter-a',
    text:'保存的正文',recipientMemberIds:['member-1'],requestId:'excerpt-service-1',familyId:'family_reader'};
  const result=await service(context,event);
  assert.equal(result.ok,true);
  assert.equal(tables.get('memories:family_owner_'+result.contributionId).familyId,owner.familyId);
  assert.equal(tables.has('memories:family_reader_'+result.contributionId),false);
  await assert.rejects(createStoryService(repo,{...options,excerptSharingEnabled:false})(context,event),{code:'STORY_ACCESS_DISABLED'});
});
