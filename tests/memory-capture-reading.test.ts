
import test from 'node:test';
import assert from 'node:assert/strict';
import {captureHasUnreadMedia,captureSourceText,readCaptureMaterials,MemoryCaptureReceipt} from '../miniprogram/services/memoryCapture';

const receipt=(changes:Partial<MemoryCaptureReceipt>={}):MemoryCaptureReceipt=>({id:'capture-test-12345678',familyId:'family_test',status:'saved',text:'用户原话',photoIds:['photo-a'],audio:[],evidence:[],memoryId:'memory-a',message:'',createdAtMs:1,...changes});
test('材料上下文保留所有图片全文、来源标签与未读取提示，不混入过时整理稿',()=>{
  const text='【可见文字】虚构手稿。'+ '第二页的细节。'.repeat(80);
  const source=receipt({photoIds:['photo-a','photo-b'],evidence:[{sourceId:'photo-a',kind:'image-reading',text}],draft:{title:'旧稿',body:'过时的概述'}});
  assert.equal(captureHasUnreadMedia(source),true);
  const context=captureSourceText([source]);
  assert.ok(context.includes(text));assert.match(context,/图片 1（AI读取/);assert.match(context,/未完成读取/);assert.doesNotMatch(context,/过时的概述/);
  source.evidence.push({sourceId:'photo-b',kind:'image-reading',text:'[看不清]'});
  assert.equal(captureHasUnreadMedia(source),false);
  assert.match(captureSourceText([source]),/\[看不清\]/);
});
test('旧120字图片概述仍需重新读正文，录音转写可复用',()=>{
  const source=receipt({audio:[{id:'audio-a',name:'现场录音'}],evidence:[{sourceId:'photo-a',kind:'image-description',text:'旧概述'},{sourceId:'audio-a',kind:'transcript',text:'完整转写'}]});
  assert.equal(captureHasUnreadMedia(source),true);
  const context=captureSourceText([source]);assert.match(context,/机器转写/);assert.match(context,/完整转写/);
});
test('已读材料重开不请求授权或再次付费，纯文字材料也无需模型读取',async()=>{
  const ready=receipt({evidence:[{sourceId:'photo-a',kind:'image-reading',text:'已读取'}]});
  assert.equal(await readCaptureMaterials([ready],()=>assert.fail('no request needed')),true);
  assert.equal(await readCaptureMaterials([receipt({photoIds:[]})],()=>assert.fail('no request needed')),true);
});
