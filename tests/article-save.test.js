const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/story-access-fixture');
const {resolveStoryIdentity}=require('../cloudfunctions/storyBooks/identity');
const {importChapterPackage}=require('../cloudfunctions/storyBooks/chapterPackage');
const {saveArticle}=require('../cloudfunctions/storyBooks/article');
const {accountActivity}=require('../cloudfunctions/storyBooks/accountActivity');
const bid=c=>'block-'+c.repeat(64);
const layout=(ids)=>({canvas:{width:900,height:1200},settings:{fontId:'default',style:'plain',texture:'none',textureSeed:1,includeCover:false,bodyTextureAssetId:null},pages:[{label:'1',modules:ids.map((id,i)=>({id:'m'+i,kind:'text',bind:{blockId:id},rect:{x:40,y:40+i*150,width:800,height:120},fontSize:42,contentWidth:800,contentHeight:120,alignment:'start'}))}]});
async function setup(){const f=fixture();f.account('owner');const ctx=await resolveStoryIdentity(f.repo,{APPID:'wx-original',OPENID:'owner'},{bootstrapAppId:'wx-original'});
 const result=await importChapterPackage(f.repo,ctx,{requestId:'import-article-01',target:{mode:'new',storyId:'story-article',title:'纸船'},chapter:{id:'chapter-test',title:'第一章',containsAiText:false,content:[{blockId:bid('a'),text:'原文'}]},layout:layout([bid('a')]),packageId:'cp_article001',lineage:{rootPackageId:'cp_article001',parentPackageId:null},assets:[],assetPhotos:{},coverAssetId:null,senderName:'小满'},{approveText:async()=>true,approveImage:async()=>true});
 const chapter=f.tables.get('biography_drafts:family_owner_'+result.revisionId).revision.draft.chapters[0];
 return {...f,ctx,chapter,input:{requestId:'request-article-001',storyId:'story-article',revisionId:result.revisionId,expectedVersion:1,chapter:{id:chapter.id,title:chapter.title,content:chapter.content.map(({blockId,text})=>({blockId,text})),layout:chapter.layout,packageAssets:{}}}};}
const options={approveText:async()=>true,approveImage:async()=>true};
test('own article saves outside sharing rollout without text moderation while cross-account boundaries remain enforced',async()=>{
 const {createStoryService}=require('../cloudfunctions/storyBooks/service');
 const f=await setup();
 const config={accessEnabled:true,rulesReady:true,bootstrapAppId:'wx-original',sharedReadFamilyIds:[],chapterPackageEnabled:false,approveChapterText:async()=>true};
 const service=createStoryService(f.repo,config),context={APPID:'wx-original',OPENID:'owner'};
 config.approveChapterText=async()=>{throw new Error('private saves must not call moderation');};
 f.account('other');
 await assert.rejects(service({APPID:'wx-original',OPENID:'other'},{...f.input,action:'articleSave'}));
 const result=await service(context,{...f.input,action:'articleSave'});
 assert.equal(result.version,2);
 assert.ok(f.tables.get('biography_drafts:family_owner_'+f.input.revisionId));
 await assert.rejects(service(context,{action:'chapterPackageImport'}),{code:'STORY_ACCESS_DISABLED'});
});
test('direct edits, line splits and resize save one retry-safe version retaining source policies',async()=>{const f=await setup();
 f.input.chapter.content.push({blockId:bid('b'),parentBlockId:bid('a'),text:'新的一行'});f.input.chapter.content[0].text='改过的原文';f.input.chapter.layout=layout([bid('a'),bid('b')]);f.input.chapter.layout.pages[0].modules[0].rect.width=600;
 const result=await saveArticle(f.repo,f.ctx,f.input,options);assert.equal(result.version,2);
 const draft=f.tables.get('biography_drafts:family_owner_'+result.revisionId).revision.draft;
 assert.deepEqual(draft.chapters[0].content[1].sourceIds,f.chapter.content[0].sourceIds);
 assert.ok(f.tables.get('biography_drafts:family_owner_'+f.input.revisionId));
 assert.deepEqual(await saveArticle(f.repo,f.ctx,f.input,options),result);
 await assert.rejects(saveArticle(f.repo,f.ctx,{...f.input,requestId:'request-article-002'},options),{code:'VERSION_CONFLICT'});
});
test('rejects spoofed sources, missing parents, unapproved photos without writes',async()=>{const f=await setup(),before=structuredClone(f.tables);
 const spoof=structuredClone(f.input);spoof.chapter.content[0].sourceIds=[];await assert.rejects(saveArticle(f.repo,f.ctx,spoof,options));
 const parent=structuredClone(f.input);parent.chapter.content.push({blockId:bid('b'),parentBlockId:bid('f'),text:'x'});await assert.rejects(saveArticle(f.repo,f.ctx,parent,options));
 const image=structuredClone(f.input);image.chapter.content.push({blockId:bid('b'),photoId:'photo-other'});await assert.rejects(saveArticle(f.repo,f.ctx,image,{...options,approveImage:async()=>false}));
 assert.deepEqual(f.tables,before);
});
test('activity is owner scoped, groups by trusted account and distinguishes missing comparison',async()=>{const f=await setup();
 for(const [id,senderKey] of [['one','account-a'],['two','account-b']])f.tables.set('account_message_receipts:'+id,{familyId:'family_owner',deliveryId:'delivery-'+id,direction:'received',senderKey,senderName:'同名',createdAt:'2026-10-25',kind:'return',package:{storyTitle:'纸船',lineage:{parentPackageId:'missing'},chapters:[{blocks:[{type:'text',text:'收到文字'}]}],assets:[]}});
 f.tables.set('account_message_receipts:secret',{familyId:'family_other',direction:'received',package:{storyTitle:'不能看到'}});
 const {events}=await accountActivity(f.repo,f.ctx);const received=events.filter(e=>e.kind==='发来修改');assert.equal(received.length,2);assert.notEqual(received[0].accountKey,received[1].accountKey);assert.equal(received[0].comparisonAvailable,false);assert.equal(received[0].text,'收到文字');assert.equal(received[0].storyId,'');assert.match(received[0].deliveryId,/^delivery-/);assert.ok(events.some(e=>!e.verified),'historical imports are explicitly unverified');
});
test('ordinary article IDs remain compatible with owned legacy writes without weakening received provenance',()=>{
 const {assertLegacyWritable,materializeOwnedDraft}=require('../cloudfunctions/storyBooks/provenance');
 const core=require('../cloudfunctions/storyBooks/core');
 const chapters=[{id:'chapter-own',title:'自己写的',memoryIds:[],content:[{blockId:bid('e'),text:'自己的文字'}],layout:layout([bid('e')])}];
 const draft={title:'书',chapters,...core.flatten(chapters),sourceCount:0,generatedAt:'',generationMode:'local-demo'};
 assert.doesNotThrow(()=>assertLegacyWritable({},draft));assert.throws(()=>assertLegacyWritable({sourcePolicyRequired:true},draft));
 const materialized=materializeOwnedDraft(draft,{familyId:'family_owner',storyId:'story-own',revisionId:'revision-original'});
 assert.equal(materialized.chapters[0].content[0].blockId,bid('e'));assert.deepEqual(materialized.chapters[0].content[0].sourceIds,[]);
 assert.throws(()=>assertLegacyWritable({},materialized));
});

test('article AI image approval requires same story/chapter, successful review and no source restriction',async()=>{
 const {approveArticleImage}=require('../cloudfunctions/storyBooks/service');
 const ctx={familyId:'family-test',verifiedOpenid:'owner'};
 const image={familyId:ctx.familyId,storyId:'story-test',chapterId:'chapter-test',requestId:'req-abcdefgh',purpose:'illustration',moderation:'pass',fileID:'cloud://env/story-images/family-test/story-test/req-abcdefgh.png'};
 const check=patch=>approveArticleImage({get:async(collection,id)=>collection==='story_images'&&id==='family-test_img_req-abcdefgh'?{...image,...patch}:null},ctx,'photo-ai-req-abcdefgh','story-test','chapter-test');
 assert.equal(await check({}),true);
 assert.equal(await check({requestId:undefined}),true,'existing chapter images derive request ID from storage path');
 for(const patch of [{familyId:'other'},{storyId:'story-other'},{chapterId:'chapter-other'},{requestId:'req-other'},{purpose:'cover'},{moderation:'pending'},{moderation:'fail'},{deletedAtMs:1},{sourcePolicyRequired:true},{sourceIds:[]},{fileID:'https://other/image.png'}])assert.equal(await check(patch),false,JSON.stringify(patch));
});

test('chapter backdrop saves a recoverable version without changing received text provenance',async()=>{
 const f=await setup(),imageId='family_owner_img_req-backdrop123';f.input.chapter.backdropImageId=imageId;
 await assert.rejects(saveArticle(f.repo,f.ctx,f.input,options),{code:'CONTENT_REJECTED'});
 const result=await saveArticle(f.repo,f.ctx,f.input,{...options,approveBackdrop:async(_ctx,id)=>id===imageId});
 const chapter=f.tables.get('biography_drafts:family_owner_'+result.revisionId).revision.draft.chapters[0];
 assert.equal(chapter.backdropImageId,imageId);assert.deepEqual(chapter.content,f.chapter.content);
 assert.ok(f.tables.get('biography_drafts:family_owner_'+f.input.revisionId));
 const cleared=await saveArticle(f.repo,f.ctx,{...f.input,requestId:'request-clear-001',revisionId:result.revisionId,expectedVersion:result.version,chapter:{...f.input.chapter,backdropImageId:''}},options);
 assert.equal(f.tables.get('biography_drafts:family_owner_'+cleared.revisionId).revision.draft.chapters[0].backdropImageId,undefined);
});
test('saved edit records trusted editor and change summary, ignoring forged client attribution',async()=>{
 const f=await setup();f.tables.get('user_accounts:'+f.ctx.accountId).displayName='小禾';
 f.input.editorName='别人';f.input.editedByPrincipalId='principal_'+'f'.repeat(32);
 f.input.chapter.content[0].text='修改后的纸船';
 const result=await saveArticle(f.repo,f.ctx,f.input,options);
 const r=f.tables.get('biography_drafts:family_owner_'+result.revisionId).revision;
 assert.equal(r.editorName,'小禾');assert.equal(r.editedByPrincipalId,f.ctx.principalId);assert.match(r.changeSummary,/修改 1 段文字/);
});

function seedArticleMemory(f,id,patch={}){
 f.tables.set('family_members:family_owner_owner',{familyId:'family_owner',id:'owner',memberId:'owner',role:'owner',relation:'自己'});
 const memory={familyId:'family_owner',id,authorMemberId:'owner',scope:'personal',text:'【虚构】'+id,reviewStatus:'confirmed',...patch};
 f.tables.set('memories:family_owner_'+id,memory);return memory;
}
test('article save atomically adds reusable sources, preserves originals and earlier articles across retry and reopen',async()=>{
 const f=await setup();const m1=seedArticleMemory(f,'memory-one'),m2=seedArticleMemory(f,'memory-two');
 const row=f.tables.get('biography_drafts:family_owner_'+f.input.revisionId);
 row.revision.draft.chapters.push({id:'chapter-earlier',title:'旧文章',memoryIds:['memory-one'],content:[{text:'原来的文章。'}]});
 const earlier=structuredClone(row.revision.draft.chapters[1]);
 f.tables.get('stories:family_owner_story-article').memoryIds=['memory-one'];
 f.input.chapter.memoryIds=['memory-one','memory-two','memory-one'];
 const result=await saveArticle(f.repo,f.ctx,f.input,options);
 const saved=f.tables.get('biography_drafts:family_owner_'+result.revisionId).revision.draft;
 assert.deepEqual(saved.chapters[0].memoryIds,['memory-one','memory-two']);
 assert.deepEqual(saved.chapters[1],earlier);assert.equal(saved.sourceCount,2);
 assert.deepEqual(f.tables.get('stories:family_owner_story-article').memoryIds,['memory-one','memory-two']);
 assert.deepEqual(f.tables.get('memories:family_owner_memory-one'),m1);assert.deepEqual(f.tables.get('memories:family_owner_memory-two'),m2);
 assert.deepEqual(await saveArticle(f.repo,f.ctx,f.input,options),result);
 const legacy={...f.input,requestId:'request-legacy-001',revisionId:result.revisionId,expectedVersion:result.version,chapter:{...f.input.chapter}};
 delete legacy.chapter.memoryIds;
 const edited=await saveArticle(f.repo,f.ctx,legacy,options);
 assert.deepEqual(f.tables.get('biography_drafts:family_owner_'+edited.revisionId).revision.draft.chapters[0].memoryIds,['memory-one','memory-two'],'old clients preserve associations');
});
test('article references may reuse the same memory in another book without moving its first link',async()=>{
 const f=await setup();seedArticleMemory(f,'memory-shared');
 f.tables.set('stories:family_owner_story-earlier',{familyId:'family_owner',id:'story-earlier',memoryIds:['memory-shared']});
 const before=structuredClone(f.tables.get('stories:family_owner_story-earlier'));
 f.input.chapter.memoryIds=['memory-shared'];await saveArticle(f.repo,f.ctx,f.input,options);
 assert.deepEqual(f.tables.get('stories:family_owner_story-earlier'),before);
 assert.deepEqual(f.tables.get('stories:family_owner_story-article').memoryIds,['memory-shared']);
});
test('unavailable or foreign sources fail atomically without changing text, source links or revisions',async()=>{
 for(const patch of [null,{deletedAt:'today'},{familyId:'family_other'},{authorMemberId:'other'},{scope:'family'},{sourcePolicyRequired:true},{sourceIds:['received']}]){
  const f=await setup();seedArticleMemory(f,'memory-good');if(patch)seedArticleMemory(f,'memory-bad',patch);
  f.input.chapter.memoryIds=['memory-good','memory-bad'];const before=structuredClone(f.tables);
  await assert.rejects(saveArticle(f.repo,f.ctx,f.input,options),{code:'STORY_NOT_FOUND'});assert.deepEqual(f.tables,before);
 }
});

test('invalid reference lists are rejected and an existing deleted source does not prevent editing the saved article',async()=>{
 const f=await setup();seedArticleMemory(f,'memory-one');f.input.chapter.memoryIds=['memory-one'];
 for(const memoryIds of [['../memory'],[''],[3],{},Array(501).fill('memory-one')]){
  await assert.rejects(saveArticle(f.repo,f.ctx,{...f.input,chapter:{...f.input.chapter,memoryIds}},options),{code:'INVALID_INPUT'});
 }
 const result=await saveArticle(f.repo,f.ctx,f.input,options);
 f.tables.get('memories:family_owner_memory-one').deletedAt='today';
 const edited=await saveArticle(f.repo,f.ctx,{...f.input,requestId:'request-edited-002',revisionId:result.revisionId,expectedVersion:result.version},options);
 assert.deepEqual(f.tables.get('biography_drafts:family_owner_'+edited.revisionId).revision.draft.chapters[0].memoryIds,['memory-one']);
});

test('confirmed article receipt is replayed before moderation so a lost success cannot turn into a rejection',async()=>{
 const f=await setup();const first=await saveArticle(f.repo,f.ctx,f.input,options);
 let checks=0;
 const rejecting={...options,approveText:async()=>{checks++;return false;}};
 assert.deepEqual(await saveArticle(f.repo,f.ctx,f.input,rejecting),first);
 assert.equal(checks,0);
 await assert.rejects(saveArticle(f.repo,f.ctx,{...f.input,chapter:{...f.input.chapter,title:'不同内容'}},rejecting),{code:'VERSION_CONFLICT'});
 const family=f.tables.get('families:family_owner');family.ownerAccountId='account_'+'0'.repeat(24);
 await assert.rejects(saveArticle(f.repo,f.ctx,f.input,rejecting),{code:'STORY_FORBIDDEN'});
});

test('private edits save the newest title and text even when external moderation requires review',async()=>{
 const f=await setup();let checks=0;
 f.input.chapter.title='解放';f.input.chapter.content[0].text='修改后的完整文章';
 const saved=await saveArticle(f.repo,f.ctx,f.input,{...options,approveText:async()=>{checks++;throw Object.assign(new Error('review'),{code:'MODERATION_REVIEW'});}});
 const story=f.tables.get('stories:family_owner_story-article');
 const reopened=f.tables.get('biography_drafts:family_owner_'+story.currentRevisionId).revision;
 assert.equal(story.currentRevisionId,saved.revisionId);assert.equal(reopened.draft.chapters[0].title,'解放');
 assert.equal(reopened.draft.chapters[0].content[0].text,'修改后的完整文章');assert.equal(checks,0);
 assert.ok(f.tables.get('biography_drafts:family_owner_'+f.input.revisionId));
});

test('a privately saved revision is readable by its owner but an existing reader grant cannot bypass outgoing checks',async()=>{
 const {readAuthorizedStory,grantIdFor}=require('../cloudfunctions/storyBooks/access');
 const f=await setup();f.account('reader');
 const reader=await resolveStoryIdentity(f.repo,{APPID:'wx-original',OPENID:'reader'},{bootstrapAppId:'wx-original'});
 f.input.chapter.title='新标题';f.input.chapter.content[0].text='最新正文';
 const saved=await saveArticle(f.repo,f.ctx,f.input,options);
 const input={familyId:f.ctx.familyId,storyId:f.input.storyId};
 f.tables.set('story_grants:'+grantIdFor(f.ctx.familyId,f.input.storyId,reader.principalId),{familyId:f.ctx.familyId,storyId:f.input.storyId,principalId:reader.principalId,ownerPrincipalId:f.ctx.principalId,status:'active',version:1,scope:{type:'story'},permissions:{read:true}});
 assert.equal((await readAuthorizedStory(f.repo,f.ctx,input)).revisionId,saved.revisionId);
 await assert.rejects(readAuthorizedStory(f.repo,reader,input),{code:'MODERATION_UNAVAILABLE'});
 await assert.rejects(readAuthorizedStory(f.repo,reader,input,{approveText:async()=>false}),{code:'CONTENT_REJECTED'});
 let checked='';const shared=await readAuthorizedStory(f.repo,reader,input,{approveText:async(text)=>{checked=text;return true;}});
 assert.match(checked,/新标题/);assert.match(checked,/最新正文/);assert.equal(shared.revisionId,saved.revisionId);
});
