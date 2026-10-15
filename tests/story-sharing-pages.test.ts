import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
type Definition = Record<string, any>;
let invite:Definition, read:Definition, receive:Definition;
async function capture(path:string) { let definition:Definition|undefined;const prior=(globalThis as any).Page;(globalThis as any).Page=(d:Definition)=>definition=d;try{await import(path);}finally{(globalThis as any).Page=prior;}assert.ok(definition);return definition; }
function instance(d:Definition):Definition {const p:Definition={...d,data:structuredClone(d.data)};p.setData=(v:Definition)=>Object.assign(p.data,v);return p;}
test('sharing uses a dedicated subpackage',()=>{
  const app=JSON.parse(readFileSync('miniprogram/app.json','utf8'));
  assert.deepEqual(app.subPackages.find((p:any)=>p.root==='packages/story-sharing')?.pages,['pages/invite/index','pages/read/index','pages/receive/index','pages/card/index','pages/social/index']);
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
  try {const p=instance(invite);p.onLoad({storyId:'story-a'});p.familyId='family_owner';p.data.available=true;p.data.title='私密题名';p.data.inviteeName='小岚';p.data.chapters=[{id:'chapter-three',title:'私密章',checked:true},{id:'chapter-one',checked:false}];const one=p.create(),two=p.create();assert.equal(calls.length,1);assert.deepEqual(calls[0].chapterIds,['chapter-three']);resolve?.({result:{token:'a'.repeat(48),invitationId:'b'.repeat(64)}});await Promise.all([one,two]);const message=p.onShareAppMessage();assert.equal(message.imageUrl,'/assets/illustrations/story-book-cover.png');assert.equal(JSON.stringify(message).includes('私密'),false);p.onHide();assert.equal(p.onShareAppMessage().path,'/pages/index/index');}
  finally{(globalThis as any).wx=prior;}
});

test('creating an invite requires a name for the family member and sends it to the server',async()=>{
  const prior=(globalThis as any).wx;const calls:any[]=[];
  (globalThis as any).wx={cloud:{callFunction:async({data}:any)=>{calls.push(data);return {result:{token:'t'.repeat(48),invitationId:'i'.repeat(64)}};}},hideShareMenu:()=>{}};
  try{const p=instance(invite);p.onLoad({storyId:'story-a'});p.familyId='family_owner';p.data.available=true;p.data.chapters=[{id:'chapter-three',title:'章',checked:true}];
    await p.create();assert.equal(calls.length,0,'no name, no cloud call');assert.match(String(p.data.notice),/称呼/);
    p.data.inviteeName='小岚';await p.create();assert.equal(calls[0].inviteeName,'小岚');}
  finally{(globalThis as any).wx=prior;}
});
test('a friend joins with one tap and lands on the shared chapters, no name form and no code',async()=>{
  const prior=(globalThis as any).wx;const calls:any[]=[];const navigations:string[]=[];
  (globalThis as any).wx={cloud:{callFunction:async({data}:any)=>{calls.push(data);
    return {result:data.action==='inviteGet'?{status:'unrequested',expiresAtMs:1,inviteeName:'小岚'}:{status:'approved',expiresAtMs:1,familyId:'family_owner',storyId:'story-a',displayName:'小岚'}};}},
    redirectTo:({url}:any)=>navigations.push(url),hideShareMenu:()=>{}};
  try{const p=instance(invite);p.onLoad({token:'a'.repeat(48)});p.hidden=false;await p.refresh();
    assert.equal(p.data.status.inviteeName,'小岚');assert.deepEqual(calls.map(c=>c.action),['inviteGet'],'recipient side never needs the owner capability call');
    await p.accept();assert.deepEqual(calls.map(c=>c.action),['inviteGet','inviteAccept']);
    assert.equal(navigations[0],'/packages/story-sharing/pages/read/index?familyId=family_owner&storyId=story-a');
    assert.equal(JSON.stringify(calls).includes('displayName'),false,'the friend never types a name');}
  finally{(globalThis as any).wx=prior;}
});

test('owner changes a family member access with the full target state, and keeps at least one chapter',async()=>{
  const prior=(globalThis as any).wx;const calls:any[]=[];
  (globalThis as any).wx={cloud:{callFunction:async({data}:any)=>{calls.push(data);return {result:{ok:true}};}},hideShareMenu:()=>{}};
  try{const p=instance(invite);p.onLoad({storyId:'story-a'});p.familyId='family_owner';p.hidden=false;p.data.available=true;p.refresh=async()=>{};
    p.data.invitations=[{invitationId:'invite-a',member:{name:'小岚',active:true,chapterIds:['chapter-one','chapter-three'],permissions:{read:true,edit:false,copy:true}}}];
    await p.changeAccess({currentTarget:{dataset:{invitationId:'invite-a',field:'edit'}},detail:{value:true}});
    assert.deepEqual(calls[0].permissions,{read:true,edit:true,copy:true});assert.equal(calls[0].chapterIds.length,2);
    await p.changeAccess({currentTarget:{dataset:{invitationId:'invite-a',field:'chapter',chapterId:'chapter-one'}}});
    assert.deepEqual(calls[1].chapterIds,['chapter-three']);
    p.data.invitations=[{invitationId:'invite-a',member:{name:'小岚',active:true,chapterIds:['chapter-three'],permissions:{read:true,edit:false,copy:true}}}];
    await p.changeAccess({currentTarget:{dataset:{invitationId:'invite-a',field:'chapter',chapterId:'chapter-three'}}});
    assert.equal(calls.length,2,'removing the last chapter never reaches the server');assert.match(String(p.data.notice),/至少要留一个章节/);}
  finally{(globalThis as any).wx=prior;}
});

test('the owner can pick or type a relation, leaving it empty sends none, and a duplicate person is reported as is',async()=>{
  const prior=(globalThis as any).wx;const calls:any[]=[];let exists=false;
  (globalThis as any).wx={cloud:{callFunction:async({data}:any)=>{calls.push(data);
    return exists?{result:{error:'STORY_BOOK_ERROR',code:'STORY_INVITEE_EXISTS',message:'这个人已经存在，不需要再邀请一次'}}:{result:{token:'t'.repeat(48),invitationId:'i'.repeat(64)}};}},hideShareMenu:()=>{}};
  try{const p=instance(invite);p.onLoad({storyId:'story-a'});p.familyId='family_owner';p.data.available=true;p.data.inviteeName='小岚';p.data.chapters=[{id:'chapter-three',title:'章',checked:true}];
    await p.create();assert.equal(calls[0].relation,undefined,'no relation chosen, the server defaults to 家人');
    p.chooseRelation({currentTarget:{dataset:{value:'朋友'}}});assert.equal(p.data.relation,'朋友');
    p.chooseRelation({currentTarget:{dataset:{value:'朋友'}}});assert.equal(p.data.relation,'','tapping again clears it');
    p.chooseRelation({currentTarget:{dataset:{value:'朋友'}}});await p.create();assert.equal(calls[1].relation,'朋友');
    exists=true;await p.create();assert.match(String(p.data.notice),/已经存在/);assert.equal(p.data.shareReady,false);}
  finally{(globalThis as any).wx=prior;}
});
