const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../cloudfunctions/storyImages/core');
const {buildSceneMessages} = require('../cloudfunctions/storyImages/scene');
const {createCoverServices, coverSelectionPatch} = require('../cloudfunctions/storyImages/cover');
const familyId = 'family_owner', storyId = 'story-book';
const imageId = familyId + '_img_req-20260923-12345678';
const photoId = 'photo-12345678';
const draft = {title:'一本书',chapters:[{id:'a',title:'开始',content:[{text:'春天。'.repeat(1500)}]},{id:'b',title:'后来',content:[{text:'秋天的终点。'}]}]};
const input = {familyId,storyId,requestId:'req-20260923-12345678',purpose:'cover',coverConsent:true,referenceImageIds:[imageId],referencePhotoIds:[photoId]};

test('封面读取完整全书含末章，超限拒绝而非截掉后文', () => {
  const source=core.bookSource(draft);
  assert.ok(source.text.length > 4000);
  assert.match(source.text,/秋天的终点/);
  assert.equal(source.scope,'book');
  assert.equal(source.chapterCount,2);
  assert.match(buildSceneMessages(source)[0].content,/不要只取第一章/);
  assert.match(buildSceneMessages(source)[1].content,/整本书的全部正文/);
  assert.throws(()=>core.bookSource({chapters:[{content:[{text:'甲'.repeat(core.MAX_BOOK_TEXT+1)}]}]}),{code:'BOOK_TOO_LONG'});
  assert.throws(()=>core.bookSource({chapters:[{content:[{photoId}]}]}),{code:'BOOK_EMPTY'});
});

test('封面要求专门授权，支持混合参考，最多三张且不接受任意地址',()=>{
  const normalized=core.normalizeSubmitInput(input);
  assert.equal(normalized.chapterId,core.COVER_CHAPTER_ID);
  assert.deepEqual(normalized.referencePhotoIds,[photoId]);
  assert.throws(()=>core.normalizeSubmitInput({...input,coverConsent:false}),{code:'CONSENT_REQUIRED'});
  assert.throws(()=>core.normalizeSubmitInput({...input,referenceImageIds:['https://external.example/x']}),{code:'INVALID_REFERENCE_IMAGE'});
  assert.throws(()=>core.normalizeSubmitInput({...input,referencePhotoIds:[photoId,'photo-two','photo-three']}),{code:'INVALID_REFERENCE_IMAGE'});
  assert.throws(()=>core.normalizeSubmitInput({...input,referencePhotoIds:[photoId,photoId]}),{code:'INVALID_REFERENCE_IMAGE'});
});

function services(image={familyId,storyId,fileID:'cloud://image',moderation:'pass'}) {
  const calls=[];
  const current={story:{familyId,id:storyId,version:3},draft,revision:{id:'r'}};
  const repo={getActiveStoryDraft:async()=>current,listStoryPhotoIds:async()=>[photoId],getImage:async()=>image,isImageLinkedToStory:async()=>false};
  const svc=createCoverServices({repo,storage:{tempUrls:async()=>({'cloud://image':'https://valid/image'})},readPhotos:async request=>{
    calls.push(request);return request.photoIds.map(photoId=>({photoId,status:'ok',url:'https://valid/photo'}));
  }});
  return {svc,calls,current};
}

test('参考图只能来自当前书且通过审核，照片经photoAccess权限链读取压缩图',async()=>{
  const h=services();
  const urls=await h.svc.prepare({openid:'owner'},input,h.current);
  assert.deepEqual(urls,['https://valid/image','https://valid/photo']);
  assert.equal(h.calls[0].purpose,'ai-reference');
  assert.equal(h.calls[0].variant,'small');
  assert.equal(h.calls[0].onBehalfOfOpenid,'owner');
  await assert.rejects(h.svc.prepare({openid:'owner'},{...input,referencePhotoIds:['photo-other-book']},h.current),{code:'REFERENCE_IMAGE_NOT_FOUND'});
  for(const patch of [{storyId:'story-other'},{familyId:'family-other'},{moderation:'pending'},{deletedAtMs:1}]) {
    const x=services({familyId,storyId,fileID:'cloud://image',moderation:'pass',...patch});
    await assert.rejects(x.svc.prepare({openid:'owner'},input,x.current),{code:'REFERENCE_IMAGE_NOT_READY'});
  }
  await assert.rejects(h.svc.sources({openid:'intruder'},{familyId,storyId}),{code:'NOT_FAMILY_OWNER'});
});

test('设为封面只更新该书引用，保护并发改稿与审核，支持恢复默认及幂等重试',()=>{
  const story={familyId,id:storyId,version:3,currentRevisionId:'revision-current',imageIds:['old'],coverImageId:'old'};
  const image={familyId,storyId,purpose:'cover',moderation:'pass'};
  const selection={familyId,storyId,imageId,expectedVersion:3};
  const patch=coverSelectionPatch(story,image,selection,'now');
  assert.deepEqual(patch,{coverImageId:imageId,imageIds:['old',imageId],version:4,updatedAt:'now'});
  assert.equal(story.currentRevisionId,'revision-current');
  assert.equal(coverSelectionPatch({...story,coverImageId:imageId},image,{...selection,expectedVersion:2}),undefined);
  assert.throws(()=>coverSelectionPatch({...story,version:4},image,selection),{code:'REVISION_CHANGED'});
  for(const candidate of [{...image,storyId:'story-other'},{...image,moderation:'risky'},{...image,deletedAtMs:1},{...image,purpose:'illustration'}]) {
    assert.throws(()=>coverSelectionPatch(story,candidate,selection),{code:'IMAGE_NOT_READY'});
  }
  assert.equal(coverSelectionPatch(story,undefined,{...selection,imageId:''}).coverImageId,'');
});
