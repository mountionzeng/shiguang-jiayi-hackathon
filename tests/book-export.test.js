const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../cloudfunctions/storyBooks/core');
const { fixture } = require('./helpers/story-access-fixture');
const { resolveStoryIdentity } = require('../cloudfunctions/storyBooks/identity');
const { grantIdFor } = require('../cloudfunctions/storyBooks/access');
const { previewBookExport, exportBookImages } = require('../cloudfunctions/storyBooks/bookExports');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const approve = async () => true;
async function setup(text = '原文🌿\n\n完整正文') {
  const f = fixture(); f.account('owner'); f.account('reader');
  const identity = OPENID => resolveStoryIdentity(f.repo, { APPID: 'wx-original', OPENID }, { bootstrapAppId: 'wx-original' });
  const owner = await identity('owner'), reader = await identity('reader');
  const chapters = [{ id:'chapter-one', title:'第一章', content:[{text},{photoId:'photo-private'},{text:'结尾'}], memoryIds:[] },
    {id:'chapter-two',title:'第二章',content:[{text:'第二章全文'}],memoryIds:[]}];
  const draft = {title:'全书',chapters,...core.flatten(chapters),generationMode:'local-demo',sourceCount:0,generatedAt:''};
  const story = {id:'story-book',familyId:'family_owner',title:'全书',version:4,currentRevisionId:'revision-current'};
  f.tables.set('stories:family_owner_story-book',story);
  f.tables.set('biography_drafts:family_owner_revision-current',{familyId:'family_owner',storyId:'story-book',revision:{id:'revision-current',storyId:'story-book',draft}});
  const input = {familyId:'family_owner',storyId:'story-book',revisionId:'revision-current',expectedVersion:4,scope:'book',chapterIds:[]};
  const cover = () => {
    story.coverImageId='image-cover';
    const image={familyId:'family_owner',storyId:'story-book',purpose:'cover',moderation:'pass',fileID:'cloud://env/story-images/family_owner/story-book/cover.jpg'};
    f.tables.set('story_images:image-cover',image); return image;
  };
  return {...f,owner,reader,input,story,draft,cover};
}
test('book export reconstructs complete text, chapter order, whitespace and exact UTF16 excerpts',async()=>{
  const f=await setup('原文🌿\n\n'+'全'.repeat(5000));
  const all=await previewBookExport(f.repo,f.owner,f.input,{approve});
  assert.equal(all.descriptor.chapters[0].text,f.draft.chapters[0].content[0].text+'\n结尾');
  assert.equal(JSON.stringify(all).includes('photo-private'),false);
  const chosen=await previewBookExport(f.repo,f.owner,{...f.input,scope:'chapters',chapterIds:['chapter-two','chapter-one']},{approve});
  assert.deepEqual(chosen.descriptor.chapters.map(c=>c.id),['chapter-one','chapter-two']);
  const input={...f.input,scope:'text',excerpt:{chapterId:'chapter-one',start:2,end:6}};
  assert.equal((await previewBookExport(f.repo,f.owner,input,{approve})).descriptor.chapters[0].text,'🌿\n\n');
  for(const excerpt of [{chapterId:'chapter-one',start:3,end:6},{chapterId:'chapter-one',start:0,end:3},{chapterId:'chapter-one',start:0,end:10000}])
    await assert.rejects(previewBookExport(f.repo,f.owner,{...input,excerpt},{approve}),{code:'INVALID_INPUT'});
  await assert.rejects(previewBookExport(f.repo,f.owner,{...f.input,text:'伪造'},{approve}),{code:'INVALID_INPUT'});
});
test('export rejects missing/duplicate chapters, stale version and protected copies',async()=>{
  const f=await setup();
  for(const chapterIds of [[],['chapter-missing'],['chapter-one','chapter-one']])
    await assert.rejects(previewBookExport(f.repo,f.owner,{...f.input,scope:'chapters',chapterIds},{approve}),{code:'INVALID_INPUT'});
  await assert.rejects(previewBookExport(f.repo,f.owner,{...f.input,expectedVersion:3},{approve}),{code:'VERSION_CONFLICT'});
  f.tables.get('stories:family_owner_story-book').sourcePolicyRequired=true;
  await assert.rejects(previewBookExport(f.repo,f.owner,f.input,{approve}),{code:'STORY_FORBIDDEN'});
});
test('read/edit/publish grants do not turn recipients into owner book exporters',async()=>{
  const f=await setup();
  f.tables.set('story_grants:'+grantIdFor('family_owner','story-book',f.reader.principalId),{familyId:'family_owner',storyId:'story-book',principalId:f.reader.principalId,ownerPrincipalId:f.owner.principalId,status:'active',version:1,scope:{type:'book',chapterIds:[]},permissions:{read:true,edit:true,publish:true,export:true}});
  await assert.rejects(previewBookExport(f.repo,f.reader,f.input,{approve}),{code:'STORY_FORBIDDEN'});
});
test('book export remains gated by access, share-card enablement and family canary',async()=>{
  const f=await setup(),context={APPID:'wx-original',OPENID:'owner'};
  const options={accessEnabled:true,rulesReady:true,bootstrapAppId:'wx-original',shareCardEnabled:true,sharedReadFamilyIds:['family_owner'],approveShareCard:approve};
  for(const override of [{accessEnabled:false},{shareCardEnabled:false},{sharedReadFamilyIds:[]}]){
    const service=createStoryService(f.repo,{...options,...override});
    assert.equal((await service(context,{action:'capabilities'})).bookExport,false);
    await assert.rejects(service(context,{...f.input,action:'bookExportPreview'}),{code:'STORY_ACCESS_DISABLED'});
  }
  let seen;
  const service=createStoryService(f.repo,{...options,approveShareCard:async(text,openid)=>{seen={text,openid};return true;}});
  assert.equal((await service(context,{action:'capabilities'})).bookExport,true);
  await service(context,{...f.input,action:'bookExportPreview',openid:'forged',familyId:'family_reader'});
  assert.equal(seen.openid,'owner'); assert.match(seen.text,/完整正文/);
});
test('moderation fails closed and changes during moderation invalidate the descriptor',async()=>{
  const f=await setup();
  await assert.rejects(previewBookExport(f.repo,f.owner,f.input,{}),{code:'CONTENT_REJECTED'});
  await assert.rejects(previewBookExport(f.repo,f.owner,f.input,{approve:async()=>false}),{code:'CONTENT_REJECTED'});
  await assert.rejects(previewBookExport(f.repo,f.owner,f.input,{approve:async()=>{f.story.version++;return true;}}),{code:'VERSION_CONFLICT'});
});
test('only approved current-story cover is signed; revoked and changed covers are rejected',async()=>{
  const f=await setup(),image=f.cover();
  const {descriptor}=await previewBookExport(f.repo,f.owner,f.input,{approve});
  const input={...f.input,descriptorId:descriptor.id};
  const result=await exportBookImages(f.repo,f.owner,input,{approve,sign:async(file,ttl)=>{assert.equal(file,image.fileID);assert.equal(ttl,300);return 'https://media.example/cover';}});
  assert.equal(result.coverUrl,'https://media.example/cover'); assert.equal(JSON.stringify(result).includes('cloud://'),false);
  await assert.rejects(exportBookImages(f.repo,f.owner,input,{approve,sign:async()=>{image.moderation='risky';return 'https://media.example/cover';}}),{code:'STORY_FORBIDDEN'});
  Object.assign(f.tables.get('story_images:image-cover'),{moderation:'pass',fileID:'cloud://env/story-images/family_owner/story-book/replaced.jpg'});
  await assert.rejects(exportBookImages(f.repo,f.owner,input,{approve,sign:async()=> 'https://media.example/cover'}),{code:'VERSION_CONFLICT'});
});
test('book export can sign multiple selected share covers without changing the permanent cover', async () => {
  const f = await setup();
  f.story.coverImageId = 'image-cover';
  for (const [imageId, fileID] of [['image-cover', 'cloud://env/story-images/family_owner/story-book/cover.jpg'],
    ['image-alt', 'cloud://env/story-images/family_owner/story-book/alt.webp']]) {
    f.tables.set('story_images:' + imageId, { familyId:'family_owner', storyId:'story-book', purpose:'cover', moderation:'pass', fileID });
  }
  const selection = { ...f.input, coverImageIds:['image-alt','image-cover'], targetTextImageCount:2 };
  const { descriptor } = await previewBookExport(f.repo, f.owner, selection, { approve });
  assert.deepEqual(descriptor.coverImageIds, ['image-alt','image-cover']);
  assert.equal(descriptor.coverImageId, 'image-alt');
  assert.equal(descriptor.targetTextImageCount, 2);
  assert.equal(f.story.coverImageId, 'image-cover');
  const signed = [];
  const exported = await exportBookImages(f.repo, f.owner, { ...selection, descriptorId: descriptor.id }, {
    approve,
    sign: async file => { signed.push(file); return 'https://media.example/' + signed.length + '.jpg'; },
  });
  assert.deepEqual(signed, ['cloud://env/story-images/family_owner/story-book/alt.webp', 'cloud://env/story-images/family_owner/story-book/cover.jpg']);
  assert.deepEqual(exported.coverUrls, ['https://media.example/1.jpg', 'https://media.example/2.jpg']);
});
test('unsafe cover metadata is denied and the no-cover fallback exposes no private asset',async()=>{
  for(const patch of [{moderation:'pending'},{deletedAtMs:1},{storyId:'story-other'},{sourcePolicyRequired:true},{sourceIds:['source-a']},{fileID:'cloud://env/private/cover.jpg'}]){
    const f=await setup();Object.assign(f.cover(),patch);
    await assert.rejects(previewBookExport(f.repo,f.owner,f.input,{approve}),{code:'STORY_FORBIDDEN'});
  }
  const f=await setup();const {descriptor}=await previewBookExport(f.repo,f.owner,f.input,{approve});
  const result=await exportBookImages(f.repo,f.owner,{...f.input,descriptorId:descriptor.id},{approve});
  assert.equal(result.coverUrl,'');
});
test('oversize body is rejected explicitly instead of truncated',async()=>{
  const f=await setup('字'.repeat(40001));
  await assert.rejects(previewBookExport(f.repo,f.owner,f.input,{approve}),/最多 20000 字/);
});
test('every selected textual source must permit view, publish and export, including for excerpts',async()=>{
  const {materializeOwnedDraft}=require('../cloudfunctions/storyBooks/provenance');
  for(const permission of ['view','publish','export']) {
    const f=await setup(), sourceId='source-'+'a'.repeat(64);
    const draft=materializeOwnedDraft(f.draft,{familyId:'family_owner',storyId:'story-book',revisionId:'revision-current'});
    draft.chapters[0].content[0].sourceIds=[sourceId]; Object.assign(draft,core.flatten(draft.chapters));
    f.tables.get('biography_drafts:family_owner_revision-current').revision.draft=draft;
    f.tables.set('story_source_policies:'+sourceId,{version:1,parents:[],permissions:{view:true,publish:true,export:true,[permission]:false}});
    await assert.rejects(previewBookExport(f.repo,f.owner,{...f.input,scope:'text',excerpt:{chapterId:'chapter-one',start:0,end:2}},{approve}),{code:'STORY_FORBIDDEN'});
  }
});

test('memory export rebuilds the descriptor from the saved memory source and rejects stale versions', async () => {
  const f = fixture(); f.account('owner');
  const owner = await resolveStoryIdentity(f.repo, { APPID: 'wx-original', OPENID: 'owner' }, { bootstrapAppId: 'wx-original' });
  f.tables.set('family_members:family_owner_owner', { familyId: 'family_owner', memberId: 'owner', relation: '自己', role: 'owner', kind: 'recording-profile' });
  f.tables.set('memories:family_owner_memory-one', {
    familyId: 'family_owner', frontendContributionId: 'memory-one', authorMemberId: 'owner',
    scope: 'personal', visibility: 'private', reviewStatus: 'confirmed', title: '雨天',
    text: '屋檐下听雨。',
    aiRevisions: [{ id: 'revision-ai', kind: 'ai', title: '雨天', text: '屋檐下听雨。', createdAt: '2026-01-01T00:00:00.000Z' }],
  });
  const source = (await createStoryService(f.repo, { accessEnabled:true, rulesReady:true, bootstrapAppId:'wx-original',
    shareCardEnabled:true, sharedReadFamilyIds:['family_owner'] })({ APPID:'wx-original', OPENID:'owner' },
    { action:'memoryExportSource', memoryId:'memory-one', revisionId:'revision-ai', text:'伪造正文' })).source;
  const input = { familyId:'family_owner', sourceKind:'memory', memoryId:'memory-one', revisionId:'revision-ai',
    expectedSourceVersion: source.sourceVersion, targetTextImageCount:2 };
  let approved = '';
  const preview = await previewBookExport(f.repo, owner, input, { approve: async text => { approved = text; return true; } });
  assert.equal(preview.descriptor.sourceKind, 'memory');
  assert.equal(preview.descriptor.memoryId, 'memory-one');
  assert.equal(preview.descriptor.targetTextImageCount, 2);
  assert.equal(preview.descriptor.chapters[0].text, '屋檐下听雨。');
  assert.match(approved, /屋檐下听雨/);
  assert.equal(JSON.stringify(preview).includes('伪造正文'), false);
  const servicePreview = await createStoryService(f.repo, { accessEnabled:true, rulesReady:true, bootstrapAppId:'wx-original',
    shareCardEnabled:true, sharedReadFamilyIds:['family_owner'], approveShareCard: async () => true })({ APPID:'wx-original', OPENID:'owner' },
    { action:'bookExportPreview', sourceKind:'memory', memoryId:'memory-one', revisionId:'revision-ai',
      expectedSourceVersion: source.sourceVersion, targetTextImageCount:3 });
  assert.equal(servicePreview.descriptor.targetTextImageCount, 3);
  f.tables.get('memories:family_owner_memory-one').aiRevisions[0].text = '后来修改的记忆。';
  await assert.rejects(previewBookExport(f.repo, owner, input, { approve }), { code:'VERSION_CONFLICT' });
});
