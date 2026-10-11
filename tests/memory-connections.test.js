const test = require('node:test');
const assert = require('node:assert/strict');
const {loadConnectionSources, connectionMessages, validateConnection} = require('../cloudfunctions/chatInterview/memoryConnections');
function fixture() {
 const rows = {a:{familyId:'family_owner',authorMemberId:'owner',scope:'personal',reviewStatus:'confirmed',text:'虚构的小林在树下读蓝色旧书。'},b:{familyId:'family_owner',authorMemberId:'owner',scope:'personal',reviewStatus:'confirmed',text:'虚构的小林毕业时把旧书送给朋友。'}};
 const reads=[];
 const db={collection:table=>({where:()=>({limit:()=>({get:async()=>({data:[{memberId:'owner',role:'owner',relation:'自己'}]})})}),doc:id=>({get:async()=>{reads.push(id);return {data:rows[id.replace('family_owner_','')]};}})})};
 return {rows,reads,db};
}
test('connections only point-read selected memories in the authenticated family',async()=>{
 const f=fixture(); const sources=await loadConnectionSources(f.db,{familyId:'family_owner'},{memoryIds:['a','b'],familyId:'family_other'});
 assert.deepEqual(f.reads,['family_owner_a','family_owner_b']);assert.deepEqual(sources.map(s=>s.id),['a','b']);
 assert.match(connectionMessages(sources)[0].content,/不预设/);assert.match(connectionMessages(sources)[1].content,/虚构/);
});
test('connections reject duplicate, oversized, foreign, deleted, unconfirmed and protocol-bound sources',async()=>{
 for(const memoryIds of [[],['a'],['a','a'],Array.from({length:9},(_,i)=>String(i)),['a','../b']]) await assert.rejects(loadConnectionSources(fixture().db,{familyId:'family_owner'},{memoryIds}));
 for(const patch of [{familyId:'family_other'},{authorMemberId:'other'},{deletedAt:'now'},{scope:'family'},{reviewStatus:'pending'},{sourceIds:[]},{blockId:'block'},{text:''},{text:'字'.repeat(4001)}]) {
  const f=fixture();Object.assign(f.rows.b,patch);await assert.rejects(loadConnectionSources(f.db,{familyId:'family_owner'},{memoryIds:['a','b']}));
 }
});
test('connections need exact quotations from distinct selected memories; no evidence means no observation',async()=>{
 const sources=await loadConnectionSources(fixture().db,{familyId:'family_owner'},{memoryIds:['a','b']});
 const valid={observation:'两段都提到了旧书。',question:'你为什么把这两段放在一起？',evidence:[{memoryId:'a',quote:'读蓝色旧书'},{memoryId:'b',quote:'把旧书送给朋友'}]};
 assert.equal(validateConnection(JSON.stringify(valid),sources).generationMode,'cloud-ai');
 for(const patch of [{evidence:[]},{evidence:[valid.evidence[0],valid.evidence[0]]},{evidence:[valid.evidence[0],{memoryId:'x',quote:'把旧书送给朋友'}]},{evidence:[valid.evidence[0],{memoryId:'b',quote:'母亲送的旧书'}]},{question:'为何？还有呢？'}]) assert.throws(()=>validateConnection(JSON.stringify({...valid,...patch}),sources));
 const none=validateConnection(JSON.stringify({observation:'',question:'你想怎样把这几段放在一起？',evidence:[]}),sources);assert.deepEqual(none.evidence,[]);
});
