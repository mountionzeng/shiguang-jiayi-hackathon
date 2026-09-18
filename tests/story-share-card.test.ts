import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {storyShareCard} from '../miniprogram/services/storyShareCard';

type Definition=Record<string,any>;
let definition:Definition|undefined;
async function page(){if(definition)return definition;const previous=(globalThis as any).Page;(globalThis as any).Page=(value:Definition)=>definition=value;
  try{await import('../miniprogram/packages/story-sharing/pages/card/index');}finally{(globalThis as any).Page=previous;}assert.ok(definition);return definition;}
function instance(source:Definition){const value:Definition={...source,data:structuredClone(source.data)};value.setData=(patch:Definition)=>Object.assign(value.data,patch);return value;}

test('share card is registered in the isolated sharing package and linked from the book',()=>{
  const app=JSON.parse(readFileSync('miniprogram/app.json','utf8'));
  assert.ok(app.subPackages.find((item:any)=>item.root==='packages/story-sharing').pages.includes('pages/card/index'));
  assert.match(readFileSync('miniprogram/pages/book/book.wxml','utf8'),/data-action="share-card"/);
});

test('old cloud versions show unavailable without submitting an unsupported action',async()=>{
  const previous=(globalThis as any).wx,calls:string[]=[];
  (globalThis as any).wx={cloud:{callFunction:async({data}:any)=>{calls.push(data.action);return {result:{apiVersion:1,independentStories:true}};}}};
  try{await assert.rejects(storyShareCard.source('story-a'),/尚未开放/);assert.deepEqual(calls,['capabilities']);}
  finally{(globalThis as any).wx=previous;}
});

test('hiding the page clears private selection and cancels a pending album save',async()=>{
  const previous=(globalThis as any).wx;
  let saved=false;
  (globalThis as any).wx={cloud:{callFunction:async()=>({result:{descriptor:{id:'card-a'},media:[]}})},saveImageToPhotosAlbum:()=>{saved=true;}};
  try{const p=instance(await page());p.selection={};p.descriptor={id:'card-a'};p.data.chapters=[{title:'private'}];p.data.previewPath='/tmp/private.jpg';
    p.draw=async()=>{p.onHide();return '/tmp/private.jpg';};await p.save();assert.equal(saved,false);assert.deepEqual(p.data.chapters,[]);assert.equal(p.data.previewPath,'');
  }finally{(globalThis as any).wx=previous;}
});

test('client requests a server descriptor with references, never caller-provided manuscript text',async()=>{
  const previous=(globalThis as any).wx,calls:any[]=[];(globalThis as any).wx={cloud:{callFunction:async({data}:any)=>{calls.push(data);return {result:{descriptor:{id:'card-'+'a'.repeat(64)}}};}}};
  try{await storyShareCard.preview({storyId:'story-a',revisionId:'revision-a',chapterId:'chapter-one',blockIds:['block-'+'b'.repeat(64)],photoIds:[]});
    assert.deepEqual(calls[0],{action:'shareCardPreview',storyId:'story-a',revisionId:'revision-a',chapterId:'chapter-one',blockIds:['block-'+'b'.repeat(64)],photoIds:[]});
    assert.equal(JSON.stringify(calls[0]).includes('text'),false);
  }finally{(globalThis as any).wx=previous;}
});

test('page previews the authorized descriptor and a denied album save is never reported as published',async()=>{
  const previous=(globalThis as any).wx,calls:any[]=[];
  const descriptor={id:'card-'+'a'.repeat(64),version:1,storyId:'story-a',revisionId:'revision-a',storyVersion:1,chapterId:'chapter-one',title:'夏天',chapterTitle:'第一章',byline:'拾光家忆 · 故事摘录',paragraphs:['井水里的西瓜。'],photos:[]};
  const canvas={setFontSize:()=>{},measureText:(text:string)=>({width:text.length*30}),setFillStyle:()=>{},fillRect:()=>{},setTextAlign:()=>{},fillText:()=>{},setStrokeStyle:()=>{},setLineWidth:()=>{},beginPath:()=>{},moveTo:()=>{},lineTo:()=>{},stroke:()=>{},draw:(_reserve:boolean,done:()=>void)=>done(),drawImage:()=>{}};
  (globalThis as any).wx={hideShareMenu:()=>{},cloud:{callFunction:async({data}:any)=>{calls.push(data);if(data.action==='capabilities')return {result:{shareCard:true}};if(data.action==='shareCardSource')return {result:{story:{id:'story-a',title:'夏天',version:1},revisionId:'revision-a',chapters:[{id:'chapter-one',title:'第一章',blocks:[{blockId:'block-'+'b'.repeat(64),kind:'text',preview:'井水里的西瓜。',characterCount:8,publishable:true}]}]}};if(data.action==='shareCardPreview')return {result:{descriptor}};return {result:{descriptor,media:[]}};}},
    createCanvasContext:()=>canvas,canvasToTempFilePath:({success}:any)=>success({tempFilePath:'/tmp/story-card.jpg'}),getImageInfo:()=>{},saveImageToPhotosAlbum:({fail}:any)=>fail(new Error('用户拒绝相册权限'))};
  try{const p=instance(await page());p.onLoad({storyId:'story-a'});p.hidden=false;await p.refresh();p.chooseBlocks({detail:{value:['block-'+'b'.repeat(64)]}});await p.preview();assert.equal(p.data.previewPath,'/tmp/story-card.jpg');
    await p.save();assert.match(p.data.notice,/没有保存成功/);assert.doesNotMatch(p.data.notice,/已发布/);assert.equal(JSON.stringify(p.onShareAppMessage()).includes('井水'),false);
    const sent=calls.find(call=>call.action==='shareCardPreview');assert.equal(JSON.stringify(sent).includes('井水'),false);
  }finally{(globalThis as any).wx=previous;}
});
