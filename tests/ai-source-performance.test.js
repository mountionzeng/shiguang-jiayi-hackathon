const assert = require('node:assert/strict');
const {test} = require('node:test');
const organize = require('../cloudfunctions/organizeMemory')._test;
const biography = require('../cloudfunctions/generateBiography')._test;

function fixture(overrides = {}) {
  const counters = {docReads:0, scans:0};
  const record = {familyId:'family_fixture-user', frontendContributionId:'memory-a', scope:'personal', text:'已保存的原文', ...overrides};
  const cloud = {getWXContext:() => ({OPENID:'fixture-user'}), database:() => ({collection:() => ({
    doc:() => ({get:async() => {counters.docReads++; return {data:record};}}),
    where:() => { counters.scans++; const query = {orderBy:() => query, skip:() => query, limit:() => query, get:async() => ({data:[record]})}; return query; },
  })})};
  return {cloud,counters};
}

test('整理单条标准记忆只读目标文档，不分页扫描整个家庭', async () => {
  const {cloud,counters} = fixture();
  const result = await organize.loadMemorySource({memoryId:'memory-a'},cloud);
  assert.deepEqual(result.transcript,['已保存的原文']);
  assert.deepEqual(counters,{docReads:1,scans:0});
});

test('生成正文只读取选中的标准记忆，不扫描家庭历史', async () => {
  const {cloud,counters} = fixture();
  const result = await biography.loadStoryMemories({memoryIds:['memory-a']},cloud);
  assert.equal(result[0].text,'已保存的原文');
  assert.deepEqual(counters,{docReads:1,scans:0});
});

for (const overrides of [{familyId:'family_other'}, {deletedAt:'today'}, {scope:'family'}]) {
  test(`目标文档仍检查归属、删除和范围 ${JSON.stringify(overrides)}`,async() => {
    const {cloud} = fixture(overrides);
    await assert.rejects(() => organize.loadMemorySource({memoryId:'memory-a'},cloud), /MEMORY_NOT_FOUND/);
    await assert.rejects(() => biography.loadStoryMemories({memoryIds:['memory-a']},cloud), /STORY_SOURCE_NOT_FOUND/);
  });
}

test('目标文档读取失败不伪装成旧数据重新全量扫描',async() => {
  let scans = 0;
  const cloud={getWXContext:()=>({OPENID:'fixture-user'}),database:()=>({collection:()=>({
    doc:()=>({get:async()=>{throw new Error('database connection lost');}}),
    where:()=>{scans++;throw new Error('unexpected fallback');},
  })})};
  await assert.rejects(() => organize.loadMemorySource({memoryId:'memory-a'},cloud), /database connection lost/);
  await assert.rejects(() => biography.loadStoryMemories({memoryIds:['memory-a']},cloud), /database connection lost/);
  assert.equal(scans,0);
});

test('20 条标准素材使用一次定向批量读取，按用户选择顺序返回',async() => {
  const ids=Array.from({length:20},(_,i)=>`memory-${i}`);
  const calls=[];
  const cloud={getWXContext:()=>({OPENID:'fixture-user'}),database:()=>({
    command:{in:values=>({ids:values})},
    collection:()=>({
      doc:()=>{throw new Error('unexpected individual read');},
      where:filter=>{calls.push(filter);return {limit:limit=>({get:async()=>{
        assert.equal(limit,20);
        return {data:[...ids].reverse().map(id=>({_id:`family_fixture-user_${id}`,familyId:'family_fixture-user',frontendContributionId:id,scope:'personal',text:id}))};
      }})};},
    }),
  })};
  const result=await biography.loadStoryMemories({memoryIds:ids},cloud);
  assert.deepEqual(result.map(item=>item.id),ids);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0],{_id:{ids:ids.map(id=>`family_fixture-user_${id}`)}});
});
