import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueuePhotoUpload, pendingPhotoUploads, resumePhotoUploads, removeQueuedPhotoUploads } from '../miniprogram/services/photoCloud';
import { prepareReferencePhotos } from '../miniprogram/services/referencePhotos';
import { storyImageApi } from '../miniprogram/services/storyImageService';
import { storyCoverApi } from '../miniprogram/services/storyCoverService';
import { clearAiConsent } from '../miniprogram/services/aiConsent';
import { clearPhotoAiConsent } from '../miniprogram/services/photoAiConsent';

function setup(context: any) {
  const previousWx = (globalThis as any).wx, previousApp = (globalThis as any).getApp;
  const stored = new Map<string, unknown>();
  const statuses = new Map<string, string>();
  const events: string[] = [];
  const state = { failUpload: false, consent: true, beforeUpload: undefined as (() => Promise<void>) | undefined };
  (globalThis as any).getApp = () => ({globalData:{cloudReady:true,imageAiReady:true,aiReady:true}});
  (globalThis as any).wx = {
    env: {USER_DATA_PATH:'wxfile://usr'},
    getStorageSync: (key:string) => stored.get(key),
    setStorageSync: (key:string,value:unknown) => stored.set(key,structuredClone(value)),
    showModal: ({success}:any) => { events.push('consent'); success({confirm:state.consent}); },
    getImageInfo: ({success}:any) => success({width:1200,height:800}),
    compressImage: ({success}:any) => success({tempFilePath:'wxfile://usr/compressed.jpg'}),
    getFileSystemManager: () => ({
      getFileInfo: ({success}:any) => success({size:80000}),
      accessSync: (path:string) => { if (!path.startsWith('wxfile://usr/')) throw new Error('missing'); },
    }),
    cloud: {
      uploadFile: async ({cloudPath}:any) => {
        events.push('upload');
        await state.beforeUpload?.();
        if(state.failUpload) throw new Error('offline');
        return {fileID:'cloud://env/'+cloudPath};
      },
      callFunction: async ({name,data}:any) => {
        if(name==='getOpenId') return {result:{openid:'photo-test-owner'}};
        if(name==='photoAccess') {
          if(data.action==='register') { events.push('register:'+data.photoId); statuses.set(data.photoId,'ok'); return {result:{ok:true}}; }
          events.push('read:'+data.purpose+':'+data.variant);
          return {result:{photos:data.photoIds.map((photoId:string) => ({photoId,status:statuses.get(photoId)||'not_found',
            ...(statuses.get(photoId)==='ok'?{url:'https://example.test/photo.jpg'}:{})}))}};
        }
        if(data.action==='capabilities') return {result:{referencePhotos:true}};
        if(data.action==='submit') { events.push('submit:'+data.purpose); return {result:{job:{
          jobId:'job-test',status:'queued',message:'绘制中',chapterId:data.chapterId,purpose:data.purpose,
          referenceApplied:true,referencePhotoIds:data.referencePhotoIds,
        }}}; }
        return {result:{}};
      },
    },
  };
  clearAiConsent(); clearPhotoAiConsent();
  context.after(() => {clearAiConsent();clearPhotoAiConsent();(globalThis as any).wx=previousWx;(globalThis as any).getApp=previousApp;});
  return { stored,statuses,events,state };
}

test('新照片在同一次生成点击中完成上传登记，插图、底图、封面都实际携带照片',async context => {
  const h=setup(context);
  for(const purpose of ['illustration','backdrop','cover'] as const) {
    const id='photo-'+purpose;
    enqueuePhotoUpload(id,'wxfile://usr/original.jpg');
    if(purpose==='cover') await storyCoverApi.submit({storyId:'story-test',referenceImageIds:[],referencePhotoIds:[id]});
    else await storyImageApi.submitChapterImage({storyId:'story-test',chapterId:'chapter-test',purpose,referencePhotoIds:[id]});
    assert.ok(h.events.indexOf('register:'+id)<h.events.indexOf('submit:'+purpose));
    assert.ok(h.events.indexOf('consent')<h.events.indexOf('upload'));
    assert.equal(pendingPhotoUploads().length,0);
  }
  assert.ok(h.events.includes('read:ai-reference:small'));
  assert.ok(h.events.includes('read:ai-reference:display'));
});

test('旧照片丢失队列时从本机有效文件补传，云端已就绪照片不重复上传',async context => {
  const h=setup(context);
  h.stored.set('shiguang-local-photo-old','wxfile://usr/old.jpg');
  await prepareReferencePhotos(['photo-old']);
  assert.equal(h.statuses.get('photo-old'),'ok');
  const uploads=h.events.filter(e=>e==='upload').length;
  await prepareReferencePhotos(['photo-old']);
  assert.equal(h.events.filter(e=>e==='upload').length,uploads);
});

test('上传失败时不开始付费生成，再点生成可重试成功',async context => {
  const h=setup(context);
  enqueuePhotoUpload('photo-offline','wxfile://usr/offline.jpg');
  h.state.failUpload=true;
  const input={storyId:'story-test',chapterId:'chapter-test',purpose:'backdrop' as const,referencePhotoIds:['photo-offline']};
  await assert.rejects(storyImageApi.submitChapterImage(input),/上传没有完成/);
  assert.ok(!h.events.some(e=>e.startsWith('submit:')));
  h.state.failUpload=false;
  await storyImageApi.submitChapterImage(input);
  assert.ok(h.events.includes('submit:backdrop'));
});

test('拒绝照片授权不上传、不生成；受限或缺失的照片不静默降级成文字生成',async context => {
  const h=setup(context);
  h.state.consent=false;
  enqueuePhotoUpload('photo-private','wxfile://usr/private.jpg');
  await assert.rejects(storyCoverApi.submit({storyId:'story-test',referenceImageIds:[],referencePhotoIds:['photo-private']}),{code:'CONSENT_DECLINED'});
  assert.ok(!h.events.includes('upload'));
  removeQueuedPhotoUploads(['photo-private']);
  for(const status of ['risky','deleted','forbidden','not_found']) {
    h.statuses.set('photo-private',status);
    await assert.rejects(prepareReferencePhotos(['photo-private']));
  }
  assert.ok(!h.events.includes('upload'));
  assert.ok(!h.events.some(e=>e.startsWith('submit:')));
});

test('上传期间新加入的照片不丢失，取消队列中的照片不会被旧快照复活',async context => {
  const h=setup(context);
  enqueuePhotoUpload('photo-first','wxfile://usr/first.jpg');
  enqueuePhotoUpload('photo-cancel','wxfile://usr/cancel.jpg');
  let release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  h.state.beforeUpload=()=>barrier;
  const uploading=resumePhotoUploads();
  await new Promise(resolve=>setImmediate(resolve));
  enqueuePhotoUpload('photo-new','wxfile://usr/new.jpg');
  removeQueuedPhotoUploads(['photo-cancel']);
  release();
  await uploading;
  assert.deepEqual(h.events.filter(e=>e.startsWith('register:')),['register:photo-first','register:photo-new']);
  assert.deepEqual(pendingPhotoUploads(),[]);
});
