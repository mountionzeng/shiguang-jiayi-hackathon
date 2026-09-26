import test from 'node:test';
import assert from 'node:assert/strict';
import {renderBookImages} from '../miniprogram/services/bookImageRenderer';
const material={descriptor:{id:'test',storyId:'story-test',revisionId:'revision-test',storyVersion:1,title:'虚构测试书',chapters:[{id:'chapter-one',title:'第一章',text:'测试正文🌿'.repeat(100)}],coverImageId:'',containsAiText:false},coverUrl:''};
function runtime(measureWidth:(text:string,size:number)=>number=(text:string)=>Array.from(text).length*32){
  const files:string[]=[],removed:string[]=[],drawn:string[]=[];let number=0;
  let currentSize=32;
  const ctx:any=new Proxy({measureText:(text:string)=>({width:measureWidth(text,currentSize)}),fillText:(text:string)=>drawn.push(text),},{get:(target:any,key)=>key==='font'?'' : target[key]||(()=>{}),set:(target:any,key,value)=>{if(key==='font')currentSize=Number(String(value).match(/^(\d+)/)?.[1]||32);target[key]=value;return true;}});
  const wx:any={createCanvasContext:()=>ctx,getFileSystemManager:()=>({unlink:({filePath}:any)=>removed.push(filePath)}),getImageInfo:({success}:any)=>success({path:'local-cover',width:600,height:800}),canvasToTempFilePath:({success}:any)=>{const path='temp-'+(++number);files.push(path);success({tempFilePath:path});}};
  (globalThis as any).wx=wx;
  const canvas={getContext:()=>ctx,createImage:()=>{const image:any={};Object.defineProperty(image,'src',{set:()=>image.onload()});return image;}};
  const page:any={setData:(_:any,done:()=>void)=>done(),createSelectorQuery:()=>{const query:any={select:()=>query,fields:()=>query,exec:(done:any)=>done([{node:canvas}])};return query;}};
  return {wx,page,files,removed,drawn};
}
test('renderer exports cover plus complete text pages at requested dimensions',async()=>{
  const f=runtime(),progress:number[]=[];
  const paths=await renderBookImages(material,'pages',32,f.page,()=>true,done=>progress.push(done));
  assert.deepEqual(paths,f.files);assert.ok(paths.length>=3);assert.equal(progress[progress.length-1],paths.length);
  assert.equal(f.drawn.filter(s=>s.includes('测试正文')||s.includes('文🌿')).length>0,true);
  assert.deepEqual(f.removed,[]);
});
test('renderer exports every selected cover before text pages',async()=>{
  const f=runtime(),multi={...material,descriptor:{...material.descriptor,coverImageId:'image-a',coverImageIds:['image-a','image-b']},coverUrl:'https://media.example/a.jpg',coverUrls:['https://media.example/a.jpg','https://media.example/b.jpg']};
  const paths=await renderBookImages(multi,'pages',32,f.page,()=>true,()=>{});
  assert.ok(paths.length>=4);
  assert.ok(f.drawn.includes('封面 1 / 2'));
  assert.ok(f.drawn.includes('封面 2 / 2'));
});
test('renderer refuses to fake the requested text image count',async()=>{
  const f=runtime(),targeted={...material,descriptor:{...material.descriptor,targetTextImageCount:1}};
  await assert.rejects(renderBookImages(targeted,'pages',32,f.page,()=>true,()=>{}),/正文图/);
  assert.deepEqual(f.files,[]);
});
test('renderer adapts font size when the requested text image count is feasible',async()=>{
  const body='测'.repeat(280),measure=(text:string,size:number)=>Array.from(text).length*(size*.9);
  const base={...material,descriptor:{...material.descriptor,chapters:[{id:'chapter-one',title:'第一章',text:body}]}};
  const one=runtime(measure),two=runtime(measure);
  const onePath=await renderBookImages({...base,descriptor:{...base.descriptor,targetTextImageCount:1}},'pages',32,one.page,()=>true,()=>{});
  const twoPath=await renderBookImages({...base,descriptor:{...base.descriptor,targetTextImageCount:2}},'pages',32,two.page,()=>true,()=>{});
  assert.equal(onePath.length,2);
  assert.equal(twoPath.length,3);
  assert.ok(one.drawn.join('').includes(body.slice(0,20)));
  assert.ok(two.drawn.join('').includes(body.slice(0,20)));
});
test('cancellation after export removes generated files and does not continue',async()=>{
  const f=runtime();let active=true;
  await assert.rejects(renderBookImages(material,'pages',32,f.page,()=>active,()=>{active=false;}),/已停止/);
  assert.deepEqual(f.files,['temp-1']);assert.deepEqual(f.removed,['temp-1']);
});
test('canvas export timeout cleans a late success even while the page is still active',async(t)=>{
  const f=runtime();t.mock.timers.enable({apis:['setTimeout']});let complete:any;
  f.wx.canvasToTempFilePath=({success}:any)=>{complete=success;};
  const task=renderBookImages(material,'pages',32,f.page,()=>true,()=>{});
  const rejected=assert.rejects(task,/超时/);
  // Flush getImageInfo, setData, and draw promise continuations.
  for(let i=0;i<10;i++) await Promise.resolve();
  assert.equal(typeof complete,'function');t.mock.timers.tick(20001);await rejected;
  complete({tempFilePath:'late-private-image'});
  assert.deepEqual(f.removed,['late-private-image']);
});
