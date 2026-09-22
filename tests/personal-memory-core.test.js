const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExtraction, selectInsights, promptContext, suppressed, SELECTOR_VERSION } = require('../cloudfunctions/personalMemory/personalMemoryCore');
const entry = patch => ({matchLineage:null,isContradiction:false,category:'preference',text:'喜欢安静地阅读。',projectScoped:false,confidence:0.8,sensitive:false,...patch});
const parse = (insights,statementType='direct_statement',candidates=[]) => parseExtraction({statementType,insights},candidates);
test('questions, quotations, hypotheses and unknown types cannot produce personal facts',()=>{
  for(const kind of ['question','quotation','hypothesis','guess']) assert.deepEqual(parse([entry()],kind),[]);
  assert.deepEqual(parse([]),[]);
});
test('all model fields are validated without coercion or invented defaults',()=>{
  for(const patch of [{category:'diagnosis'},{confidence:'0.8'},{confidence:2},{confidence:NaN},{sensitive:'false'},{projectScoped:0},{isContradiction:null},{matchLineage:'unknown'},{text:'x'.repeat(61)}]) assert.deepEqual(parse([entry(patch)]),[],JSON.stringify(patch));
  assert.equal(parse([entry()]).length,1);
  assert.equal(parse([entry()], 'project_scoped_instruction')[0].projectScoped,true);
  assert.equal(parse([entry()], 'inferred_behavior')[0].origin,'inferred');
});
test('new, reinforcing and correcting evidence retain known lineage and source origin',()=>{
  const candidates=[{ref:'C1',lineageKey:'lineage-a'}];
  const changes=parse([entry(),entry({matchLineage:'C1'}),entry({matchLineage:'C1',isContradiction:true})],'direct_statement',candidates);
  assert.deepEqual(changes.map(item=>item.action),['new','reinforce','supersede']);
  assert.equal(changes[2].lineageKey,'lineage-a');
  assert.equal(changes[2].origin,'user_corrected');
});
const candidate = (i,patch={}) => ({lineageKey:'l'+i,category:'fact',origin:'user_stated',text:'条目'+i,projectScoped:false,confidence:0.5,updatedAt:'2026-09-22T00:00:00Z',evidenceIds:['e'+i],earliestEvidenceOn:'2026-09-01',...patch});
test('selection enforces cooldown, project exclusion, evidence, category quotas and recency',()=>{
  const selected=selectInsights([candidate(1),candidate(2,{confidence:0.9}),candidate(3),candidate(4,{category:'goal'}),candidate(5,{projectScoped:true}),candidate(6,{evidenceIds:[]}),candidate(7,{lastMentionedAt:'2026-09-21T00:00:00Z'})],Date.parse('2026-09-22T00:00:00Z'));
  assert.deepEqual(selected.map(item=>item.lineageKey),['l2','l1','l4']);
  assert.equal(SELECTOR_VERSION,'u6-v1');
  assert.deepEqual(Object.keys(promptContext(selected)[0]).sort(),['category','earliestEvidenceOn','origin','projectScoped','text']);
});
test('forget tombstones suppress lineage or banned evidence only for the same account',()=>{
  const tombstones=[{userId:'alice',lineageKey:'l1',evidenceIds:['e1'],textKey:'same'}];
  assert.equal(suppressed(tombstones,'alice','l1',['e2'],'other'),true);
  assert.equal(suppressed(tombstones,'alice','new',['e1'],'other'),true);
  assert.equal(suppressed(tombstones,'alice','new',['e2'],'same'),true);
  assert.equal(suppressed(tombstones,'bob','l1',['e1'],'same'),false);
});
