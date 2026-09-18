const test=require('node:test');
const assert=require('node:assert/strict');
const {createCopyStorage}=require('../cloudfunctions/storyBooks/copyStorage');
const {MAX_BYTES}=require('../cloudfunctions/storyBooks/copyAssets');
const source='cloud://env.bucket/user-photos/family_owner/photo-one/display.jpg';
const destination=`cloud://env.bucket/story-sharing/copies/copy-${'a'.repeat(64)}/${'b'.repeat(32)}/photo-copy-${'c'.repeat(64)}.jpg`;
const jpeg=Buffer.from([255,216,255,224,1,2,255,217]);
test('storage adapter uploads and verifies exact private bytes without temporary public URLs',async()=>{
  let uploaded;
  const storage=createCopyStorage({downloadFile:async({fileID})=>{assert.ok([source,destination].includes(fileID));return {fileContent:jpeg};},uploadFile:async input=>{uploaded=input;return {fileID:destination};},deleteFile:async({fileList})=>({fileList:fileList.map(fileID=>({fileID,status:0}))})});
  const asset=await storage.copy(source,destination);assert.deepEqual(uploaded.fileContent,jpeg);assert.equal(uploaded.cloudPath,destination.split('/').slice(3).join('/'));
  await storage.verify(asset);await assert.rejects(storage.verify({...asset,sha256:'0'.repeat(64)}));await storage.remove([destination]);
});
test('invalid or oversized media cannot upload and cleanup never deletes source photos',async()=>{
  for(const bytes of [Buffer.from('not a jpeg'),Buffer.alloc(MAX_BYTES+1)]){
    let uploads=0;
    const storage=createCopyStorage({downloadFile:async()=>({fileContent:bytes}),uploadFile:async()=>{uploads++;},deleteFile:async()=>{throw new Error('must not delete');}});
    await assert.rejects(storage.copy(source,destination));assert.equal(uploads,0);await assert.rejects(storage.remove([source]));
  }
});
test('upload path mismatch and per-file deletion failure remain failures',async()=>{
  const storage=createCopyStorage({downloadFile:async()=>({fileContent:jpeg}),uploadFile:async()=>({fileID:source}),deleteFile:async()=>({fileList:[{fileID:destination,status:-1}]})});
  await assert.rejects(storage.copy(source,destination));await assert.rejects(storage.remove([destination]));
});
