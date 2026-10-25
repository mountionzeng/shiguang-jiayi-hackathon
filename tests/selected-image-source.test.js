const test = require('node:test');
const assert = require('node:assert/strict');
const {selectedTextSource,normalizeSubmitInput} = require('../cloudfunctions/storyImages/core');
const draft = {provenanceVersion:1, chapters:[{id:'chapter-1',content:[
 {blockId:'block-1',sourceIds:[],text:'雨后，小禾放下一只蓝色纸船。'},
 {blockId:'block-2',sourceIds:['private-source'],text:'另一段不可取的内容'},
]}]};
test('selected source uses only the saved excerpt, without unrelated text or images',()=>{
 const source=selectedTextSource({},draft,'chapter-1','block-1','蓝色纸船');
 assert.equal(source.text,'蓝色纸船');assert.equal(source.artText,'蓝色纸船');
 assert.equal(source.characterContext,'');assert.deepEqual(source.photoIds,[]);
});
test('selection cannot bypass provenance or use stale/foreign text',()=>{
 for (const [story,block,text,code] of [
  [{sourcePolicyRequired:true},'block-1','蓝色纸船','STORY_PROTOCOL_REQUIRED'],
  [{},'block-2','另一段不可取的内容','STORY_PROTOCOL_REQUIRED'],
  [{},'block-1','其他故事的文字','REVISION_CHANGED'],
  [{},'missing','蓝色纸船','CHAPTER_NOT_FOUND'],
 ]) assert.throws(()=>selectedTextSource(story,draft,'chapter-1',block,text),{code});
});
test('selected generation rejects incomplete or oversized requests',()=>{
 const base={familyId:'family_owner',storyId:'story-1',chapterId:'chapter-1',purpose:'illustration',requestId:'req-20261025-abcdef12',selectedBlockId:'block-1'};
 assert.equal(normalizeSubmitInput({...base,selectedText:'蓝色纸船'}).selectedText,'蓝色纸船');
 for(const selectedText of ['',42,'字'.repeat(12001)])assert.throws(()=>normalizeSubmitInput({...base,selectedText}),{code:'INVALID_SELECTION'});
 assert.throws(()=>normalizeSubmitInput({...base,selectedText:'纸船',purpose:'cover'}),{code:'INVALID_SELECTION'});
});
