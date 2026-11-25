const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/web-import-fixture');
const {webImport}=require('../cloudfunctions/storyDesktopAccess/webImport');
const {prepareWebImportIdentity}=require('../cloudfunctions/drinkingTimeBridge/egress');
test('login identity preparation contains no manuscript; catalog returns only this family metadata',async()=>{
  const f=fixture();await f.ready();
  const grant=f.data.get('story_desktop_grants/'+f.grantId);assert.equal(grant.kind,'web-import');assert.equal(grant.storyId,undefined);
  const result=await f.request({operation:'list',cursor:0});assert.equal(result.stories.length,1);assert.equal(result.stories[0].storyId,'story-demo');
  assert.equal(JSON.stringify(result).includes('河边第一段'),false);assert.equal(JSON.stringify(result).includes('test-openid'),false);
  await assert.rejects(prepareWebImportIdentity(f.repo,{...f.context,OPENID:'another-openid'}));
});
test('saved book exports ordered chapters, empty chapter, original editor and private media bytes without mutating source',async()=>{
  const f=fixture();await f.ready();const before=structuredClone(f.data.get('biography_drafts/family_demo_revision-one'));
  const result=await f.request({operation:'read',...f.ref});assert.deepEqual(result.chapters.map(c=>c.title),['河岸','空章','归家']);assert.equal(result.editorName,'虚构作者');
  assert.equal(result.chapters[0].content[1].photo.available,true);
  const image=await f.request({operation:'media',...f.ref,mediaRef:'photo-demo'});assert.equal(Buffer.from(image.base64,'base64').toString(),'fixture-photo');
  assert.deepEqual(f.data.get('biography_drafts/family_demo_revision-one'),before);assert.equal(JSON.stringify(result).includes('cloud://'),false);
});
test('rejects signed cross-family reads, forged identity, expired permission, stale version and nonce replay',async()=>{
  for(const kind of ['cross','forged','expired','missing-expiry','stale','replay']){
    const f=fixture();await f.ready();const req=f.signed({operation:'read',...f.ref});
    if(kind==='cross')f.data.get('stories/family_demo_story-demo').familyId='family_other';
    if(kind==='forged')req.body.grantId='desktop-grant-'+'0'.repeat(64);
    if(kind==='expired')f.data.get('story_desktop_grants/'+f.grantId).expiresAtMs=0;
    if(kind==='missing-expiry')delete f.data.get('story_desktop_grants/'+f.grantId).expiresAtMs;
    if(kind==='stale')f.data.get('stories/family_demo_story-demo').version=2;
    if(kind==='replay')await webImport(f.repo,req,f.options);
    await assert.rejects(webImport(f.repo,req,f.options));
  }
});
test('does not strip restricted source permissions even when copy/export alone are allowed',async()=>{
  const f=fixture();await f.ready();const row=f.data.get('biography_drafts/family_demo_revision-one');
  const {materializeOwnedDraft}=require('../cloudfunctions/storyBooks/provenance');row.revision.draft=materializeOwnedDraft(row.revision.draft,{familyId:'family_demo',storyId:f.ref.storyId,revisionId:f.ref.revisionId});
  const source='source-'+'a'.repeat(64);row.revision.draft.chapters[0].content[0].sourceIds=[source];
  Object.assign(row.revision.draft,require('../cloudfunctions/storyBooks/core').flatten(row.revision.draft.chapters));
  f.data.set('story_source_policies/'+source,{version:1,parents:[],permissions:{view:true,copy:true,export:true,ai:false,publish:false,forward:false}});
  await assert.rejects(f.request({operation:'read',...f.ref}),{code:'story_access_revoked'});
});
test('missing local image is disclosed; revocation during media download aborts',async()=>{
  const f=fixture();await f.ready();const photo=f.data.get('photos/family_demo__photo-demo');f.data.delete('photos/family_demo__photo-demo');
  const result=await f.request({operation:'read',...f.ref});assert.equal(result.chapters[0].content[1].photo.available,false);assert.equal(result.warnings.length,1);
  f.data.set('photos/family_demo__photo-demo',photo);
  f.options.download=async()=>{f.data.get('story_desktop_grants/'+f.grantId).status='revoked';return Buffer.from('image');};
  await assert.rejects(f.request({operation:'media',...f.ref,mediaRef:'photo-demo'}));
});
test('copied image assets cannot bypass their own source restrictions',async()=>{
  const f=fixture();await f.ready();
  const photoId='photo-copy-'+'b'.repeat(64),source='source-'+'c'.repeat(64),operationId='copy-'+'d'.repeat(64);
  const draft=f.data.get('biography_drafts/family_demo_revision-one').revision.draft;
  draft.chapters[0].content[1].photoId=photoId;
  Object.assign(draft,require('../cloudfunctions/storyBooks/core').flatten(draft.chapters));
  f.data.set('story_copy_assets/family_demo__'+photoId,{familyId:'family_demo',storyId:f.ref.storyId,photoId,status:'active',sourceIds:[source],operationId,
    fileID:`cloud://env/story-sharing/copies/${operationId}/${'e'.repeat(32)}/${photoId}.jpg`});
  const permissions={view:true,copy:true,export:true,ai:true,publish:true,forward:true};
  f.data.set('story_source_policies/'+source,{version:1,parents:[],permissions});
  assert.equal((await f.request({operation:'read',...f.ref})).chapters[0].content[1].photo.available,true);
  for(const action of Object.keys(permissions)){
    permissions[action]=false;
    assert.equal((await f.request({operation:'read',...f.ref})).chapters[0].content[1].photo.available,false);
    await assert.rejects(f.request({operation:'media',...f.ref,mediaRef:photoId}),{code:'media_unavailable'});
    permissions[action]=true;
  }
});
test('an initialized account with no stories lists nothing without creating a book',async()=>{
  const f=fixture();await f.ready();f.data.delete('stories/family_demo_story-demo');
  assert.deepEqual(await f.request({operation:'list',cursor:0}),{stories:[],nextCursor:null});
});
