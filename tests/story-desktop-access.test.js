const test=require('node:test');
const assert=require('node:assert/strict');
const {PATH,WRITE_PATH,MEDIA_PATH,CARD_PATH,sign,readAuthoritativeStory,writeAuthoritativeStory,readAuthoritativeMedia,authoritativeShareCard}=require('../cloudfunctions/storyDesktopAccess/core');
const storyCore=require('../cloudfunctions/storyBooks/core');

function fixture(mode='legacy'){
  const data=new Map(),now=Date.UTC(2026,8,18,6),secret='s'.repeat(32),grantId='desktop-grant-'+'a'.repeat(64);
  const familyId='family_owner',principalId='principal_'+'1'.repeat(32),accountId='account_'+'2'.repeat(24),revisionId='revision-current';
  const draft={title:'我们的故事',generatedAt:'2026-09-18T06:00:00.000Z',chapters:[{id:'chapter-one',title:'第一章',memoryIds:[],content:[{text:'当前正文'},{photoId:'photo-opaque'}]}]};
  if(mode==='protected'){
    draft.provenanceVersion=1;
    draft.chapters[0].content=[{text:'受保护正文',blockId:'block-'+'b'.repeat(64),sourceIds:['source-'+'c'.repeat(64)]}];
    data.set('story_source_policies/source-'+'c'.repeat(64),{version:1,parents:[],permissions:{view:true,copy:false,forward:false,publish:false,ai:false,export:false}});
  }
  Object.assign(draft,storyCore.flatten(draft.chapters));
  data.set('story_desktop_grants/'+grantId,{grantId,status:'active',familyId,principalId,storyId:'story-a',revisionId:'revision-old',version:1,title:'旧标题',expiresAtMs:now+100000});
  data.set('story_principals/'+principalId,{status:'active',familyId,accountId});
  data.set('story_principal_spaces/'+familyId,{status:'active',principalId,accountId});
  data.set('families/'+familyId,{ownerAccountId:accountId,_openid:'owner-openid',storyBooks:{status:'active'}});
  data.set('stories/'+familyId+'_story-a',{id:'story-a',familyId,title:'故事',bookTitle:'故事',version:3,currentRevisionId:revisionId,updatedAt:'2026-09-18T06:00:00.000Z'});
  data.set('biography_drafts/'+familyId+'_'+revisionId,{familyId,storyId:'story-a',revision:{id:revisionId,storyId:'story-a',savedAt:'2026-09-18T06:00:00.000Z',draft}});
  data.set('photos/'+familyId+'__photo-opaque',{familyId,photoId:'photo-opaque',_openid:'owner-openid',displayFileID:`cloud://env/user-photos/${familyId}/photo-opaque/display.jpg`,
    moderation:{ok:true,suggest:'pass'}});
  const repo={async get(table,id){return structuredClone(data.get(table+'/'+id));},async set(table,id,value){data.set(table+'/'+id,structuredClone(value));},async transaction(fn){return fn(repo);}};
  const body={grantId},timestamp=String(now),nonce='abcdefghijklmnop';
  const request={method:'POST',path:PATH,body,headers:{'x-shiguang-timestamp':timestamp,'x-shiguang-nonce':nonce,'x-shiguang-signature':sign(secret,timestamp,nonce,body)}};
  return {data,repo,request,options:{secret,now:()=>now},grantId};
}
function mediaRequest(f,body,nonce='mediaRequestNonce1'){
  const timestamp=String(f.options.now());return {method:'POST',path:MEDIA_PATH,body,headers:{'x-shiguang-timestamp':timestamp,'x-shiguang-nonce':nonce,
    'x-shiguang-signature':sign(f.options.secret,timestamp,nonce,body,MEDIA_PATH)}};
}
function writeRequest(f,body,nonce='qrstuvwxyzABCDEF'){
  const timestamp=String(f.options.now());return {method:'POST',path:WRITE_PATH,body,headers:{'x-shiguang-timestamp':timestamp,'x-shiguang-nonce':nonce,
    'x-shiguang-signature':sign(f.options.secret,timestamp,nonce,body,WRITE_PATH)}};
}

function cardRequest(f,body,nonce){
  const timestamp=String(f.options.now());return {method:'POST',path:CARD_PATH,body,headers:{'x-shiguang-timestamp':timestamp,'x-shiguang-nonce':nonce,
    'x-shiguang-signature':sign(f.options.secret,timestamp,nonce,body,CARD_PATH)}};
}

test('desktop card shares the real selection, moderation and export chain without trusting a browser identity',async()=>{
  const f=fixture(),options={...f.options,shareCardEnabled:true,approveShareCard:async(text,openid)=>text.includes('当前正文')&&openid==='owner-openid',signMedia:async()=> 'https://media.example/card.jpg'};
  const source=await authoritativeShareCard(f.repo,cardRequest(f,{grantId:f.grantId,operation:'source'},'card-source-nonce1'),options);
  const input={grantId:f.grantId,revisionId:source.revisionId,chapterId:source.chapters[0].id,blockIds:source.chapters[0].blocks.map(block=>block.blockId),photoIds:['photo-opaque']};
  const preview=await authoritativeShareCard(f.repo,cardRequest(f,{...input,operation:'preview'},'card-preview-nonce1'),options);
  const exported=await authoritativeShareCard(f.repo,cardRequest(f,{...input,operation:'export',descriptorId:preview.descriptor.id},'card-export-nonce1'),options);
  assert.deepEqual(exported.descriptor,preview.descriptor);assert.deepEqual(exported.descriptor.paragraphs,['当前正文']);assert.equal(exported.media[0].requestedMaxAgeSeconds,300);
  assert.equal(JSON.stringify(exported).includes('owner-openid'),false);assert.equal(JSON.stringify(exported).includes('cloud://'),false);
  await assert.rejects(authoritativeShareCard(f.repo,cardRequest(f,{grantId:f.grantId,operation:'source'},'card-source-nonce1'),options),{code:'replayed_authority_request'});
});

test('desktop card fails closed when disabled, content rejected or grant revoked during moderation',async()=>{
  for(const change of ['disabled','moderation','revoked']){
    const f=fixture(),source=await authoritativeShareCard(f.repo,cardRequest(f,{grantId:f.grantId,operation:'source'},'card-source-nonce1'),{...f.options,shareCardEnabled:true});
    const body={grantId:f.grantId,operation:'preview',revisionId:source.revisionId,chapterId:'chapter-one',blockIds:[source.chapters[0].blocks[0].blockId],photoIds:[]};
    const options={...f.options,shareCardEnabled:change!=='disabled',approveShareCard:async()=>{if(change==='revoked')f.data.get('story_desktop_grants/'+f.grantId).status='revoked';return change!=='moderation';}};
    await assert.rejects(authoritativeShareCard(f.repo,cardRequest(f,body,'card-preview-nonce1'),options));
  }
});

test('reads the current authoritative revision and materializes legacy owned blocks without persisting the draft',async()=>{
  const f=fixture(),before=structuredClone(f.data.get('biography_drafts/family_owner_revision-current'));
  const result=await readAuthoritativeStory(f.repo,f.request,f.options);
  assert.equal(result.version,3);assert.equal(result.revisionId,'revision-current');assert.equal(result.chapters[0].content[0].text,'当前正文');
  assert.match(result.chapters[0].content[0].blockId,/^block-[a-f0-9]{64}$/);assert.deepEqual(result.chapters[0].content[0].sourceIds,[]);
  assert.equal(result.chapters[0].content[1].photoId,'photo-opaque');assert.deepEqual(f.data.get('biography_drafts/family_owner_revision-current'),before);
});

test('preserves validated provenance and opaque photo references',async()=>{
  const f=fixture('protected'),result=await readAuthoritativeStory(f.repo,f.request,f.options);
  assert.equal(result.provenanceVersion,1);assert.deepEqual(result.chapters[0].content[0].sourceIds,['source-'+'c'.repeat(64)]);
  assert.equal(JSON.stringify(result).includes('fileID'),false);
});

test('returns only a short HTTPS URL for a photo in the current authorized chapter',async()=>{
  const f=fixture(),body={grantId:f.grantId,revisionId:'revision-current',chapterId:'chapter-one',photoId:'photo-opaque'};
  let signed;const result=await readAuthoritativeMedia(f.repo,mediaRequest(f,body),{...f.options,signMedia:async(fileID,maxAge)=>{
    signed={fileID,maxAge};return 'https://media.example/temporary.jpg?token=short';
  }});
  assert.deepEqual(signed,{fileID:'cloud://env/user-photos/family_owner/photo-opaque/display.jpg',maxAge:300});
  assert.deepEqual(result,{photoId:'photo-opaque',url:'https://media.example/temporary.jpg?token=short',expiresInSeconds:300});
  assert.equal(JSON.stringify(result).includes('cloud://'),false);
});

test('reads an independently retained copy only through its active source-bound asset record',async()=>{
  const f=fixture('protected'),photoId='photo-copy-'+'d'.repeat(64),operationId='copy-'+'e'.repeat(64),sourceId='source-'+'c'.repeat(64);
  const record=f.data.get('biography_drafts/family_owner_revision-current');record.revision.draft.chapters[0].content.push({photoId,blockId:'block-'+'f'.repeat(64),sourceIds:[sourceId]});
  Object.assign(record.revision.draft,storyCore.flatten(record.revision.draft.chapters));
  const fileID=`cloud://env/story-sharing/copies/${operationId}/${'1'.repeat(32)}/${photoId}.jpg`;
  f.data.set('story_copy_assets/family_owner__'+photoId,{familyId:'family_owner',storyId:'story-a',photoId,status:'active',sourcePolicyRequired:true,
    sourceIds:[sourceId],operationId,fileID});
  const body={grantId:f.grantId,revisionId:'revision-current',chapterId:'chapter-one',photoId};let signed;
  await readAuthoritativeMedia(f.repo,mediaRequest(f,body),{...f.options,signMedia:async value=>{signed=value;return 'https://media.example/copied.jpg';}});
  assert.equal(signed,fileID);
  f.data.get('story_copy_assets/family_owner__'+photoId).status='deleted';
  await assert.rejects(readAuthoritativeMedia(f.repo,mediaRequest(f,body,'mediaRequestNonce2'),{...f.options,signMedia:async()=>{throw new Error('must not sign');}}));
});

test('desktop media fails closed for stale revisions, wrong chapters and changes during signing',async()=>{
  for(const change of ['revision','chapter','moderation']){
    const f=fixture(),body={grantId:f.grantId,revisionId:'revision-current',chapterId:'chapter-one',photoId:'photo-opaque'};
    if(change==='revision')body.revisionId='revision-old';
    if(change==='chapter')body.chapterId='chapter-other';
    const options={...f.options,signMedia:async()=>{if(change==='moderation')f.data.get('photos/family_owner__photo-opaque').moderation.ok=false;return 'https://media.example/temporary.jpg';}};
    await assert.rejects(readAuthoritativeMedia(f.repo,mediaRequest(f,body),options));
  }
});

test('rejects replay and uses a bounded twelve-slot nonce store',async()=>{
  const f=fixture();await readAuthoritativeStory(f.repo,f.request,f.options);
  await assert.rejects(readAuthoritativeStory(f.repo,f.request,f.options),{code:'replayed_authority_request'});
  const slot=String((Math.floor(f.options.now()/60000)%12+12)%12).padStart(2,'0');
  assert.deepEqual([...f.data.keys()].filter(key=>key.startsWith('story_desktop_nonces/')),['story_desktop_nonces/slot-'+slot]);
});

test('fails closed after identity, space, family, grant, source or story revocation',async()=>{
  for(const change of ['principal','space','family','grant','expired','deleted','source']){
    const f=fixture('protected');
    if(change==='principal')f.data.get('story_principals/principal_'+'1'.repeat(32)).status='disabled';
    if(change==='space')f.data.get('story_principal_spaces/family_owner').status='disabled';
    if(change==='family')f.data.get('families/family_owner').ownerAccountId='account_'+'3'.repeat(24);
    if(change==='grant')f.data.get('story_desktop_grants/'+f.grantId).status='revoked';
    if(change==='expired')f.data.get('story_desktop_grants/'+f.grantId).expiresAtMs=f.options.now();
    if(change==='deleted')f.data.get('stories/family_owner_story-a').deletedAt='now';
    if(change==='source')f.data.get('story_source_policies/source-'+'c'.repeat(64)).permissions.view=false;
    await assert.rejects(readAuthoritativeStory(f.repo,f.request,f.options));
  }
});

test('rejects altered bodies, stale timestamps, malformed documents and unknown provenance versions',async()=>{
  for(const change of ['body','time','shape','protocol']){
    const f=fixture();
    if(change==='body')f.request.body={grantId:'desktop-grant-'+'d'.repeat(64)};
    if(change==='time'){const current=f.options.now();f.options.now=()=>current+300001;}
    if(change==='shape')f.data.get('biography_drafts/family_owner_revision-current').revision.draft.chapters[0].content[0]={text:'x',photoId:'photo-x'};
    if(change==='protocol')f.data.get('biography_drafts/family_owner_revision-current').revision.draft.provenanceVersion=99;
    await assert.rejects(readAuthoritativeStory(f.repo,f.request,f.options));
  }
});

test('writes block operations as one new immutable revision while preserving provenance and photos',async()=>{
  const f=fixture('protected'),old=structuredClone(f.data.get('biography_drafts/family_owner_revision-current'));
  old.revision.draft.chapters[0].content.push({photoId:'photo-kept',blockId:'block-'+'d'.repeat(64),sourceIds:[]});Object.assign(old.revision.draft,storyCore.flatten(old.revision.draft.chapters));
  f.data.set('biography_drafts/family_owner_revision-current',structuredClone(old));
  const body={grantId:f.grantId,revisionId:'revision-current',expectedVersion:3,requestId:'desktop-request-1',edits:[{action:'edit',blockId:'block-'+'b'.repeat(64),text:'电脑端修改'}]};
  const result=await writeAuthoritativeStory(f.repo,writeRequest(f,body),f.options);
  assert.deepEqual(result,{ok:true,storyId:'story-a',revisionId:result.revisionId,version:4,replayed:false});assert.match(result.revisionId,/^revision-desktop-[a-f0-9]{32}$/);
  const saved=f.data.get('biography_drafts/family_owner_'+result.revisionId).revision.draft;
  assert.equal(saved.chapters[0].content[0].text,'电脑端修改');assert.deepEqual(saved.chapters[0].content[0].sourceIds,['source-'+'c'.repeat(64)]);
  assert.equal(saved.chapters[0].content[1].photoId,'photo-kept');assert.deepEqual(f.data.get('biography_drafts/family_owner_revision-current'),old);
  assert.equal(f.data.get('stories/family_owner_story-a').sourcePolicyRequired,true);
});

test('write retry is idempotent with a fresh nonce and never creates a second revision',async()=>{
  const f=fixture('protected'),body={grantId:f.grantId,revisionId:'revision-current',expectedVersion:3,requestId:'desktop-request-2',
    edits:[{action:'appendOwn',chapterId:'chapter-one',text:'后来我又想起一件事'}]};
  const first=await writeAuthoritativeStory(f.repo,writeRequest(f,body),f.options),second=await writeAuthoritativeStory(f.repo,writeRequest(f,body,'uvwxyzABCDEFGHIJ'),f.options);
  assert.equal(second.replayed,true);assert.equal(second.revisionId,first.revisionId);assert.equal(f.data.get('stories/family_owner_story-a').version,4);
  assert.deepEqual(f.data.get('biography_drafts/family_owner_'+first.revisionId).revision.draft.chapters[0].content.at(-1).sourceIds,[]);
});

test('stale versions, changed request fingerprints and forged provenance fail without advancing the story',async()=>{
  for(const change of ['stale','fingerprint','sourceIds','unknownBlock']){
    const f=fixture('protected'),base={grantId:f.grantId,revisionId:'revision-current',expectedVersion:3,requestId:'desktop-request-3',
      edits:[{action:'edit',blockId:'block-'+'b'.repeat(64),text:'修改'}]};
    if(change==='stale')base.expectedVersion=2;
    if(change==='fingerprint'){
      await writeAuthoritativeStory(f.repo,writeRequest(f,base),f.options);
      const changed={...base,edits:[{...base.edits[0],text:'另一份修改'}]};
      await assert.rejects(writeAuthoritativeStory(f.repo,writeRequest(f,changed,'uvwxyzABCDEFGHIJ'),f.options),{code:'version_conflict'});continue;
    }
    if(change==='sourceIds')base.edits=[{...base.edits[0],sourceIds:[]}];
    if(change==='unknownBlock')base.edits[0].blockId='block-'+'e'.repeat(64);
    await assert.rejects(writeAuthoritativeStory(f.repo,writeRequest(f,base),f.options));
    assert.equal(f.data.get('stories/family_owner_story-a').version,3);assert.equal([...f.data.keys()].some(key=>key.includes('revision-desktop-')),false);
  }
});
