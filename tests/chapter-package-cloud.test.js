const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/story-access-fixture');
const {resolveStoryIdentity}=require('../cloudfunctions/storyBooks/identity');
const {createStoryService}=require('../cloudfunctions/storyBooks/service');
const {importChapterPackage,reviseReceivedChapter}=require('../cloudfunctions/storyBooks/chapterPackage');
const {appendOwnExperience}=require('../cloudfunctions/storyBooks/copies');
const {sendOwnReturn,listReturns,decideReturn}=require('../cloudfunctions/storyBooks/returns');
const core=require('../cloudfunctions/storyBooks/core');
const bid=n=>'block-'+String(n).repeat(64).slice(0,64);
const B1=bid('a'),B2=bid('b');
const asset=(photoId,n='c')=>({assetId:'asset-'+n.repeat(32).slice(0,32),mime:'image/jpeg',bytes:1024,sha256:'a'.repeat(64),width:100,height:100,aiGenerated:false,photoId});
const textModule=(id,blockId,y)=>({id,kind:'text',bind:{blockId},rect:{x:60,y,width:780,height:80},fontSize:32,contentWidth:780,contentHeight:80,alignment:'start'});
const layout=()=>({canvas:{width:900,height:1200},settings:{fontId:'default',style:'plain',texture:'none',textureSeed:1,includeCover:false,bodyTextureAssetId:null},
  pages:[{label:'1',modules:[textModule('paragraph-1',B1,100),textModule('paragraph-2',B2,300)]}]});
const chapter=()=>({id:'chapter-from-web',title:'网页来的一章',containsAiText:false,content:[{text:'第一行\n',blockId:B1},{text:'第二行\n',blockId:B2}]});
const ok=async()=>true;
async function setup(){
  const f=fixture();f.account('owner');
  const owner=await resolveStoryIdentity(f.repo,{APPID:'wx-original',OPENID:'owner'},{bootstrapAppId:'wx-original'});
  const origin=[{id:'chapter-orig',title:'原章',memoryIds:[],content:[{text:'第一行\n'},{text:'第二行\n'}]}];
  f.tables.set('stories:family_owner_story-original',{id:'story-original',familyId:'family_owner',title:'原书',bookTitle:'原书',writingMode:'objective',memoryIds:[],version:1,currentRevisionId:'revision-source'});
  f.tables.set('biography_drafts:family_owner_revision-source',{familyId:'family_owner',storyId:'story-original',revision:{id:'revision-source',storyId:'story-original',draft:{title:'原书',chapters:origin,...core.flatten(origin),sourceCount:0,generatedAt:'',generationMode:'local-demo'}}});
  const input=(over={})=>({requestId:'import-request-001',target:{mode:'new',storyId:'story-imported',title:'导入的故事'},chapter:chapter(),layout:layout(),packageId:'cp_test-0000001',lineage:{rootPackageId:'cp_root0001',parentPackageId:null},assets:[],assetPhotos:{},coverAssetId:null,senderName:'小满',...over});
  return {...f,owner,input,deps:{approveText:ok,approveImage:ok}};
}
const stored=(f,id='story-imported')=>{
  const story=f.tables.get('stories:family_owner_'+id);
  return {story,revision:f.tables.get('biography_drafts:family_owner_'+story.currentRevisionId).revision};
};

test('import keeps text, block ids and layout, and leaves the fingerprint empty',async()=>{
  const f=await setup(),result=await importChapterPackage(f.repo,f.owner,f.input(),f.deps);
  assert.equal(result.alreadyReceived,false);
  const {story,revision}=stored(f),saved=revision.draft.chapters[0];
  assert.equal(revision.kind,'version');assert.equal(revision.sourceFingerprint,'');
  assert.deepEqual(saved.content.map(i=>i.blockId),[B1,B2]);
  assert.deepEqual(saved.layout,layout());
  assert.deepEqual(saved.packageLineage,{rootPackageId:'cp_root0001',receivedPackageId:'cp_test-0000001'});
  assert.equal(story.sourcePolicyRequired,true);
  assert.equal(revision.draft.paragraphs.includes('第一行'),true);
});

test('a second import of the same package and a new request id still create one chapter',async()=>{
  const f=await setup();await importChapterPackage(f.repo,f.owner,f.input(),f.deps);
  const replay=await importChapterPackage(f.repo,f.owner,f.input(),f.deps);
  assert.equal(replay.alreadyReceived,true);
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input({requestId:'import-request-002'}),f.deps),{code:'VERSION_CONFLICT'});
  assert.equal(stored(f).revision.draft.chapters.length,1);
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input({chapter:{...chapter(),title:'改过'}}),f.deps),{code:'VERSION_CONFLICT'});
});

test('append mode adds the chapter to an existing story with version checks',async()=>{
  const f=await setup();await importChapterPackage(f.repo,f.owner,f.input(),f.deps);
  const before=stored(f);
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input({requestId:'import-request-003',packageId:'cp_test-0000002',
    target:{mode:'append',storyId:'story-imported',expectedVersion:before.story.version+5,expectedRevisionId:before.story.currentRevisionId}}),f.deps),{code:'VERSION_CONFLICT'});
  const done=await importChapterPackage(f.repo,f.owner,f.input({requestId:'import-request-004',packageId:'cp_test-0000002',
    target:{mode:'append',storyId:'story-imported',expectedVersion:before.story.version,expectedRevisionId:before.story.currentRevisionId}}),f.deps);
  assert.equal(done.alreadyReceived,false);
  const after=stored(f);
  assert.equal(after.revision.draft.chapters.length,2);
  const [first,second]=after.revision.draft.chapters;
  const ids=[...first.content,...second.content].map(b=>b.blockId);
  assert.equal(new Set(ids).size,ids.length,'colliding block ids are re-keyed');
  assert.deepEqual(second.layout.pages[0].modules.map(m=>m.bind.blockId),second.content.map(b=>b.blockId));
  assert.equal(after.story.version,before.story.version+1);
  assert.ok(f.tables.get('biography_drafts:family_owner_'+before.story.currentRevisionId),'old version is kept');
});

test('rejected text or image imports nothing, and an unavailable checker also imports nothing',async()=>{
  const f=await setup(),snapshot=structuredClone(f.tables);
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input(),{approveText:async()=>false,approveImage:ok}),{code:'CONTENT_REJECTED'});
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input(),{approveText:async()=>{throw Object.assign(new Error('x'),{code:'MODERATION_UNAVAILABLE'});},approveImage:ok}),{code:'MODERATION_UNAVAILABLE'});
  const photoAsset=asset('photo-pkg-abc');
  const {photoId:unusedPhotoId,...photoManifest}=photoAsset;
  const withPhoto=f.input({chapter:{...chapter(),content:[...chapter().content,{photoId:photoAsset.photoId,blockId:bid('c')}]},assets:[photoManifest],assetPhotos:{[photoAsset.assetId]:photoAsset.photoId}});
  await assert.rejects(importChapterPackage(f.repo,f.owner,withPhoto,{approveText:ok,approveImage:async()=>false}),{code:'CONTENT_REJECTED'});
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input(),{}),{code:'MODERATION_UNAVAILABLE'});
  assert.deepEqual(f.tables,snapshot);
});

test('layout over 60 KB or pointing at a missing block is refused',async()=>{
  const f=await setup(),snapshot=structuredClone(f.tables);
  const big=layout();big.pages[0].modules=Array.from({length:260},(_,i)=>textModule('paragraph-'+(i+1),B1,i));
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input({layout:big}),f.deps),{code:'LAYOUT_TOO_LARGE'});
  const dangling=layout();dangling.pages[0].modules.push(textModule('paragraph-9',bid('f'),500));
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input({layout:dangling}),f.deps),{code:'INVALID_INPUT'});
  assert.deepEqual(f.tables,snapshot);
});

test('layout size is bounded by the shared story rule, not only by import',()=>{
  const big=layout();big.pages[0].modules=Array.from({length:260},(_,i)=>textModule('paragraph-'+(i+1),B1,i));
  const chapters=[{id:'chapter-one',title:'章',memoryIds:[],content:chapter().content,layout:big}];
  assert.throws(()=>core.validateDraft({title:'书',chapters,...core.flatten(chapters)},{memoryIds:[]}),/60 KB/);
  chapters[0].layout=layout();
  assert.doesNotThrow(()=>core.validateDraft({title:'书',chapters,...core.flatten(chapters)},{memoryIds:[]}));
});

test('layout does not change the fingerprint of the story',()=>{
  const state=(withLayout)=>({contributions:[{id:'m1',text:'记忆',photoIds:[]}],stories:[{id:'story-a',writingMode:'objective',memoryIds:['m1']}],
    manuscriptRevisions:[{storyId:'story-a',draft:{chapters:[{id:'chapter-one',...(withLayout?{layout:layout()}:{})}]}}]});
  assert.equal(core.fingerprint(state(false),'story-a'),core.fingerprint(state(true),'story-a'));
});

test('same-account loop: edit after import, send back, accept remaps the layout and keeps the old version',async()=>{
  const f=await setup();
  const imported=await importChapterPackage(f.repo,f.owner,f.input({origin:{storyId:'story-original',chapterId:'chapter-orig'}}),f.deps);
  let copy=stored(f);
  await appendOwnExperience(f.repo,f.owner,{storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,
    chapterId:imported.chapterId,text:'新加的一行',requestId:'append-after-import'});
  copy=stored(f);
  const sent=await sendOwnReturn(f.repo,f.owner,{storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,
    chapterId:imported.chapterId,requestId:'send-return-import'});
  const pending=await listReturns(f.repo,f.owner);
  assert.deepEqual(pending.returns[0].blocks.map(b=>b.text),['新加的一行']);
  const before=f.tables.get('stories:family_owner_story-original');
  const decided=await decideReturn(f.repo,f.owner,{returnId:sent.returnId,decision:'accept',requestId:'accept-import-return'});
  assert.equal(decided.status,'accepted');
  const original=f.tables.get('stories:family_owner_story-original');
  assert.equal(original.version,before.version+1);
  assert.ok(f.tables.get('biography_drafts:family_owner_'+before.currentRevisionId),'old version can be found again');
  const accepted=f.tables.get('biography_drafts:family_owner_'+original.currentRevisionId).revision;
  assert.equal(accepted.kind,'version');
  const target=accepted.draft.chapters.find(c=>c.id==='chapter-orig');
  const idByText=Object.fromEntries(target.content.map(b=>[b.text.trim(),b.blockId]));
  const bound=target.layout.pages[0].modules.map(m=>m.bind.blockId);
  assert.deepEqual(bound,[idByText['第一行'],idByText['第二行']]);
  assert.ok(Object.values(idByText).includes(idByText['新加的一行']));
});

test('a protected original-text edit returns by stable package block and is adopted as a new source revision',async()=>{
  const f=await setup(),received=await importChapterPackage(f.repo,f.owner,f.input({origin:{storyId:'story-original',chapterId:'chapter-orig'}}),f.deps);
  let copy=stored(f);
  await reviseReceivedChapter(f.repo,f.owner,{requestId:'edit-original-line',storyId:copy.story.id,revisionId:copy.story.currentRevisionId,
    expectedVersion:copy.story.version,chapterId:received.chapterId,edits:[{blockId:B1,text:'修改后的原文'}],layout:layout()},{approveText:ok});
  copy=stored(f);
  await appendOwnExperience(f.repo,f.owner,{storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,
    chapterId:received.chapterId,text:'新增的亲身经历',requestId:'append-with-source-edit'});
  copy=stored(f);
  const sent=await sendOwnReturn(f.repo,f.owner,{storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,
    chapterId:received.chapterId,requestId:'send-edited-original'});
  const pending=await listReturns(f.repo,f.owner),suggestion=pending.returns[0];
  assert.deepEqual(suggestion.blocks.map(block=>block.text),['新增的亲身经历']);
  assert.deepEqual(suggestion.sourceEdits.map(edit=>edit.text),['修改后的原文\n']);
  const sourceBefore=f.tables.get('biography_drafts:family_owner_revision-source').revision;
  await decideReturn(f.repo,f.owner,{returnId:sent.returnId,decision:'accept',requestId:'accept-edited-original'});
  const source=f.tables.get('stories:family_owner_story-original'),accepted=f.tables.get('biography_drafts:family_owner_'+source.currentRevisionId).revision;
  const sourceChapter=accepted.draft.chapters.find(chapter=>chapter.id==='chapter-orig');
  assert.equal(sourceChapter.content[0].text,'修改后的原文\n');
  assert.ok(sourceChapter.layout,'the layout accompanies the edited source text');
  assert.equal(sourceChapter.content.at(-1).text,'新增的亲身经历');
  assert.equal(sourceChapter.layout.pages[0].modules[0].bind.blockId,sourceChapter.content[0].blockId);
  assert.equal(f.tables.get('biography_drafts:family_owner_revision-source').revision,sourceBefore,'previous source revision remains immutable');
});

test('first chapter revision initializes its collection before opening a transaction',async()=>{
  const f=await setup(),received=await importChapterPackage(f.repo,f.owner,f.input(),f.deps),copy=stored(f);
  let ready=false;
  f.repo.ensureCollection=async name=>{assert.equal(name,'story_chapter_edits');ready=true;};
  const transaction=f.repo.transaction;
  f.repo.transaction=fn=>{
    assert.equal(ready,true,'collection must exist before a CloudBase transaction reads it');
    return transaction(fn);
  };
  const saved=await reviseReceivedChapter(f.repo,f.owner,{requestId:'first-edit-001',storyId:copy.story.id,
    revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,chapterId:received.chapterId,
    edits:[{blockId:B1,text:'首次修订'}]},{approveText:ok});
  assert.equal(saved.alreadySaved,false);
});

test('protected source text and layout revisions preserve source receipts, block ids and old revisions',async()=>{
  const f=await setup(),received=await importChapterPackage(f.repo,f.owner,f.input(),f.deps),copy=stored(f);
  const before=structuredClone(copy.revision.draft.chapters[0]);
  const nextLayout=layout();nextLayout.pages[0].modules[0].rect.y=140;
  const edit={requestId:'protected-edit-001',storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,
    chapterId:received.chapterId,edits:[{blockId:B1,text:'修改后的原文\n'}],layout:nextLayout};
  const saved=await reviseReceivedChapter(f.repo,f.owner,edit,{approveText:ok});
  const next=stored(f),chapter=next.revision.draft.chapters[0];
  assert.equal(saved.alreadySaved,false);assert.equal(next.story.sourcePolicyRequired,true);
  assert.equal(chapter.content[0].text,'修改后的原文\n');assert.equal(chapter.content[0].blockId,B1);
  assert.deepEqual(chapter.content[0].sourceIds,before.content[0].sourceIds);
  assert.equal(chapter.layout.pages[0].modules[0].rect.y,140);
  assert.deepEqual(copy.revision.draft.chapters[0],before,'the previous immutable revision remains intact');
  assert.equal((await reviseReceivedChapter(f.repo,f.owner,edit,{approveText:ok})).alreadySaved,true);
  await assert.rejects(reviseReceivedChapter(f.repo,f.owner,{...edit,edits:[{blockId:B1,text:'篡改重试'}]},{approveText:ok}),{code:'VERSION_CONFLICT'});
});

test('protected revisions refuse recipient-owned blocks and fail closed on moderation or invalid layout',async()=>{
  const f=await setup(),received=await importChapterPackage(f.repo,f.owner,f.input(),f.deps),copy=stored(f);
  await appendOwnExperience(f.repo,f.owner,{storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,
    chapterId:received.chapterId,text:'我自己的补充',requestId:'own-after-package'});
  const current=stored(f),draft=current.revision.draft,chapter=draft.chapters[0],own=chapter.content.at(-1),snapshot=structuredClone(f.tables);
  const input={requestId:'protected-edit-002',storyId:current.story.id,revisionId:current.story.currentRevisionId,expectedVersion:current.story.version,
    chapterId:received.chapterId,edits:[{blockId:own.blockId,text:'替换补充'}],layout:chapter.layout};
  await assert.rejects(reviseReceivedChapter(f.repo,f.owner,input,{approveText:ok}),{code:'STORY_PROTOCOL_REQUIRED'});
  await assert.rejects(reviseReceivedChapter(f.repo,f.owner,{...input,requestId:'protected-edit-003',edits:[{blockId:B1,text:'不当内容'}]},
    {approveText:async()=>false}),{code:'CONTENT_REJECTED'});
  const invalidLayout=layout();invalidLayout.pages[0].modules[0].bind={blockId:bid('f')};
  await assert.rejects(reviseReceivedChapter(f.repo,f.owner,{...input,requestId:'protected-edit-004',edits:[{blockId:B1,text:'正常'}],layout:invalidLayout},{approveText:ok}));
  assert.deepEqual(f.tables,snapshot);
});

test('rejecting a returned chapter leaves the original story untouched',async()=>{
  const f=await setup();
  const imported=await importChapterPackage(f.repo,f.owner,f.input({origin:{storyId:'story-original',chapterId:'chapter-orig'}}),f.deps);
  let copy=stored(f);
  await appendOwnExperience(f.repo,f.owner,{storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,chapterId:imported.chapterId,text:'不想要的一行',requestId:'append-reject-flow'});
  copy=stored(f);
  const sent=await sendOwnReturn(f.repo,f.owner,{storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,chapterId:imported.chapterId,requestId:'send-reject-flow'});
  const before=structuredClone(f.tables.get('stories:family_owner_story-original'));
  assert.equal((await decideReturn(f.repo,f.owner,{returnId:sent.returnId,decision:'reject',requestId:'reject-import-return'})).status,'rejected');
  assert.deepEqual(f.tables.get('stories:family_owner_story-original'),before);
});

test('the dispatcher keeps chapter packages closed unless the dedicated switch is on',async()=>{
  const f=await setup();
  const base={accessEnabled:true,rulesReady:true,bootstrapAppId:'wx-original',sharedReadFamilyIds:['family_owner'],approveChapterText:ok};
  const ctx={APPID:'wx-original',OPENID:'owner'},payload={action:'chapterPackageImport',...f.input()};
  const closed=createStoryService(f.repo,{...base,copyReceiveEnabled:true,invitationsEnabled:true,sharedEditEnabled:true});
  assert.equal((await closed(ctx,{action:'capabilities'})).chapterPackage,false);
  const snapshot=structuredClone(f.tables);
  await assert.rejects(closed(ctx,payload));
  assert.deepEqual(f.tables,snapshot);
  const open=createStoryService(f.repo,{...base,chapterPackageEnabled:true});
  assert.equal((await open(ctx,{action:'capabilities'})).chapterPackage,true);
  assert.equal((await open(ctx,{action:'capabilities'})).copy,false);
});


test('legacy protected drafts retain their source receipts through line-paragraph normalization',()=>{
  const {materializeOwnedDraft,applyBlockEdits,assertLegacyWritable}=require('../cloudfunctions/storyBooks/provenance');
  const chapters=[{id:'chapter-one',title:'旧章',memoryIds:[],content:[{text:'旧行一\n旧行二\n'}]}];
  const flat=core.flatten(chapters),draft={title:'旧书',chapters,...flat};
  draft.paragraphs=flat.content.map(b=>b.text||'').join('').split(/\n\s*\n/).map(t=>t.trim()).filter(Boolean);
  const before=structuredClone(draft),scope={familyId:'family_owner',storyId:'story-old',revisionId:'revision-old',requestId:'legacy-protected-edit'};
  const protectedDraft=materializeOwnedDraft(draft,scope),receipt='source-'+ 'a'.repeat(64);
  protectedDraft.chapters[0].content[0].sourceIds=[receipt];Object.assign(protectedDraft,core.flatten(protectedDraft.chapters));
  protectedDraft.paragraphs=draft.paragraphs;
  const changed=applyBlockEdits(protectedDraft,[{action:'edit',blockId:protectedDraft.chapters[0].content[0].blockId,text:'改过的行\n下一行\n'}],scope);
  assert.deepEqual(changed.chapters[0].content[0].sourceIds,[receipt]);
  assert.deepEqual(changed.paragraphs,core.flatten(changed.chapters).paragraphs);
  assert.deepEqual(draft,before);
  assert.throws(()=>assertLegacyWritable({sourcePolicyRequired:true},changed),{code:'STORY_PROTOCOL_REQUIRED'});
});

test('append accepts an owned legacy story without losing text, photos or its historical revision',async()=>{
  const f=await setup(),old=f.tables.get('biography_drafts:family_owner_revision-source');
  old.revision.draft.chapters[0].content=[{text:'旧第一行\n旧第二行\n'},{photoId:'photo-legacy'}];
  Object.assign(old.revision.draft,core.flatten(old.revision.draft.chapters));
  old.revision.draft.paragraphs=old.revision.draft.content.map(b=>b.text||'').join('').split(/\n\s*\n/).map(t=>t.trim()).filter(Boolean);
  const before=structuredClone(old);
  await importChapterPackage(f.repo,f.owner,f.input({target:{mode:'append',storyId:'story-original',expectedVersion:1,expectedRevisionId:'revision-source'}}),f.deps);
  const saved=stored(f,'story-original').revision.draft.chapters;
  assert.equal(saved.length,2);
  assert.deepEqual(saved[0].content.map(({blockId,sourceIds,...body})=>body),before.revision.draft.chapters[0].content);
  assert.ok(saved[0].content.every(b=>b.sourceIds.length===0));
  assert.deepEqual(f.tables.get('biography_drafts:family_owner_revision-source'),before);
});

test('a protected target with missing provenance cannot be relabelled as owned on import',async()=>{
  const f=await setup();f.tables.get('stories:family_owner_story-original').sourcePolicyRequired=true;
  const before=structuredClone(f.tables);
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input({target:{mode:'append',storyId:'story-original',expectedVersion:1,expectedRevisionId:'revision-source'}}),f.deps),{code:'STORY_PROTOCOL_REQUIRED'});
  assert.deepEqual(f.tables,before);
});

test('imports into different stories cannot overwrite the receipt used by a prior retry',async()=>{
  const f=await setup();const first=await importChapterPackage(f.repo,f.owner,f.input(),f.deps);
  await importChapterPackage(f.repo,f.owner,f.input({requestId:'import-second-story',target:{mode:'new',storyId:'story-second',title:'第二本'}}),f.deps);
  const retry=await importChapterPackage(f.repo,f.owner,f.input(),f.deps);
  assert.equal(retry.storyId,first.storyId);assert.equal(retry.revisionId,first.revisionId);
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input({packageId:'cp_different-0001'}),f.deps),{code:'VERSION_CONFLICT'});
});

test('new story titles and sender names are moderated, and duplicate story names cannot bypass the name index',async()=>{
  const f=await setup(),before=structuredClone(f.tables);
  for(const bad of ['导入的故事','小满']){
    await assert.rejects(importChapterPackage(f.repo,f.owner,f.input(),{...f.deps,approveText:async text=>!text.includes(bad)}),{code:'CONTENT_REJECTED'});
    assert.deepEqual(f.tables,before);
  }
  await importChapterPackage(f.repo,f.owner,f.input(),f.deps);
  assert.equal(f.tables.get('story_names:family_owner_'+core.hash('导入的故事')).storyId,'story-imported');
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input({requestId:'duplicate-story-name',target:{mode:'new',storyId:'story-second',title:'导入的故事'}}),f.deps),{code:'DUPLICATE_TITLE'});
});

test('the image gate rejects mismatched owners, deleted photos, non-pass moderation and protected receipts',async()=>{
  const f=await setup(),ctx={APPID:'wx-original',OPENID:'owner'},photoId='photo-checked';
  const dispatch=createStoryService(f.repo,{accessEnabled:true,rulesReady:true,bootstrapAppId:'wx-original',sharedReadFamilyIds:['family_owner'],chapterPackageEnabled:true,approveChapterText:ok});
  const photoAsset=asset(photoId);
  const {photoId:unusedPhotoId,...photoManifest}=photoAsset;
  const input={action:'chapterPackageImport',...f.input({layout:null,chapter:{...chapter(),content:[{photoId,blockId:B1}]},assets:[photoManifest],assetPhotos:{[photoAsset.assetId]:photoId},coverAssetId:photoAsset.assetId})};
  const photo={familyId:'family_owner',photoId,_openid:'owner',displayFileID:`cloud://test/user-photos/family_owner/${photoId}/display.jpg`,moderation:{ok:true,suggest:'pass'}};
  for(const patch of [{familyId:'family_other'},{_openid:'other'},{deletedAt:'now'},{moderation:{ok:true,suggest:'review'}},{sourceIds:[]},{sourcePolicyRequired:true}]){
    f.tables.set('photos:family_owner__'+photoId,{...photo,...patch});const before=structuredClone(f.tables);
    await assert.rejects(dispatch(ctx,input),{code:'CONTENT_REJECTED'});assert.deepEqual(f.tables,before);
  }
  f.tables.set('photos:family_owner__'+photoId,{...photo,moderation:{ok:false,suggest:'review'}});
  await assert.rejects(dispatch(ctx,input),{code:'MODERATION_PENDING'});
  f.tables.set('photos:family_owner__'+photoId,photo);
  assert.equal((await dispatch(ctx,input)).ok,true);
  const saved=stored(f).revision.draft.chapters[0];
  assert.deepEqual(saved.packageAssets,{[photoAsset.assetId]:{photoId,aiGenerated:false}});
  assert.equal(saved.packageCoverAssetId,photoAsset.assetId);
});

test('return layout never guesses which identical legacy text block was meant or duplicates the source text',async()=>{
  const f=await setup(),original=f.tables.get('biography_drafts:family_owner_revision-source').revision.draft;
  original.chapters[0].content=[{text:'重复\n'},{text:'重复\n'},{text:'唯一\n'}];Object.assign(original,core.flatten(original.chapters));
  const c={...chapter(),content:[{text:'重复\n',blockId:B1},{text:'唯一\n',blockId:B2}]};
  const imported=await importChapterPackage(f.repo,f.owner,f.input({chapter:c,origin:{storyId:'story-original',chapterId:'chapter-orig'}}),f.deps);
  let copy=stored(f);
  await appendOwnExperience(f.repo,f.owner,{storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,chapterId:imported.chapterId,text:'新补充',requestId:'append-duplicate-return'});
  copy=stored(f);
  const sent=await sendOwnReturn(f.repo,f.owner,{storyId:copy.story.id,revisionId:copy.story.currentRevisionId,expectedVersion:copy.story.version,chapterId:imported.chapterId,requestId:'send-duplicate-return'});
  const record=f.tables.get('story_returns:'+sent.returnId);
  assert.equal(record.senderTexts,undefined,'layout metadata must not store another copy of the original text');
  assert.equal(JSON.stringify(record).includes('重复'),false);
  await decideReturn(f.repo,f.owner,{returnId:sent.returnId,decision:'accept',requestId:'accept-duplicate-return'});
  const target=stored(f,'story-original').revision.draft.chapters[0];
  assert.deepEqual(target.content.map(b=>b.text),['重复\n','重复\n','唯一\n','新补充']);
  assert.deepEqual(target.layout.pages[0].modules.map(m=>m.bind.blockId),[target.content[2].blockId]);
});

test('an invalid origin chapter is refused atomically',async()=>{
  const f=await setup(),before=structuredClone(f.tables);
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input({origin:{storyId:'story-original',chapterId:'chapter-missing'}}),f.deps));
  assert.deepEqual(f.tables,before);
});

test('layout cannot carry another body, external URLs, invalid geometry or missing text bindings',async()=>{
  const f=await setup();let checks=0;const deps={...f.deps,approveText:async()=>{checks++;return true;}};
  for(const mutate of [
    l=>{l.pages[0].modules[0].text='未审核的第二份正文';},
    l=>{l.pages[0].modules[0].url='https://example.com/image.jpg';},
    l=>{l.pages[0].modules[0].rect.width=-1;},
    l=>{l.pages[0].modules[0].bind.blockId=bid('f');},
    l=>{l.pages.push(...Array.from({length:9},()=>({label:'x',modules:[]})));},
  ]){
    const malformed=layout();mutate(malformed);const before=structuredClone(f.tables);
    await assert.rejects(importChapterPackage(f.repo,f.owner,f.input({layout:malformed}),deps),{code:'INVALID_INPUT'});
    assert.deepEqual(f.tables,before);
  }
  assert.equal(checks,0,'malformed layout is rejected before invoking moderation');
});

test('per-chapter layouts below 60 KB still obey the combined 240000-byte manuscript limit',async()=>{
  const f=await setup(),large=layout();large.pages[0].modules=Array.from({length:200},(_,i)=>textModule('paragraph-'+i,B1,i));
  assert.ok(Buffer.byteLength(JSON.stringify(large))<60000);
  await importChapterPackage(f.repo,f.owner,f.input({layout:large}),f.deps);
  for(let n=1;n<4;n++){
    const {story}=stored(f);
    await importChapterPackage(f.repo,f.owner,f.input({layout:large,requestId:'size-request-'+n,packageId:'cp_size-0000'+n,
      target:{mode:'append',storyId:story.id,expectedVersion:story.version,expectedRevisionId:story.currentRevisionId}}),f.deps);
  }
  const {story}=stored(f),before=structuredClone(f.tables);
  await assert.rejects(importChapterPackage(f.repo,f.owner,f.input({layout:large,requestId:'size-request-final',packageId:'cp_size-final',
    target:{mode:'append',storyId:story.id,expectedVersion:story.version,expectedRevisionId:story.currentRevisionId}}),f.deps),{code:'STORY_COPY_LIMIT'});
  assert.deepEqual(f.tables,before);
});

test('protected edit preserves block identity and layout; merge removes retired references without losing sources',async()=>{
  const {applyBlockEdits}=require('../cloudfunctions/storyBooks/provenance');
  const f=await setup();await importChapterPackage(f.repo,f.owner,f.input(),f.deps);
  const base=stored(f).revision.draft,before=structuredClone(base),scope={familyId:'family_owner',storyId:'story-imported',requestId:'layout-edit-request'};
  const edited=applyBlockEdits(base,[{action:'edit',blockId:B1,text:'改过的一行\n'}],scope);
  assert.equal(edited.chapters[0].content[0].blockId,B1);
  assert.deepEqual(edited.chapters[0].layout,base.chapters[0].layout);
  const merged=applyBlockEdits(edited,[{action:'merge',blockIds:[B1,B2],text:'合并后正文\n'}],{...scope,requestId:'layout-merge-request'});
  assert.equal(merged.chapters[0].layout,undefined);
  assert.equal(merged.chapters[0].content[0].text,'合并后正文\n');
  assert.deepEqual(merged.chapters[0].content[0].sourceIds,base.chapters[0].content[0].sourceIds);
  assert.deepEqual(base,before);
});

test('moderation receives complete adjacent lines and page labels through one bounded moderator call',async()=>{
  const f=await setup(),checked=[];
  await importChapterPackage(f.repo,f.owner,f.input(),{...f.deps,approveText:async text=>{checked.push(text);return true;}});
  assert.equal(checked.length,1);assert.match(checked[0],/第一行\n\n第二行/);
  const g=await setup(),bad=layout();bad.pages[0].label='违规页名';
  await assert.rejects(importChapterPackage(g.repo,g.owner,g.input({layout:bad}),{...g.deps,approveText:async text=>!text.includes('违规页名')}),{code:'CONTENT_REJECTED'});
});
