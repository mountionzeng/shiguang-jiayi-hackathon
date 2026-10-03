const test = require('node:test');
const assert = require('node:assert/strict');
const {loadDailySources, dailyMessages, validateDailyQuestion} = require('../cloudfunctions/chatInterview/dailyQuestion');
function database(records) { return {command:{in:ids=>ids},collection: name => ({doc: id => ({get: async () => ({data: records[name + '/' + id]})}),where:query=>({limit:()=>({get:async()=>({data:query._id.map(id=>records[name+'/'+id] && ({_id:id,...records[name+'/'+id]})).filter(Boolean)})})})})}; }
const identity = {familyId:'family_owner'};
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
