const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {fixture}=require('./helpers/story-access-fixture');
const {resolveStoryIdentity}=require('../cloudfunctions/storyBooks/identity');
const {grantIdFor}=require('../cloudfunctions/storyBooks/access');
const {receiveMediaCopy,cleanupMediaCopy}=require('../cloudfunctions/storyBooks/copyMedia');
const {readStoryMedia}=require('../cloudfunctions/storyBooks/media');
const {createStoryService}=require('../cloudfunctions/storyBooks/service');
const core=require('../cloudfunctions/storyBooks/core');
async function setup(){
  const f=fixture();f.account('owner');f.account('reader');
  const resolve=OPENID=>resolveStoryIdentity(f.repo,{APPID:'wx-original',OPENID},{bootstrapAppId:'wx-original'});
  const owner=await resolve('owner'),reader=await resolve('reader');
  const chapters=[{id:'chapter-one',title:'老照片',memoryIds:[],content:[{text:'我们的夏天'},{photoId:'photo-one'},{photoId:'photo-two'}]}];
  f.tables.set('stories:family_owner_story-a',{id:'story-a',familyId:'family_owner',title:'夏天',memoryIds:[],version:1,currentRevisionId:'revision-a'});
  f.tables.set('biography_drafts:family_owner_revision-a',{familyId:'family_owner',storyId:'story-a',revision:{id:'revision-a',storyId:'story-a',draft:{title:'夏天',chapters,...core.flatten(chapters)}}});
  const grantId=grantIdFor('family_owner','story-a',reader.principalId);
  f.tables.set('story_grants:'+grantId,{familyId:'family_owner',storyId:'story-a',principalId:reader.principalId,ownerPrincipalId:owner.principalId,status:'active',version:1,permissions:{read:true,copy:true},scope:{type:'chapters',chapterIds:['chapter-one']}});
  const files=new Map(),copies=[];
  for(const photoId of ['photo-one','photo-two']){
    const fileID=`cloud://env.bucket/user-photos/family_owner/${photoId}/display.jpg`;
    f.tables.set('photos:family_owner__'+photoId,{familyId:'family_owner',photoId,_openid:'owner',displayFileID:fileID,displayBytes:12,moderation:{ok:true,suggest:'pass'}});
    files.set(fileID,photoId);
  }
  const metadata=fileID=>({fileID,bytes:files.get(fileID).length,sha256:crypto.createHash('sha256').update(files.get(fileID)).digest('hex')});
  const storage={
    async copy(source,destination){copies.push([source,destination]);if(!files.has(source))throw new Error('missing source');files.set(destination,files.get(source));return metadata(destination);},
    async verify(asset){if(!files.has(asset.fileID) || metadata(asset.fileID).sha256!==asset.sha256)throw new Error('retained bytes missing or changed');},
    async remove(fileIDs){for(const id of fileIDs){assert.match(id,/\/story-sharing\/copies\//);files.delete(id);}},
  };
  const input={sourceFamilyId:'family_owner',sourceStoryId:'story-a',sourceRevisionId:'revision-a',chapterIds:['chapter-one'],requestId:'receive-media-001',target:{mode:'new',storyId:'story-copy',title:'我的夏天'}};
  const operation=()=>[...f.tables].find(([key])=>key.startsWith('story_copy_media:'))?.[1];
  return {...f,reader,grantId,files,copies,storage,input,operation};
}
test('copied photos are private independent objects and remain readable after source deletion',async()=>{
  const f=await setup();await receiveMediaCopy(f.repo,f.reader,f.input,f.storage);
  const story=f.tables.get('stories:family_reader_story-copy'),draft=f.tables.get('biography_drafts:family_reader_'+story.currentRevisionId).revision.draft;
  assert.equal(draft.chapters[0].content.length,3);assert.notEqual(draft.chapters[0].content[1].photoId,'photo-one');
  for(const [key] of [...f.tables])if(key.startsWith('photos:family_owner') || key.startsWith('stories:family_owner') || key.startsWith('biography_drafts:family_owner') || key.startsWith('story_grants:'))f.tables.delete(key);
  for(const id of [...f.files.keys()])if(id.includes('/user-photos/'))f.files.delete(id);
  const request={familyId:'family_reader',storyId:'story-copy',chapterId:draft.chapters[0].id,photoId:draft.chapters[0].content[1].photoId,purpose:'view'};
  const result=await readStoryMedia(f.repo,f.reader,request,async fileID=>{assert.equal(f.files.has(fileID),true);return 'https://example.com/private';});
  assert.equal(result.url,'https://example.com/private');
  assert.equal((await receiveMediaCopy(f.repo,f.reader,f.input,f.storage)).alreadyReceived,true);assert.equal(f.copies.length,2);
  await assert.rejects(readStoryMedia(f.repo,f.reader,{...request,purpose:'export'},async()=>{throw new Error('must not sign');}));
});
test('public copy dispatcher detects photos and completes independent media retention',async()=>{
  const f=await setup(),service=createStoryService(f.repo,{accessEnabled:true,rulesReady:true,copyReceiveEnabled:true,copyStorage:f.storage,
    bootstrapAppId:'wx-original',sharedReadFamilyIds:['family_owner','family_reader']});
  const result=await service({APPID:'wx-original',OPENID:'reader'},{action:'copyReceive',...f.input});
  assert.equal(result.storyId,'story-copy');assert.equal(f.copies.length,2);
  const story=f.tables.get('stories:family_reader_story-copy'),draft=f.tables.get('biography_drafts:family_reader_'+story.currentRevisionId).revision.draft;
  assert.equal(draft.chapters[0].content.filter(item=>item.photoId).length,2);
  assert.equal(draft.chapters[0].content.some(item=>item.photoId==='photo-one'||item.photoId==='photo-two'),false);
  for(const item of draft.chapters[0].content.filter(item=>item.photoId))assert.equal(f.tables.has('story_copy_assets:family_reader__'+item.photoId),true);
});
test('storage failure leaves no half story and retry reuses already recorded copies',async()=>{
  const f=await setup(),copy=f.storage.copy;let fail=true;
  f.storage.copy=async(source,dest)=>{if(fail && source.includes('photo-two'))throw new Error('offline');return copy(source,dest);};
  await assert.rejects(receiveMediaCopy(f.repo,f.reader,f.input,f.storage),/offline/);
  assert.equal(f.tables.has('stories:family_reader_story-copy'),false);assert.equal(f.operation().status,'pending');
  fail=false;await receiveMediaCopy(f.repo,f.reader,f.input,f.storage);
  assert.equal(f.copies.filter(([id])=>id.includes('photo-one')).length,1);assert.equal(f.operation().status,'complete');
});
test('revocation during file copy prevents activation; explicit cleanup removes only operation files',async()=>{
  const f=await setup(),copy=f.storage.copy;
  f.storage.copy=async(source,dest)=>{const result=await copy(source,dest);f.tables.get('story_grants:'+f.grantId).status='revoked';return result;};
  await assert.rejects(receiveMediaCopy(f.repo,f.reader,f.input,f.storage),{code:'STORY_FORBIDDEN'});
  assert.equal(f.tables.has('stories:family_reader_story-copy'),false);
  await cleanupMediaCopy(f.repo,f.reader,f.operation().id,f.storage);
  assert.equal([...f.files.keys()].some(id=>id.includes('/story-sharing/')),false);
  assert.equal([...f.files.keys()].filter(id=>id.includes('/user-photos/')).length,2);
  assert.equal(f.operation().status,'cancelled');
});
test('lease prevents concurrent workers and stale workers cannot activate after a retry',async()=>{
  const f=await setup(),copy=f.storage.copy;let unblock,started;const waiting=new Promise(resolve=>{started=resolve;});
  let first=true,nowMs=1000;
  f.storage.copy=async(source,dest)=>{if(first){first=false;started();await new Promise(resolve=>{unblock=resolve;});}return copy(source,dest);};
  const stale=receiveMediaCopy(f.repo,f.reader,f.input,f.storage,{nowMs:()=>nowMs});
  await waiting;
  await assert.rejects(receiveMediaCopy(f.repo,f.reader,f.input,f.storage,{nowMs:()=>nowMs}),{code:'STORY_COPY_BUSY'});
  nowMs+=180000;
  await receiveMediaCopy(f.repo,f.reader,f.input,f.storage,{nowMs:()=>nowMs});
  unblock();await assert.rejects(stale,{code:'STORY_COPY_BUSY'});
  const active=[...f.tables].filter(([key])=>key.startsWith('story_copy_assets:')).map(([,asset])=>asset.fileID);
  await cleanupMediaCopy(f.repo,f.reader,f.operation().id,f.storage);
  assert.equal([...f.files.keys()].filter(id=>id.includes('/story-sharing/')).length,2);
  for(const id of active)assert.equal(f.files.has(id),true);
});
test('source photo change, deletion or failed verification prevents final publication',async()=>{
  for(const mode of ['delete','record-change','verify']){
    const f=await setup(),copy=f.storage.copy;
    if(mode==='verify')f.storage.verify=async()=>{throw new Error('lost copied object');};
    else f.storage.copy=async(source,dest)=>{const result=await copy(source,dest);if(mode==='delete')f.tables.delete('photos:family_owner__photo-one');else f.tables.get('photos:family_owner__photo-one').moderation={ok:false,suggest:'review'};return result;};
    await assert.rejects(receiveMediaCopy(f.repo,f.reader,f.input,f.storage));assert.equal(f.tables.has('stories:family_reader_story-copy'),false);
  }
});
test('unreviewed photos, guessed source files and unsupported backdrops cause no storage calls',async()=>{
  for(const mutate of [f=>{f.tables.get('photos:family_owner__photo-one').moderation.ok=false;},f=>{f.tables.get('photos:family_owner__photo-one').displayFileID='cloud://env.bucket/user-photos/family_other/photo-one/display.jpg';},f=>{f.tables.get('biography_drafts:family_owner_revision-a').revision.draft.chapters[0].backdropImageId='family_owner_img_req-example12';}]){
    const f=await setup();mutate(f);await assert.rejects(receiveMediaCopy(f.repo,f.reader,f.input,f.storage));assert.equal(f.copies.length,0);
  }
});
test('lost upload acknowledgement leaves a durable candidate that cancellation can repeatedly clean',async()=>{
  const f=await setup(),copy=f.storage.copy;f.storage.copy=async(source,dest)=>{await copy(source,dest);throw new Error('ack lost');};
  await assert.rejects(receiveMediaCopy(f.repo,f.reader,f.input,f.storage),/ack lost/);
  const id=f.operation().id;await cleanupMediaCopy(f.repo,f.reader,id,f.storage);
  assert.equal([...f.files.keys()].some(id=>id.includes('/story-sharing/')),false);
  // A delayed provider write may arrive after cleanup; the tombstone preserves
  // candidate paths so a subsequent sweep removes it without touching originals.
  const late=f.operation().candidates[0];f.files.set(late.fileID,'late bytes');
  await cleanupMediaCopy(f.repo,f.reader,id,f.storage);assert.equal(f.files.has(late.fileID),false);
  await assert.rejects(receiveMediaCopy(f.repo,f.reader,f.input,f.storage));
});
test('late database failure leaves only retryable private files, never active assets or a half manuscript',async()=>{
  const f=await setup(),transaction=f.repo.transaction;
  f.repo.transaction=fn=>transaction(tx=>fn({...tx,set:async(table,id,value)=>{if(table==='story_copy_requests')throw new Error('commit unavailable');return tx.set(table,id,value);}}));
  await assert.rejects(receiveMediaCopy(f.repo,f.reader,f.input,f.storage),/commit unavailable/);
  assert.equal(f.operation().status,'pending');assert.equal(f.tables.has('stories:family_reader_story-copy'),false);
  assert.equal([...f.tables.keys()].some(key=>key.startsWith('story_copy_assets:')),false);
  f.repo.transaction=transaction;await receiveMediaCopy(f.repo,f.reader,f.input,f.storage);assert.equal(f.copies.length,2);
});
test('copied asset access is rechecked during signing and is unavailable through old photo records',async()=>{
  const f=await setup();await receiveMediaCopy(f.repo,f.reader,f.input,f.storage);
  const story=f.tables.get('stories:family_reader_story-copy'),draft=f.tables.get('biography_drafts:family_reader_'+story.currentRevisionId).revision.draft;
  const photoId=draft.chapters[0].content[1].photoId,key='story_copy_assets:family_reader__'+photoId;
  assert.equal(f.tables.has('photos:family_reader__'+photoId),false);
  const request={familyId:'family_reader',storyId:'story-copy',chapterId:draft.chapters[0].id,photoId,purpose:'view'};
  await assert.rejects(readStoryMedia(f.repo,f.reader,request,async()=>{f.tables.get(key).status='disabled';return 'https://example.com/private';}),{code:'STORY_FORBIDDEN'});
});
