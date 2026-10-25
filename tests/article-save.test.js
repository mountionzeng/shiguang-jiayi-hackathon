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
test('direct edits, line splits and resize save one retry-safe version retaining source policies',async()=>{const f=await setup();
 f.input.chapter.content.push({blockId:bid('b'),parentBlockId:bid('a'),text:'新的一行'});f.input.chapter.content[0].text='改过的原文';f.input.chapter.layout=layout([bid('a'),bid('b')]);f.input.chapter.layout.pages[0].modules[0].rect.width=600;
 const result=await saveArticle(f.repo,f.ctx,f.input,options);assert.equal(result.version,2);
 const draft=f.tables.get('biography_drafts:family_owner_'+result.revisionId).revision.draft;
 assert.deepEqual(draft.chapters[0].content[1].sourceIds,f.chapter.content[0].sourceIds);
 assert.ok(f.tables.get('biography_drafts:family_owner_'+f.input.revisionId));
 assert.deepEqual(await saveArticle(f.repo,f.ctx,f.input,options),result);
 await assert.rejects(saveArticle(f.repo,f.ctx,{...f.input,requestId:'request-article-002'},options),{code:'VERSION_CONFLICT'});
});
test('rejects spoofed sources, missing parents, unapproved photos and moderation failures without writes',async()=>{const f=await setup(),before=structuredClone(f.tables);
 const spoof=structuredClone(f.input);spoof.chapter.content[0].sourceIds=[];await assert.rejects(saveArticle(f.repo,f.ctx,spoof,options));
 const parent=structuredClone(f.input);parent.chapter.content.push({blockId:bid('b'),parentBlockId:bid('f'),text:'x'});await assert.rejects(saveArticle(f.repo,f.ctx,parent,options));
 const image=structuredClone(f.input);image.chapter.content.push({blockId:bid('b'),photoId:'photo-other'});await assert.rejects(saveArticle(f.repo,f.ctx,image,{...options,approveImage:async()=>false}));
 await assert.rejects(saveArticle(f.repo,f.ctx,f.input,{...options,approveText:async()=>false}),{code:'CONTENT_REJECTED'});assert.deepEqual(f.tables,before);
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
