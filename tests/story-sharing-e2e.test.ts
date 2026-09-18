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
