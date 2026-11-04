import test from 'node:test';
import assert from 'node:assert/strict';
import {WritingSession, type WritingSnapshot} from '../miniprogram/services/writingSession';
const snapshot=(text='原话'):WritingSnapshot=>({messages:[{id:'msg-1',kind:'answer',text,label:''}],answers:[text],askedDimensions:[],inputText:'还未发送',draftTitle:'标题',draftText:'成稿',draftSummary:'',draftOrganizationMode:'cloud-ai',outputMemoryId:'',saved:false});
function fixture(context:any) {
  const old=(globalThis as any).wx,storage=new Map<string,any>();let remote:any={memoryId:'root',revision:0,mutationId:'',snapshot:null},fail=false,loseAck=false;
  const requests:any[]=[];
  (globalThis as any).wx={getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:any)=>storage.set(key,structuredClone(value)),removeStorageSync:(key:string)=>storage.delete(key),cloud:{callFunction:async({name,data}:any)=>{
    if(name==='getOpenId')return {result:{openid:'session-service',account:{primaryFamilyId:'family_session'}}};
    requests.push(data);if(fail)throw new Error('offline');
    if(data.operation==='get')return {result:structuredClone(remote)};
    if(data.mutationId===remote.mutationId)return {result:remote};
    assert.equal(data.revision,remote.revision);remote={memoryId:'root',revision:remote.revision+1,mutationId:data.mutationId,snapshot:structuredClone(data.snapshot)};
    if(loseAck){loseAck=false;throw new Error('response lost');}return {result:remote};
  }}};
  context.after(()=>{(globalThis as any).wx=old;});
  return {storage,requests,remote:()=>remote,setRemote:(value:any)=>{remote=value;},offline:(value:boolean)=>{fail=value;},loseAck:()=>{loseAck=true;}};
}
test('session serializes saves, restores assistant turns and only removes acknowledged backup',async context=>{
  const f=fixture(context),notices:string[]=[];const {session}=await WritingSession.open('root',text=>notices.push(text));
  const first=session.save(snapshot('第一句')),second=session.save(snapshot('第二句'));await Promise.all([first,second]);
  assert.equal(f.remote().revision,2);assert.equal(f.storage.size,0);assert.equal(f.remote().snapshot.messages[0].text,'第二句');
  const reopened=await WritingSession.open('root',()=>{});assert.deepEqual(reopened.snapshot,snapshot('第二句'));assert.match(notices[notices.length-1],/已保存/);
});
test('failed session save keeps local text and retry confirms a lost acknowledgement without duplicating a revision',async context=>{
  const f=fixture(context);const {session}=await WritingSession.open('root',()=>{});f.loseAck();await session.save(snapshot());
  assert.equal(session.canWrite,false);assert.equal(f.storage.size,1);assert.equal(f.remote().revision,1);
  await session.retry();assert.equal(session.canWrite,true);assert.equal(f.storage.size,0);assert.equal(f.remote().revision,1);
});
test('offline save restores local pending draft after restart and syncs it when network returns',async context=>{
  const f=fixture(context);const {session}=await WritingSession.open('root',()=>{});f.offline(true);await session.save(snapshot('保留我'));assert.equal(f.storage.size,1);
  f.offline(false);const restored=await WritingSession.open('root',()=>{});assert.equal(restored.snapshot?.answers[0],'保留我');await restored.session.flush();
  assert.equal(f.remote().snapshot.answers[0],'保留我');assert.equal(f.storage.size,0);
});
test('cross-device conflict keeps both cloud and local drafts without silently overwriting either',async context=>{
  const f=fixture(context);const {session}=await WritingSession.open('root',()=>{});f.offline(true);await session.save(snapshot('本机'));f.offline(false);
  f.setRemote({memoryId:'root',revision:2,mutationId:'another-device',snapshot:snapshot('另一台')});
  const restored=await WritingSession.open('root',()=>{});assert.equal(restored.session.canWrite,false);assert.equal(restored.snapshot?.answers[0],'本机');
  await assert.rejects(restored.session.retry(),/另一处已更新/);assert.equal(f.remote().snapshot.answers[0],'另一台');assert.equal(f.storage.size,1);
});
test('input checkpoint saves a local copy immediately and flushes before leaving',async context=>{
  const f=fixture(context);const {session}=await WritingSession.open('root',()=>{});session.checkpoint(snapshot('未发出的输入'));assert.equal(f.storage.size,1);
  await session.flush();assert.equal(f.remote().snapshot.answers[0],'未发出的输入');assert.equal(f.storage.size,0);
});
