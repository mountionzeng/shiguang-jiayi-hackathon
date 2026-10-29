import test from 'node:test';
import assert from 'node:assert/strict';
type Def=Record<string,any>;
let definition:Def;
const model=()=>({bookPeople:true,familyId:'family_owner',copyAvailable:true,story:{id:'story-a',title:'测试书'},
  people:[{id:'person-a',name:'岚',relation:'朋友',isOwner:false}],availablePeople:[{id:'person-b',name:'阿远',relation:'朋友',isOwner:false}],chapters:[{id:'chapter-one',title:'第一章'},{id:'chapter-two',title:'第二章'}],invitations:[] as any[]});
async function setup(respond:(data:Def)=>any=()=>model()) {
  const calls:Def[]=[];
  (globalThis as any).wx={hideShareMenu:()=>{},cloud:{callFunction:async({data}:Def)=>{calls.push(data);return {result:await respond(data)};}}};
  if(!definition){(globalThis as any).Component=(d:Def)=>definition=d;await import('../miniprogram/components/book-people/book-people');}
  const p:Def={...definition.methods,data:structuredClone(definition.data)};p.setData=(v:Def)=>Object.assign(p.data,v);p.onLoad({storyId:'story-a'});
  return {p,calls};
}
const row={currentTarget:{dataset:{key:'person:person-a'}}};
test('book people loads focused metadata in one request, creates a member-ID invitation once and clears the token on hide',async()=>{
  const {p,calls}=await setup(data=>data.action==='inviteManage'?model():{invitationId:'i',token:'secret'});
  await p.refresh();assert.deepEqual(calls.map(c=>c.action),['inviteManage']);assert.equal(calls[0].includePeople,true);
  p.openPerson(row);p.chooseChapters({detail:{value:['chapter-two']}});p.chooseCopy({detail:{value:true}});
  await Promise.all([p.saveAccess(),p.saveAccess()]);assert.equal(calls.length,2);assert.equal(calls[1].targetMemberId,'person-a');
  assert.deepEqual(calls[1].chapterIds,['chapter-two']);assert.deepEqual(calls[1].permissions,{read:true,forward:false,edit:false,copy:true});
  assert.match(p.onShareAppMessage().path,/secret/);assert.equal(p.data.pending,true);
  p.onHide();assert.equal(p.onShareAppMessage().path,'/pages/index/index');assert.deepEqual(p.data.people,[]);
});
test('book people saves selected chapters in one explicit request, refuses empty scope, and keeps local status current',async()=>{
  const data=model();data.invitations=[{invitationId:'i',memberId:'person-a',status:'approved',chapterIds:['chapter-one'],member:{active:true,chapterIds:['chapter-one'],permissions:{read:true,copy:false,edit:false}}}];
  const {p,calls}=await setup(input=>input.action==='inviteManage'?data:{ok:true});await p.refresh();p.openPerson(row);
  p.chooseChapters({detail:{value:[]}});await p.saveAccess();assert.equal(calls.length,1);
  p.chooseChapters({detail:{value:['chapter-two']}});await p.saveAccess();assert.equal(calls.length,2);
  assert.deepEqual(calls[1].chapterIds,['chapter-two']);assert.equal(calls[1].action,'inviteSetAccess');assert.match(p.data.notice,/已保存/);
  p.back();p.openPerson(row);assert.equal(p.data.chapters[1].checked,true);
});
test('person editing handles conflicts without a full-room reload or changed permissions',async()=>{
  let conflict=true;const {p,calls}=await setup(data=>data.action==='inviteManage'?model():conflict?{error:'error',message:'名单里已经有这个名字'}:{ok:true});
  await p.refresh();p.openPerson(row);p.editPerson();p.enterName({detail:{value:'新称呼'}});
  await p.savePerson();assert.match(p.data.notice,/已经有/);assert.equal(p.data.editing,true);
  conflict=false;await p.savePerson();assert.deepEqual(calls.map(c=>c.action),['inviteManage','memberUpdate','memberUpdate']);
  assert.equal(p.data.people[0].name,'新称呼');assert.equal(p.data.editing,false);
});
test('late reads/writes cannot repopulate a hidden people page or leak an invitation token',async()=>{
  let finish:(value:any)=>void=()=>{};
  const {p}=await setup(()=>new Promise(resolve=>finish=resolve));const reading=p.refresh();p.onHide();finish(model());await reading;
  assert.deepEqual(p.data.people,[]);assert.equal(p.data.ready,false);
  p.data.hidden=false;p.data.model=model();p.data.familyId='family_owner';p.setData({ready:true,people:[{key:'person:person-a',memberId:'person-a',name:'岚'}]});p.openPerson(row);
  p.chooseChapters({detail:{value:['chapter-one']}});const writing=p.saveAccess();p.onHide();finish({invitationId:'i',token:'late-secret'});await writing;
  assert.equal(p.data.shareReady,false);assert.equal(p.data.shareToken,'');
});
test('denied or old cloud data never enables people permissions; failed invitation is not automatically retried',async()=>{
  const {p,calls}=await setup(()=>({story:{id:'story-a',title:'旧版'},chapters:[],invitations:[]}));
  await p.refresh();assert.equal(p.data.ready,false);assert.match(p.data.notice,/更新云端/);p.addPerson();await p.saveAccess();assert.equal(calls.length,1);
  const failed=await setup(data=>data.action==='inviteManage'?model():Promise.reject(new Error('网络断开')));
  await failed.p.refresh();failed.p.openPerson(row);failed.p.chooseChapters({detail:{value:['chapter-one']}});await failed.p.saveAccess();
  assert.equal(failed.calls.length,2);assert.equal(failed.p.data.shareReady,false);assert.match(failed.p.data.notice,/刷新核对/);
});
test('a person from another book is selected by ID and only added to this book after the invitation receipt',async()=>{
  const {p,calls}=await setup(data=>data.action==='inviteManage'?model():{invitationId:'i',token:'secret'});
  await p.refresh();p.addPerson();p.chooseExisting({detail:{value:'0'}});
  assert.equal(p.data.memberId,'person-b');assert.equal(p.data.people.length,1);
  p.chooseChapters({detail:{value:['chapter-one']}});await p.saveAccess();
  assert.equal(calls[1].targetMemberId,'person-b');assert.equal(p.data.people.length,2);
});
test('editing a selected existing person refreshes the invitation label without changing their identity',async()=>{
  const {p,calls}=await setup(data=>data.action==='inviteManage'?model():data.action==='memberUpdate'?{ok:true}:{invitationId:'i',token:'secret'});
  await p.refresh();p.addPerson();p.chooseExisting({detail:{value:'0'}});p.editPerson();p.enterName({detail:{value:'远叔'}});await p.savePerson();
  p.chooseChapters({detail:{value:['chapter-two']}});await p.saveAccess();
  assert.equal(calls[2].targetMemberId,'person-b');assert.equal(p.data.people.find((person:Def)=>person.memberId==='person-b').name,'远叔');
});
test('an inactive approved invitation must be revoked before creating another and never silently restores access',async()=>{
  const data=model();data.invitations=[{invitationId:'i',memberId:'person-a',status:'approved',chapterIds:['chapter-one'],member:{active:false,chapterIds:[],permissions:{read:false}}}];
  const {p,calls}=await setup(()=>data);await p.refresh();p.openPerson(row);assert.equal(p.data.inactive,true);
  p.chooseChapters({detail:{value:['chapter-two']}});await p.saveAccess();assert.equal(calls.length,1);
});
