const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { createHandlers } = require('../cloudfunctions/storyBooks/flow');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const { aliasIdFor } = require('../cloudfunctions/storyBooks/identity');

function homeFixture() {
  const f = fixture(); f.account('owner');
  const story = { id:'story-a',familyId:'family_owner',title:'测试书',memoryIds:['m'],currentRevisionId:'r-current' };
  f.tables.set('stories:family_owner_story-a', story);
  f.tables.set('stories:family_owner_deleted', {...story,id:'deleted',deletedAt:'today',currentRevisionId:'r-deleted'});
  for (const id of ['r-current', 'r-old', 'r-deleted']) {
    f.tables.set(`biography_drafts:family_owner_${id}`, {familyId:'family_owner',storyId:'story-a',draftType:'story-revision',
      revision:{id,storyId:'story-a',draft:{title:'测试书',paragraphs:[id.repeat(1000)],chapters:[{id:'ch',title:'第一章',content:[]}]}}});
  }
  f.tables.set('memories:m', {familyId:'family_owner',id:'m',scope:'personal',text:'原话',aiRevisions:[{text:'旧文字'.repeat(1000)}]});
  f.tables.set('memories:deleted', {familyId:'family_owner',id:'deleted',text:'已删除',deletedAt:'today'});
  return f;
}

test('home reads current revisions only and preserves current text, counts and cover metadata', async () => {
  const {repo,tables}=homeFixture();
  const full=await createHandlers(repo).state({familyId:'family_owner'});
  const reads=[]; const all=repo.all; const get=repo.get;
  repo.all=async (table,id)=>{reads.push(['all',table]);return all(table,id)};
  repo.get=async (table,id)=>{reads.push(['get',table,id]);return get(table,id)};
  const home=await createHandlers(repo).state({familyId:'family_owner'},{view:'home'});
  assert.deepEqual(home.manuscriptRevisions,full.manuscriptRevisions.filter(r=>r.id==='r-current'));
  assert.deepEqual(home.stories,full.stories.filter(s=>!s.deletedAt));
  assert.equal(home.contributions.length,1);
  assert.equal(home.contributions[0].text,'原话');
  assert.equal(home.contributions[0].aiRevisions,undefined);
  assert.ok(!reads.some(([op,table])=>op==='all' && ['biography_drafts','story_migration_items'].includes(table)));
  assert.equal(reads.filter(([op,table])=>op==='get' && table==='biography_drafts').length,1);
  assert.ok(JSON.stringify(home).length < JSON.stringify(full).length/2);
  assert.equal(tables.get('biography_drafts:family_owner_r-old').revision.id,'r-old','history is retained in storage');
});

test('home cannot load cross-family, mismatched or missing current revisions', async () => {
  for (const patch of [{familyId:'family_other'},{storyId:'another'},{revision:{id:'other',storyId:'story-a'}},undefined]) {
    const {repo,tables}=homeFixture();
    const key='biography_drafts:family_owner_r-current';
    if(patch)tables.set(key,{...tables.get(key),...patch});else tables.delete(key);
    const home=await createHandlers(repo).state({familyId:'family_owner'},{view:'home'});
    assert.deepEqual(home.manuscriptRevisions,[]);
    assert.equal(home.stories[0].currentRevisionId,'');
    assert.equal(home.stories[0].orphanedRevisionId,'r-current');
  }
});

test('legacy homes retain the complete legacy shape until migration is active', async () => {
  const {repo,tables}=homeFixture();delete tables.get('families:family_owner').storyBooks;
  assert.deepEqual(await createHandlers(repo).state({familyId:'family_owner'},{view:'home'}),await createHandlers(repo).state({familyId:'family_owner'}));
});

test('home retains owner authorization and rejects revocation during the read', async () => {
  const {repo,tables}=homeFixture();const context={APPID:'wx-original',OPENID:'owner'};
  const options={accessEnabled:true,rulesReady:true,bootstrapAppId:context.APPID};
  const service=createStoryService(repo,options);
  const home=await service(context,{action:'state',view:'home',familyId:'family_other'});
  assert.equal(home.manuscriptRevisions.length,1);
  const all=repo.all;
  repo.all=async (table,id)=>{const result=await all(table,id);tables.get(`story_identity_aliases:${aliasIdFor(context.APPID,context.OPENID)}`).status='revoked';return result};
  await assert.rejects(service(context,{action:'state',view:'home'}),{code:'STORY_FORBIDDEN'});
});


test('memory editor projection retains full history and media without scanning manuscript history', async () => {
  const {repo,tables}=homeFixture();
  tables.get('memories:m').photoIds=['photo-keep'];
  const full=await createHandlers(repo).state({familyId:'family_owner'});
  const reads=[]; const all=repo.all;
  repo.all=async (table,id)=>{reads.push(table);return all(table,id)};
  const editor=await createHandlers(repo).state({familyId:'family_owner'},{view:'memories'});
  assert.deepEqual(editor.contributions,full.contributions.filter(m=>!m.deletedAt));
  assert.equal(editor.manuscriptRevisions.length,1);
  assert.ok(!reads.includes('biography_drafts'));
  assert.ok(!reads.includes('story_migration_items'));
});

test('home excludes memory history in the database query, while the memory editor still reads it', async () => {
  const {repo}=homeFixture();
  const reads=[]; const all=repo.all;
  repo.all=async (table,id,fields)=>{reads.push({table,fields});return all(table,id)};
  await createHandlers(repo).state({familyId:'family_owner'},{view:'home'});
  assert.deepEqual(reads.find(r=>r.table==='memories').fields,{aiRevisions:false});
  reads.length=0;
  await createHandlers(repo).state({familyId:'family_owner'},{view:'memories'});
  assert.equal(reads.find(r=>r.table==='memories').fields,undefined);
});

test('memory selection reads current sources without reading any stories or manuscripts, including legacy rooms', async () => {
  for (const legacy of [false,true]) {
    const {repo,tables}=homeFixture();
    if(legacy)delete tables.get('families:family_owner').storyBooks;
    tables.get('memories:m').photoIds=['photo-keep'];
    const reads=[];const all=repo.all,get=repo.get;
    repo.all=async (...args)=>{reads.push(args[0]);return all(...args)};
    repo.get=async (...args)=>{reads.push(args[0]);return get(...args)};
    const state=await createHandlers(repo).state({familyId:'family_owner'},{view:'memory-sources'});
    assert.deepEqual(reads.sort(),['families','family_members','memories']);
    assert.equal(state.contributions.length,1);
    assert.equal(state.contributions[0].text,'原话');
    assert.deepEqual(state.contributions[0].photoIds,['photo-keep']);
    assert.equal(state.contributions[0].aiRevisions,undefined);
    assert.deepEqual(state.stories,[]);
    assert.deepEqual(state.manuscriptRevisions,[]);
  }
});

test('memory source projection still rejects revocation and failed reads instead of returning an empty library', async () => {
  const {repo,tables}=homeFixture();
  const context={APPID:'wx-original',OPENID:'owner'};
  const service=createStoryService(repo,{accessEnabled:true,rulesReady:true,bootstrapAppId:context.APPID});
  await service(context,{action:'state',view:'memory-sources'});
  const all=repo.all;
  repo.all=async (...args)=>{
    const rows=await all(...args);
    tables.get(`story_identity_aliases:${aliasIdFor(context.APPID,context.OPENID)}`).status='revoked';
    return rows;
  };
  await assert.rejects(service(context,{action:'state',view:'memory-sources'}),{code:'STORY_FORBIDDEN'});
  const failure=new Error('memory database unavailable');
  repo.all=async ()=>{throw failure};
  await assert.rejects(createHandlers(repo).state({familyId:'family_owner'},{view:'memory-sources'}),error=>error===failure);
});
