const test = require('node:test');
const assert = require('node:assert/strict');
const {loadDailySources, dailyMessages, validateDailyQuestion} = require('../cloudfunctions/chatInterview/dailyQuestion');
function database(records) { return {command:{in:ids=>ids},collection: name => ({doc: id => ({get: async () => ({data: records[name + '/' + id]})}),where:query=>({limit:()=>({get:async()=>({data:query._id.map(id=>records[name+'/'+id] && ({_id:id,...records[name+'/'+id]})).filter(Boolean)})})})})}; }
const identity = {familyId:'family_owner'};
test('daily question accepts owned editor block IDs but rejects restricted or malformed sources', async () => {
 const read = item => loadDailySources(database({
  'stories/family_owner_story-one':{familyId:'family_owner',currentRevisionId:'r1'},
  'biography_drafts/family_owner_r1':{familyId:'family_owner',revision:{storyId:'story-one',draft:{chapters:[{content:[item]}]}}}
 }),identity,{storyId:'story-one'});
 for (const sourceIds of [undefined,[]]) {
  const result=await read({blockId:'text-own-1',sourceIds,text:'A fictional blue boat floats beside a lighthouse.'});
  assert.match(result.sources[0].text,/blue boat/);
 }
 for (const extra of [{sourceIds:['shared-source']},{sourceIds:null},{sourceIds:'bad'},{sourcePolicyRequired:true},{provenanceVersion:1}]) {
  await assert.rejects(read({blockId:'text-own-1',text:'Restricted text',...extra}),/STORY_PROTOCOL_REQUIRED/);
 }
});
test('daily question reads saved chapters and personal answers only under authenticated family', async () => {
 const db=database({'stories/family_owner_story-one':{familyId:'family_owner',title:'蓝色旧书',memoryIds:['m1','m2','m3'],currentRevisionId:'r1'},'biography_drafts/family_owner_r1':{revision:{storyId:'story-one',draft:{chapters:[{title:'树下',content:[{text:'我在银杏树下读蓝色旧书。'}]}]}}},'memories/family_owner_m1':{familyId:'family_owner',scope:'personal',text:'旧书是毕业时老师送给我的。'},'memories/family_owner_m2':{familyId:'family_other',scope:'personal',text:'不得泄露'},'memories/family_owner_m3':{familyId:'family_owner',scope:'family',text:'家庭素材不可用'}});
 const result=await loadDailySources(db,identity,{storyId:'story-one',familyId:'family_other'});
 assert.equal(result.sources.length,2); assert.ok(result.sources.some(s=>s.text.includes('老师'))); assert.ok(result.sources.some(s=>s.text.includes('银杏')));
 const messages=dailyMessages(result,['这本书是谁送的？']); assert.match(messages[1].content,/老师/); assert.match(messages[1].content,/这本书是谁送的/); assert.match(messages[0].content,/已经回答/);
});
test('daily source selection rejects deleted stories, protected protocol and deleted memories',async()=>{
 for(const story of [{familyId:'family_owner',deletedAt:'now'},{familyId:'family_other'},{familyId:'family_owner',sourcePolicyRequired:true}]) await assert.rejects(loadDailySources(database({'stories/family_owner_story-one':story}),identity,{storyId:'story-one'}));
 await assert.rejects(loadDailySources(database({'memories/family_owner_m1':{familyId:'family_owner',scope:'personal',deletedAt:'now',text:'deleted'}}),identity,{memoryId:'m1'}),/NO_DAILY_SOURCES/);
});
test('daily result must cite actual evidence and must not repeat previous question',()=>{
 const sources=[{id:'m1',text:'旧书是毕业时老师送给我的。',memoryId:'m1'}];
 const result={dimension:'feeling',text:'这本毕业赠书如今对你意味着什么？',sourceId:'m1',anchor:'毕业时老师送给我的'};
 assert.equal(validateDailyQuestion(JSON.stringify(result),sources,[]).sourceId,'m1');
 assert.throws(()=>validateDailyQuestion(JSON.stringify({...result,anchor:'父亲送的礼物'}),sources,[]),/EVIDENCE/);
 assert.throws(()=>validateDailyQuestion(JSON.stringify(result),sources,[result.text]),/REPEATED/);
 assert.throws(()=>validateDailyQuestion(JSON.stringify({...result,sourceId:'other'}),sources,[]),/EVIDENCE/);
});

test('daily questions retain the ending of a long article and reject artificial excerpt boundaries', async () => {
 const result=await loadDailySources(database({
  'stories/family_owner_story-one':{familyId:'family_owner',currentRevisionId:'r1'},
  'biography_drafts/family_owner_r1':{familyId:'family_owner',revision:{storyId:'story-one',draft:{chapters:[{content:[{blockId:'b1',text:'虚构故事开头。'+'雨落在窗外。'.repeat(240)+'结尾：她改选了安静的蓝色。'}]}]}}}
 }),identity,{storyId:'story-one'});
 assert.match(result.sources[0].text,/改选了安静的蓝色/);
 const base={dimension:'feeling',text:'为什么最后选了安静的蓝色？',sourceId:result.sources[0].id,anchor:'改选了安静的蓝色',focus:'choice',gap:'蓝色选择背后还未讲述的考虑'};
 assert.equal(validateDailyQuestion(JSON.stringify(base),result.sources,[]).focus,'choice');
 assert.throws(()=>validateDailyQuestion(JSON.stringify({...base,anchor:'【中间省略】'}),result.sources,[]),/EVIDENCE/);
});

test('daily topic history blocks rewording the same anchored question but allows a new angle', () => {
 const sources=[{id:'m1',memoryId:'m1',text:'我没有选红色，最后改选了安静的蓝色。'}];
 const prior=[{anchor:'改选了安静的蓝色',focus:'choice',gap:'为何选蓝色'}];
 const next={dimension:'event',text:'选择蓝色时你考虑了什么？',sourceId:'m1',anchor:'最后改选了安静的蓝色',focus:'choice',gap:'蓝色选择时的考虑'};
 assert.throws(()=>validateDailyQuestion(JSON.stringify(next),sources,[],prior),/REPEATED/);
 assert.equal(validateDailyQuestion(JSON.stringify({...next,text:'你想怎样把这片蓝写成一句话？',focus:'expression',gap:'这片蓝色的表达尝试'}),sources,[],prior).focus,'expression');
 const messages=dailyMessages({title:'虚构配色试验',sources},[],prior);
 assert.match(messages[0].content,/选择和自述情绪/);
 assert.deepEqual(JSON.parse(messages[1].content).recentTopics,prior);
});
