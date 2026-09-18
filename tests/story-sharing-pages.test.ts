import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
type Definition = Record<string, any>;
let invite:Definition, read:Definition, receive:Definition;
async function capture(path:string) { let definition:Definition|undefined;const prior=(globalThis as any).Page;(globalThis as any).Page=(d:Definition)=>definition=d;try{await import(path);}finally{(globalThis as any).Page=prior;}assert.ok(definition);return definition; }
function instance(d:Definition):Definition {const p:Definition={...d,data:structuredClone(d.data)};p.setData=(v:Definition)=>Object.assign(p.data,v);return p;}
test('sharing uses a dedicated subpackage',()=>{
  const app=JSON.parse(readFileSync('miniprogram/app.json','utf8'));
  assert.deepEqual(app.subPackages.find((p:any)=>p.root==='packages/story-sharing')?.pages,['pages/invite/index','pages/read/index','pages/receive/index','pages/card/index']);
});
test('protected received stories use append-only own text instead of the legacy manuscript save',()=>{
  const page=readFileSync('miniprogram/pages/book/book.ts','utf8'),view=readFileSync('miniprogram/pages/book/book.wxml','utf8');
  assert.match(page,/storyCopies\.appendOwn\(/);assert.match(page,/if \(this\.data\.protectedCopy\).*不能整篇改写/);
  assert.match(view,/read-only="\{\{protectedCopy \|\|/);assert.match(view,/panel === 'append-own'/);
  assert.match(view,/亲友分享的原文和图片不会被改写/);
});
test('receive page sends references and target metadata, never displayed manuscript text',async()=>{
  const prior=(globalThis as any).wx,calls:any[]=[];
  (globalThis as any).wx={cloud:{callFunction:async({data}:any)=>{calls.push(data);if(data.action==='sharedRead')return {result:{story:{id:'story-a',title:'夏天',version:3},revisionId:'revision-a',draftScope:'scope',capabilities:{copy:true},chapters:[{id:'chapter-three',title:'第三章',content:[{text:'不应回传的正文'}],textBlocks:[{index:0,text:'不应回传的正文'}]}]}};if(data.action==='state')return {result:{stories:[]}};return {result:{ok:true,storyId:'story-copy',revisionId:'revision-copy',alreadyReceived:false}};}},redirectTo:()=>{},
    getStorageSync:()=>'',setStorageSync:()=>{},hideShareMenu:()=>{}};
  try{receive=await capture('../miniprogram/packages/story-sharing/pages/receive/index');const p=instance(receive);p.onLoad({familyId:'family_owner',storyId:'story-a'});p.hidden=false;await p.refresh();assert.equal(p.data.available,true);await p.receive();
    const sent=calls.find(call=>call.action==='copyReceive');assert.deepEqual(sent.chapterIds,['chapter-three']);assert.equal(sent.sourceRevisionId,'revision-a');assert.equal(JSON.stringify(sent).includes('不应回传的正文'),false);}
  finally{(globalThis as any).wx=prior;}
});
test('disabled invitation page exposes no locally generated sharing or content',async()=>{
  const prior=(globalThis as any).wx;
  (globalThis as any).wx={cloud:{callFunction:async()=>({result:{invitations:false}})},hideShareMenu:()=>{}};
  try {invite=await capture('../miniprogram/packages/story-sharing/pages/invite/index');const p=instance(invite);p.onLoad({storyId:'story-a'});await p.refresh();assert.equal(p.data.available,false);assert.equal(p.data.invitations.length,0);assert.equal(p.onShareAppMessage().path,'/pages/index/index');}
  finally {(globalThis as any).wx=prior;}
});
test('reader clears manuscript immediately on hide and ignores a late successful response',async()=>{
  const prior=(globalThis as any).wx;let resolve:((r:any)=>void)|undefined;
  (globalThis as any).wx={cloud:{callFunction:()=>new Promise(r=>resolve=r)},hideShareMenu:()=>{}};
  try {read=await capture('../miniprogram/packages/story-sharing/pages/read/index');const p=instance(read);p.onLoad({familyId:'family_owner',storyId:'story-a'});p.hidden=false;const request=p.refresh();p.onHide();resolve?.({result:{story:{title:'secret'},chapters:[{id:'chapter-one',title:'secret',content:[{text:'secret'}]}]}});await request;assert.deepEqual(p.data.chapters,[]);assert.equal(p.data.title,'');assert.equal(JSON.stringify(p.onShareAppMessage()).includes('secret'),false);}
  finally {(globalThis as any).wx=prior;}
});
test('reader denial removes previous text and shows a recoverable error',async()=>{
  const prior=(globalThis as any).wx;(globalThis as any).wx={cloud:{callFunction:async()=>({result:{error:'STORY_BOOK_ERROR',code:'STORY_FORBIDDEN',message:'不可访问'}})},hideShareMenu:()=>{}};
  try {const p=instance(read);p.onLoad({familyId:'family_owner',storyId:'story-a'});p.data.chapters=[{content:[{text:'previous'}]}];await p.refresh();assert.deepEqual(p.data.chapters,[]);assert.match(p.data.notice,/不可访问/);}
  finally {(globalThis as any).wx=prior;}
});
test('shared editor keeps an uncertain save under the server-provided account scope and retries the same request',async()=>{
  const prior=(globalThis as any).wx;const stored=new Map<string,unknown>(),calls:any[]=[];
  (globalThis as any).wx={cloud:{callFunction:async({data}:any)=>{calls.push(data);return {result:{error:'STORY_BOOK_ERROR',code:'VERSION_CONFLICT',message:'暂时无法确认'}};}},
    hideShareMenu:()=>{},getStorageSync:(key:string)=>stored.get(key),setStorageSync:(key:string,value:unknown)=>stored.set(key,structuredClone(value)),removeStorageSync:(key:string)=>stored.delete(key)};
  try {const p=instance(read);p.onLoad({familyId:'family_owner',storyId:'story-a'});p.hidden=false;p.draftScope='scope-editor-a';p.revisionId='revision-a';p.version=3;p.data.canEdit=true;
    p.data.chapters=[{id:'chapter-three',title:'第三章',content:[{text:'原文'}],textBlocks:[{index:0,text:'原文'}]}];
    p.beginEdit({currentTarget:{dataset:{id:'chapter-three'}}});p.editBlock({currentTarget:{dataset:{index:0}},detail:{value:'没保存的修改'}});
    const key='story-shared-draft:scope-editor-a:chapter-three';assert.equal((stored.get(key) as any).textBlocks[0].text,'没保存的修改');
    await p.saveEdit();const requestId=calls[0].requestId;await p.saveEdit();assert.equal(calls[1].requestId,requestId);assert.match(p.data.notice,/保留在本机/);
    p.draftScope='scope-editor-b';p.data.editChapterId='';p.beginEdit({currentTarget:{dataset:{id:'chapter-three'}}});assert.equal(p.data.editBlocks[0].text,'原文');
  } finally {(globalThis as any).wx=prior;}
});
test('owner creates a scoped invite once and sharing never uses a manuscript screenshot',async()=>{
  const prior=(globalThis as any).wx;const calls:any[]=[];let resolve:((r:any)=>void)|undefined;
  (globalThis as any).wx={cloud:{callFunction:({data}:any)=>{calls.push(data);return new Promise(r=>resolve=r);}},hideShareMenu:()=>{}};
  try {const p=instance(invite);p.onLoad({storyId:'story-a'});p.familyId='family_owner';p.data.available=true;p.data.title='私密题名';p.data.chapters=[{id:'chapter-three',title:'私密章',checked:true},{id:'chapter-one',checked:false}];const one=p.create(),two=p.create();assert.equal(calls.length,1);assert.deepEqual(calls[0].chapterIds,['chapter-three']);resolve?.({result:{token:'a'.repeat(48),invitationId:'b'.repeat(64)}});await Promise.all([one,two]);const message=p.onShareAppMessage();assert.equal(message.imageUrl,'/assets/illustrations/story-book-cover.png');assert.equal(JSON.stringify(message).includes('私密'),false);p.onHide();assert.equal(p.onShareAppMessage().path,'/pages/index/index');}
  finally{(globalThis as any).wx=prior;}
});
test('wrong applicant verification code cannot send an approval request',async()=>{
  const prior=(globalThis as any).wx;let calls=0;
  (globalThis as any).wx={cloud:{callFunction:async()=>{calls++;}},showModal:({success}:any)=>success({confirm:true,content:'wrong'}),hideShareMenu:()=>{}};
  try{const p=instance(invite);p.onLoad({storyId:'story-a'});p.data.available=true;p.data.invitations=[{invitationId:'invite-a',applicants:[{applicantId:'person-a',verificationCode:'12345678'}]}];await p.decide({currentTarget:{dataset:{invitationId:'invite-a',applicantId:'person-a',decision:'approve'}}});assert.equal(calls,0);assert.match(p.data.notice,/不一致/);assert.equal(p.data.busy,false);}
  finally{(globalThis as any).wx=prior;}
});
