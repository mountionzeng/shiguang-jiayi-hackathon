import test from 'node:test';
import assert from 'node:assert/strict';
const {fixture}=require('./helpers/story-access-fixture.js');
const {resolveStoryIdentity}=require('../cloudfunctions/storyBooks/identity.js');
const {materializeOwnedDraft}=require('../cloudfunctions/storyBooks/provenance.js');
const {createStoryService}=require('../cloudfunctions/storyBooks/service.js');
const core=require('../cloudfunctions/storyBooks/core.js');

test('owner selection travels through the page and real dispatcher without leaking an unselected chapter',async()=>{
  const f=fixture();f.account('owner');await resolveStoryIdentity(f.repo,{APPID:'wx-original',OPENID:'owner'},{bootstrapAppId:'wx-original'});
  const chapters=[{id:'chapter-private',title:'不公开',memoryIds:[],content:[{text:'没有选择的秘密'}]},
    {id:'chapter-card',title:'夏天',memoryIds:[],content:[{text:'井水里的西瓜很凉。'}]}];
  const draft=materializeOwnedDraft({title:'外婆家的夏天',chapters,...core.flatten(chapters),sourceCount:0,generatedAt:'',generationMode:'local-demo'},
    {familyId:'family_owner',storyId:'story-summer',revisionId:'revision-card'});
  f.tables.set('stories:family_owner_story-summer',{id:'story-summer',familyId:'family_owner',title:'外婆家的夏天',version:1,currentRevisionId:'revision-card'});
  f.tables.set('biography_drafts:family_owner_revision-card',{familyId:'family_owner',storyId:'story-summer',revision:{id:'revision-card',storyId:'story-summer',draft}});
  const service=createStoryService(f.repo,{accessEnabled:true,rulesReady:true,shareCardEnabled:true,bootstrapAppId:'wx-original',sharedReadFamilyIds:['family_owner'],
    approveShareCard:async()=>true,signMedia:async()=>{throw new Error('no photo selected');}});
  const previousWx=(globalThis as any).wx,previousPage=(globalThis as any).Page;let definition:any;
  const canvas={setFontSize:()=>{},measureText:(text:string)=>({width:text.length*30}),setFillStyle:()=>{},fillRect:()=>{},setTextAlign:()=>{},fillText:()=>{},
    setStrokeStyle:()=>{},setLineWidth:()=>{},beginPath:()=>{},moveTo:()=>{},lineTo:()=>{},stroke:()=>{},draw:(_reserve:boolean,done:()=>void)=>done(),drawImage:()=>{}};
  (globalThis as any).Page=(value:any)=>definition=value;
  (globalThis as any).wx={hideShareMenu:()=>{},cloud:{callFunction:async({data}:any)=>{try{return {result:await service({APPID:'wx-original',OPENID:'owner'},data)};}catch(error:any){return {result:{error:'STORY_BOOK_ERROR',code:error.code,message:error.message}};}}},
    createCanvasContext:()=>canvas,canvasToTempFilePath:({success}:any)=>success({tempFilePath:'/tmp/authorized-card.jpg'}),getImageInfo:()=>{}};
  try{await import('../miniprogram/packages/story-sharing/pages/card/index');const page={...definition,data:structuredClone(definition.data),setData(update:any){Object.assign(this.data,update);}};
    page.onLoad({storyId:'story-summer'});page.hidden=false;await page.refresh();const selected=draft.chapters[1].content[0].blockId;
    page.chooseChapter({detail:{value:'chapter-card'}});page.chooseBlocks({detail:{value:[selected]}});await page.preview();
    assert.equal(page.data.previewPath,'/tmp/authorized-card.jpg');assert.equal(page.descriptor.paragraphs[0],'井水里的西瓜很凉。');
    assert.equal(JSON.stringify(page.descriptor).includes('没有选择的秘密'),false);
  }finally{(globalThis as any).wx=previousWx;(globalThis as any).Page=previousPage;}
});


test('two article revisions keep directory, export and authorized receiver on the same title and full text',async()=>{
  const {articleChapter}=await import('../miniprogram/services/articleModules');
  const {saveArticle}=await import('../miniprogram/services/articleService');
  const {snapshotFromState}=await import('../miniprogram/services/bookSend');
  const {grantIdFor}=require('../cloudfunctions/storyBooks/access');
  const {previewBookExport}=require('../cloudfunctions/storyBooks/bookExports');
  const f=fixture();f.account('owner');f.account('reader');
  const identity=(OPENID:string)=>resolveStoryIdentity(f.repo,{APPID:'wx-original',OPENID},{bootstrapAppId:'wx-original'});
  const owner=await identity('owner'), reader=await identity('reader');
  const chapters=[{id:'chapter-latest',title:'旧章名',memoryIds:[],content:[{text:'旧正文'}]}];
  const draft={title:'最新书名',chapters,...core.flatten(chapters),generationMode:'local-demo',sourceCount:0,generatedAt:''};
  const story={id:'story-latest',familyId:'family_owner',title:draft.title,version:1,currentRevisionId:'revision-initial',memoryIds:[]};
  f.tables.set('stories:family_owner_story-latest',story);
  f.tables.set('biography_drafts:family_owner_revision-initial',{familyId:'family_owner',storyId:story.id,revision:{id:story.currentRevisionId,storyId:story.id,draft}});
  f.tables.set('story_grants:'+grantIdFor('family_owner',story.id,reader.principalId),{familyId:'family_owner',storyId:story.id,principalId:reader.principalId,ownerPrincipalId:owner.principalId,status:'active',version:1,scope:{type:'chapters',chapterIds:['chapter-latest']},permissions:{read:true}});
  const service=createStoryService(f.repo,{accessEnabled:true,rulesReady:true,bootstrapAppId:'wx-original',sharedReadFamilyIds:['family_owner','family_reader'],approveChapterText:async()=>true});
  const previousWx=(globalThis as any).wx;
  (globalThis as any).wx={cloud:{callFunction:async({data}:any)=>({result:await service({APPID:'wx-original',OPENID:'owner'},data)})}};
  try {
    let current=story;
    for (const [index,text] of ['新正文，第一版。','第二版全文。🌿最后一行也要一起分享。'].entries()) {
      const row=f.tables.get('biography_drafts:family_owner_'+current.currentRevisionId);
      const article=articleChapter(row.revision.draft.chapters[0]);
      article.title='最新章节'+(index+1);article.content[0].text=text;
      const result=await saveArticle({requestId:'request-latest-'+index,storyId:story.id,revisionId:current.currentRevisionId,expectedVersion:current.version,chapter:article});
      current=f.tables.get('stories:family_owner_story-latest');
      assert.equal(current.currentRevisionId,result.revisionId);
      const revision=f.tables.get('biography_drafts:family_owner_'+result.revisionId).revision;
      const snapshot=snapshotFromState({stories:[current],manuscriptRevisions:[revision]} as any,{storyId:story.id,revisionId:result.revisionId,version:result.version},'owner');
      assert.equal(snapshot.title,'最新书名');assert.equal(snapshot.chapters[0].text,text);
      assert.equal(snapshot.chapters[0].characterCount,Array.from(text).length);
      const {descriptor}=await previewBookExport(f.repo,owner,{familyId:'family_owner',storyId:story.id,revisionId:result.revisionId,expectedVersion:result.version,scope:'book',chapterIds:[],coverImageIds:[]},{approve:async()=>true});
      assert.equal(descriptor.chapters[0].text,text);assert.equal(descriptor.chapters[0].title,article.title);assert.equal(snapshot.chapters[0].title,'第一章 · '+article.title);
      const received=await service({APPID:'wx-original',OPENID:'reader'},{action:'sharedRead',familyId:'family_owner',storyId:story.id});
      assert.equal(received.chapters[0].title,article.title);assert.equal(received.chapters[0].content[0].text,text);
    }
    assert.equal(f.tables.get('biography_drafts:family_owner_revision-initial').revision.draft.chapters[0].content[0].text,'旧正文');
  } finally {(globalThis as any).wx=previousWx;}
});
