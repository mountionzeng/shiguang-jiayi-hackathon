import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const filename = resolve('miniprogram/services/chapterPackageFlow.ts');
const nativeRequire = createRequire(filename);
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

test('export preserves image bytes returned from the native API realm', async () => {
  const bytes = new Uint8Array([255, 216, 255, 224]).buffer;
  const api: any = {};
  vm.runInNewContext(compiled, {
    exports: api,
    require(name: string) {
      const value = nativeRequire(name);
      if (name === './bookImages') return { ...value, readLocalPhoto: async () => '/saved/test.jpg' };
      if (name === './chapterPackageService') return { ...value, chapterPackageEnabled: () => true };
      return value;
    },
    wx: {
      env: { USER_DATA_PATH: '/saved' }, setStorageSync() {},
      getImageInfo({ success }: any) { success({ width: 10, height: 10 }); },
      getFileSystemManager: () => ({
        readFile({ success }: any) { success({ data: bytes }); },
        writeFile({ success }: any) { success(); }, unlink() {},
      }),
      cloud: { uploadFile: async () => ({ fileID: 'cloud://test/package' }) },
    },
  });
  const result = await api.exportChapterToCloud({ id: 'chapter-test', title: '测试', memoryIds: [],
    content: [{ text: '测试\n' }, { photoId: 'photo-test' }] }, '我', '测试故事');
  assert.equal(result.package.assets[0].bytes, 4);
  assert.equal(result.package.assets[0].mime, 'image/jpeg');
  assert.equal(Object.values(result.assetFiles)[0], '/saved/test.jpg');
});

test('export reads chapter AI images from the authorized story list and preserves the AI label', async () => {
  const api:any={}, calls:string[]=[];
  vm.runInNewContext(compiled, {exports:api,require(name:string){
    const value=nativeRequire(name);
    if(name==='./bookImages')return {...value,readLocalPhoto:async()=>''};
    if(name==='./chapterPackageService')return {...value,chapterPackageEnabled:()=>true};
    if(name==='./storyImageService')return {storyImageApi:{listStoryImages:async(id:string)=>{calls.push(id);return {images:[{imageId:'family_owner_img_req-abcdefgh',url:'https://example.test/image.jpg',moderation:'pass',aiGenerated:true}]};}}};
    return value;
  },wx:{env:{USER_DATA_PATH:'/saved'},setStorageSync(){},
    downloadFile:({success}:any)=>success({statusCode:200,tempFilePath:'/tmp/image.jpg'}),
    getImageInfo:({success}:any)=>success({width:10,height:10}),
    getFileSystemManager:()=>({saveFile:({success}:any)=>success({savedFilePath:'/saved/image.jpg'}),readFile:({success}:any)=>success({data:new Uint8Array([255,216,255,224]).buffer}),writeFile:({success}:any)=>success(),unlink(){}}),
    cloud:{uploadFile:async()=>({fileID:'cloud://test/package'})}}});
  const chapter={id:'chapter-test',title:'测试',memoryIds:[],content:[{photoId:'photo-ai-req-abcdefgh'}]};
  const result=await api.exportChapterToCloud(chapter,'我','故事','story-test');
  assert.deepEqual(calls,['story-test']);
  assert.equal(result.package.assets[0].aiGenerated,true);
  await assert.rejects(api.exportChapterToCloud({...chapter,content:[{photoId:'photo-ai-req-notlisted'}]},'我','故事','story-test'),/第 1 张图片无法发送：故事图库暂未提供可用图片/);
});
