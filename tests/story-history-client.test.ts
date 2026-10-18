import test from 'node:test';
import assert from 'node:assert/strict';
import {loadStoryHistory} from '../miniprogram/services/storyBooks';

test('new history reads summaries without a full-room request and never falls back on an authorization failure',async t=>{
  const globals=globalThis as any, previousWx=globals.wx, previousApp=globals.getApp;
  t.after(()=>{globals.wx=previousWx;globals.getApp=previousApp;});
  globals.getApp=()=>({globalData:{cloudReady:true}});
  const actions:string[]=[];
  let denied=false;
  globals.wx={cloud:{callFunction:async({data}:any)=>{
    actions.push(data.action);
    if(data.action==='capabilities')return {result:{ownerHistory:true}};
    assert.equal(data.action,'history');assert.equal(data.storyId,'story-one');
    return {result:denied?{error:'denied',code:'STORY_FORBIDDEN'}:{history:[{id:'revision-one',label:'one'}]}};
  }}};
  assert.equal((await loadStoryHistory('story-one'))[0].id,'revision-one');
  assert.deepEqual(actions,['capabilities','history']);
  denied=true;actions.length=0;
  await assert.rejects(loadStoryHistory('story-one'),{code:'STORY_FORBIDDEN'});
  assert.deepEqual(actions,['capabilities','history']);
});

test('rapid history selections and closing the panel discard late detail responses',async t=>{
  const globals=globalThis as any, old={wx:globals.wx,Page:globals.Page};
  t.after(()=>Object.assign(globals,old));
  let definition:any;
  globals.Page=(page:any)=>{definition=page;};
  await import('../miniprogram/pages/book/book');
  const page={...definition,data:{...structuredClone(definition.data),panel:'history',storyId:'story-one',history:[{id:'revision-one'},{id:'revision-two'}]}};
  page.setData=(patch:any)=>Object.assign(page.data,patch);
  const releases=new Map<string,(value:any)=>void>();
  globals.wx={cloud:{callFunction:({data}:any)=>new Promise(resolve=>releases.set(data.revisionId,resolve))}};
  const first=page.previewHistory({currentTarget:{dataset:{id:'revision-one'}}});
  const second=page.previewHistory({currentTarget:{dataset:{id:'revision-two'}}});
  const result=(id:string)=>({result:{revision:{id,storyId:'story-one',draft:{paragraphs:[id]}}}});
  releases.get('revision-two')!(result('revision-two'));await second;
  releases.get('revision-one')!(result('revision-one'));await first;
  assert.equal(page.data.previewVersion.id,'revision-two');
  const third=page.previewHistory({currentTarget:{dataset:{id:'revision-one'}}});
  page.closePanel();releases.get('revision-one')!(result('revision-one'));await third;
  assert.equal(page.data.previewVersion,null);
});
