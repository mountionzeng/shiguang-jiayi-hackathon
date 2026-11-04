import assert from 'node:assert/strict';
import test from 'node:test';
import {saveArticle} from '../miniprogram/services/articleService';
import {articleChapter} from '../miniprogram/services/articleModules';

test('article save sends stable source IDs alongside text and refuses unconfirmed saves',async context=>{
 const prior=Object.getOwnPropertyDescriptor(globalThis,'wx');
 context.after(()=>{if(prior)Object.defineProperty(globalThis,'wx',prior);else delete (globalThis as any).wx;});
 let payload:any;
 Object.defineProperty(globalThis,'wx',{configurable:true,value:{cloud:{callFunction:async({data}:any)=>{payload=data;return {result:{revisionId:'revision-next',version:2}};}}}});
 const chapter=articleChapter({id:'chapter-one',title:'合写的文章',memoryIds:['memory-one','memory-two','memory-one'],content:[{text:'正文'}]});
 const request={requestId:'request-reuse-001',storyId:'story-one',revisionId:'revision-before',expectedVersion:1,chapter,sourceMemoryIds:chapter.memoryIds};
 await saveArticle(request);
 assert.deepEqual(payload.chapter.memoryIds,['memory-one','memory-two']);assert.equal(payload.action,'articleSave');assert.equal(payload.chapter.content[0].text,'正文');
 assert.deepEqual(chapter.memoryIds,['memory-one','memory-two','memory-one']);
 const {sourceMemoryIds,...oldPending}=request;await saveArticle(oldPending);
 assert.ok(!('memoryIds' in payload.chapter),'a persisted pre-upgrade request keeps its original retry fingerprint');
 assert.ok(!('sourceMemoryIds' in payload));
 assert.equal(JSON.stringify(payload),JSON.stringify({...oldPending,action:'articleSave',chapter:{
  id:chapter.id,title:chapter.title,content:chapter.content.map(block=>({blockId:block.blockId,text:block.text})),layout:chapter.layout,packageAssets:{},
 }}),'legacy payload property order also matters to the server request hash');
 wx.cloud.callFunction=(async()=>({result:{error:'INVALID_INPUT',message:'云端暂不支持此保存格式'}})) as any;
 await assert.rejects(saveArticle(request),/云端暂不支持/);
});
