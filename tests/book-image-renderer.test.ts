import test from 'node:test';
import assert from 'node:assert/strict';
import {renderBookImages} from '../miniprogram/services/bookImageRenderer';
const material={descriptor:{id:'test',storyId:'story-test',revisionId:'revision-test',storyVersion:1,title:'虚构测试书',chapters:[{id:'chapter-one',title:'第一章',text:'测试正文🌿'.repeat(100)}],coverImageId:'',containsAiText:false},coverUrl:''};
function runtime(){
  const files:string[]=[],removed:string[]=[],drawn:string[]=[];let number=0;
  const ctx:any=new Proxy({measureText:(text:string)=>({width:Array.from(text).length*32}),fillText:(text:string)=>drawn.push(text),},{get:(target:any,key)=>target[key]||(()=>{})});
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
