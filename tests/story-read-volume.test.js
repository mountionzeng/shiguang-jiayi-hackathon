const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/story-access-fixture');
const {readFamilyDocuments}=require('../cloudfunctions/storyBooks/repository');
const {createHandlers}=require('../cloudfunctions/storyBooks/flow');
const {readHistory}=require('../cloudfunctions/storyBooks/history');

// Model the SDK's filtering, projection and 100-document page limit. Measure
// database response rows/bytes, not elapsed network time or production latency.
function measuredReads(f) {
  const reads=[];
  const db={collection(table) {
    let filter,fields,offset=0,limit=100;
    const query={
      where(value){filter=value;return query},
      orderBy(field,direction){assert.equal(field,'_id');assert.equal(direction,'asc');return query},
      skip(value){offset=value;return query},
      limit(value){limit=value;return query},
      field(value){fields=value;return query},
      async get(){
        const selected=[...f.tables].filter(([key,row])=>key.startsWith(table+':') &&
          Object.entries(filter).every(([field,value])=>row[field]===value))
          .map(([key,row])=>({_id:key.slice(table.length+1),...row}))
          .sort((a,b)=>a._id.localeCompare(b._id)).slice(offset,offset+limit);
        const data=selected.map(row=>{
          if(!fields)return structuredClone(row);
          if(Object.values(fields).every(value=>value===false)) {
            const projected=structuredClone(row);
            for(const key of Object.keys(fields))delete projected[key];
            return projected;
          }
          const projected={_id:row._id};
          for(const key of Object.keys(fields)) {
            const path=key.split('.');
            const value=path.reduce((current,part)=>current?.[part],row);
            if(value===undefined)continue;
            let target=projected;
            for(const part of path.slice(0,-1))target=target[part]??={};
            target[path.at(-1)]=structuredClone(value);
          }
          return projected;
        });
        reads.push({table,filter,fields,rows:data.length,bytes:Buffer.byteLength(JSON.stringify(data))});
        return {data};
      },
    };
    return query;
  }};
  f.repo.all=(...args)=>readFamilyDocuments(db,...args);
  const totals=table=>reads.filter(read=>read.table===table).reduce((sum,read)=>({
    pages:sum.pages+1,rows:sum.rows+read.rows,bytes:sum.bytes+read.bytes,
  }),{pages:0,rows:0,bytes:0});
  return {reads,totals};
}

test('home database reads stay small as memory revision history grows, with archives retained',async t=>{
  const f=fixture();f.account('owner');
  for(let index=0;index<120;index++)f.tables.set('memories:memory-'+index,{
    familyId:'family_owner',id:'memory-'+index,text:'虚构当前记忆',photoIds:['photo-'+index],
    aiRevisions:Array.from({length:10},(_,revision)=>({id:revision,text:'虚构旧稿'.repeat(100)})),
  });
  const stored=structuredClone(f.tables),m=measuredReads(f);
  await f.repo.all('memories','family_owner');
  const before=m.totals('memories');m.reads.length=0;
  const home=await createHandlers(f.repo).state({familyId:'family_owner'},{view:'home'});
  const after=m.totals('memories');
  assert.equal(home.contributions.length,120);
  assert.ok(home.contributions.every(memory=>memory.text==='虚构当前记忆' && memory.photoIds.length===1 && !memory.aiRevisions));
  assert.ok(after.bytes<before.bytes/20);
  assert.equal(after.rows,before.rows);
  assert.deepEqual(f.tables,stored);
  const editor=await createHandlers(f.repo).state({familyId:'family_owner'},{view:'memories'});
  assert.equal(editor.contributions[0].aiRevisions.length,10);
  t.diagnostic('synthetic memory DB bytes: '+JSON.stringify({before,after}));
});

test('one-story history pages are independent of the number of other stories',async t=>{
  const f=fixture();f.account('owner');
  f.tables.set('stories:family_owner_story-0',{familyId:'family_owner',id:'story-0'});
  for(let story=0;story<30;story++)for(let revision=0;revision<15;revision++) {
    const id='revision-'+story+'-'+revision,storyId='story-'+story;
    f.tables.set('biography_drafts:family_owner_'+id,{familyId:'family_owner',storyId,
      revision:{id,storyId,kind:'version',label:'虚构历史',savedAt:String(revision).padStart(2,'0'),draft:{paragraphs:['保留旧稿']}}});
  }
  const m=measuredReads(f);
  const history=await readHistory(f.repo,{familyId:'family_owner'},{action:'history',storyId:'story-0'});
  const after=m.totals('biography_drafts'),fields=m.reads[0].fields;
  m.reads.length=0;
  await f.repo.all('biography_drafts','family_owner',fields);
  const before=m.totals('biography_drafts');
  assert.equal(before.rows,450);assert.equal(after.rows,15);
  assert.equal(before.pages,5);assert.equal(after.pages,1);
  assert.equal(history.history.length,15);
  assert.ok(history.history.every(revision=>revision.storyId==='story-0' && !revision.draft));
  assert.equal(history.history[0].id,'revision-0-14');
  assert.equal(f.tables.size,453,'all documents remain stored');
  t.diagnostic('synthetic history DB reads: '+JSON.stringify({before,after}));
});

test('filtered pagination retains every revision and cannot override authorized family scope',async()=>{
  const f=fixture();f.account('owner');
  for(let index=0;index<205;index++)f.tables.set('biography_drafts:own-'+index,{
    familyId:'family_owner',storyId:'story-a',revision:{id:'revision-'+index},
  });
  f.tables.set('biography_drafts:foreign',{familyId:'family_other',storyId:'story-a'});
  const m=measuredReads(f);
  const rows=await f.repo.all('biography_drafts','family_owner',undefined,{storyId:'story-a',familyId:'family_other'});
  assert.equal(rows.length,205);
  assert.equal(new Set(rows.map(row=>row._id)).size,205);
  assert.ok(rows.every(row=>row.familyId==='family_owner'));
  assert.equal(m.reads.length,3);
});
