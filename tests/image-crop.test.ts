import test from 'node:test';
import assert from 'node:assert/strict';
import {imageCropFrame} from '../miniprogram/services/imageCrop';
const {normalizeCrop,renderRoleImage}=require('../cloudfunctions/storyImages/imageCrop');
const sharp=require('sharp');
test('cover and backdrop crop frames preserve aspect and clamp dragging/zoom within original',()=>{
 for(const purpose of ['cover','backdrop'])for(const dims of [[1600,900],[600,1200]])for(const zoom of [1,2,3])for(const x of [0,.5,1]){
  const f=imageCropFrame(dims[0],dims[1],purpose,zoom,x,1),c=normalizeCrop(f.crop,purpose);
  assert.ok(c.x>=0&&c.y>=0&&c.x+c.width<=1.000002&&c.y+c.height<=1.000002);
  assert.ok(Math.abs(c.width*dims[0]/(c.height*dims[1])-(purpose==='cover'?2/3:3/4))<.00001);
 }
});
test('reject forged, tiny, nonfinite or out-of-bounds crop',()=>{
 for(const crop of [{x:-1,y:0,width:1,height:1},{x:0,y:0,width:NaN,height:1},{x:.9,y:0,width:.5,height:1},{x:0,y:0,width:.001,height:1}])assert.throws(()=>normalizeCrop(crop,'cover'));
});
test('crop creates correct-size pixels, leaves original unchanged, and restores AI label metadata',async()=>{
 const original=await sharp({create:{width:800,height:600,channels:3,background:'#2277aa'}}).png().toBuffer();
 const before=Buffer.from(original);
 for(const purpose of ['cover','backdrop']){
  const crop=imageCropFrame(800,600,purpose).crop;
  const output=await renderRoleImage(original,crop,purpose,true);
  const meta=await sharp(output.buffer).metadata();
  assert.equal(meta.width,purpose==='cover'?800:900);assert.equal(meta.height,1200);
  const {createAigcMetadataWriter}=require('../cloudfunctions/storyImages/aigcMetadata');
  const marked=createAigcMetadataWriter({contentProducer:'test'}).writeForSource(output.buffer,'image/png','crop-test');
  assert.ok(marked.buffer.includes(Buffer.from('AIGC')));
 }
 assert.deepEqual(original,before);
 await assert.rejects(renderRoleImage(original,{x:0,y:0,width:1,height:1},'cover',false));
});
