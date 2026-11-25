const test=require('node:test');
const assert=require('node:assert/strict');
const {getMemory}=require('../cloudfunctions/storyBooks/memoryExports');
test('canonical memory reads once while old IDs remain supported and family checked',async()=>{
  for(const variant of ['canonical','legacy','source','wrong-family']){
    const calls=[];
    const id=variant==='legacy'?'memory-one':variant==='source'?'src_family_owner_memory-one':'family_owner_memory-one';
    const repo={get:async(table,key)=>{calls.push(key);return key===id?{familyId:variant==='wrong-family'?'family_other':'family_owner',frontendContributionId:'memory-one',text:'saved'}:undefined;}};
    const row=await getMemory(repo,'family_owner','memory-one');
    if(variant==='wrong-family')assert.equal(row,undefined);
    else assert.equal(row.text,'saved');
    assert.equal(calls.length,variant==='canonical'?1:variant==='legacy'?2:3);
  }
});
