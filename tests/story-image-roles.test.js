const test = require('node:test');
const assert = require('node:assert/strict');
const {prepareImageRole} = require('../cloudfunctions/storyImages/imageRoles');
const familyId='family_owner', storyId='story-target', original=familyId+'_img_req-original123';
function fixture(patch={}) {
  const images=new Map([[original,{familyId,storyId:'story-previous',chapterId:'chapter-old',purpose:'illustration',moderation:'pass',fileID:'cloud://env/story-images/family_owner/story-previous/req-original123.png',quality:'pass',...patch}]]);
  let copies=0;
  const repo={getImage:async id=>images.get(id),createImage:async(id,value)=>images.set(id,value),
    getActiveStoryDraft:async()=>({story:{familyId,id:storyId},draft:{chapters:[{id:'chapter-one',content:[{photoId:'photo-own'}]}]}}),
    getPhoto:async()=>({familyId,_openid:'owner',moderation:{ok:true,suggest:'pass'},displayFileID:'cloud://env/user-photos/family_owner/photo-own/display.jpg'})};
  const storage={copy:async(_source,path)=>{copies++;return 'cloud://env/'+path;}};
  const input={familyId,storyId,chapterId:'chapter-one',imageId:original,purpose:'backdrop'};
  return {images,repo,storage,input,copies:()=>copies,run:(change={},ctx={openid:'owner'})=>prepareImageRole(repo,storage,ctx,{...input,...change})};
}
test('retained image can become all three roles, preserving original and reusing retries',async()=>{
  const f=fixture(),before=JSON.stringify(f.images.get(original));
  for(const purpose of ['cover','backdrop','illustration']){
    const first=await f.run({purpose}),second=await f.run({purpose});
    assert.equal(first.imageId,second.imageId);
    const image=f.images.get(first.imageId);
    assert.equal(image.purpose,purpose);assert.equal(image.storyId,storyId);assert.equal(image.originImageId,original);
    assert.match(image.fileID,/story-target\/req-role-/);
  }
  assert.equal(f.copies(),3);assert.equal(JSON.stringify(f.images.get(original)),before);
});
test('owned uploaded picture can be selected without labelling it AI generated',async()=>{
  const f=fixture();const result=await f.run({imageId:'photo-own',purpose:'cover'});
  assert.equal(f.images.get(result.imageId).aiGenerated,false);
  assert.equal(f.images.get(result.imageId).originImageId,'photo-own');
});
test('reject unauthorized owner, changed chapter, risky/deleted/restricted images before copying',async()=>{
  const f=fixture();await assert.rejects(f.run({}, {openid:'stranger'}));
  await assert.rejects(f.run({chapterId:'chapter-missing'}));
  for(const patch of [{familyId:'family_other'},{moderation:'pending'},{deletedAtMs:1},{sourcePolicyRequired:true},{sourceIds:[]}]){
    const x=fixture(patch);await assert.rejects(x.run());assert.equal(x.copies(),0);
  }
});
test('never launder received or other uploader photos into an owned asset',async()=>{
  for(const patch of [{_openid:'other'},{sourcePolicyRequired:true},{sourceIds:['source-1']},{moderation:{ok:false,suggest:'pass'}}]) {
    const f=fixture(),read=f.repo.getPhoto;f.repo.getPhoto=async()=>({...await read(),...patch});
    await assert.rejects(f.run({imageId:'photo-own'}));assert.equal(f.copies(),0);
  }
});
test('rechecks source after copying and refuses a newly revoked image',async()=>{
  const f=fixture();f.storage.copy=async()=>{f.images.get(original).moderation='risky';return 'cloud://copy.png';};
  await assert.rejects(f.run());assert.equal(f.images.size,1);
});
