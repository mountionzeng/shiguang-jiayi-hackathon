import test from 'node:test';
import assert from 'node:assert/strict';
import { storyCommand } from '../miniprogram/services/storyBooks';
import { SavedRefreshError } from '../miniprogram/services/serviceFailure';
const { createHandlers } = require('../cloudfunctions/storyBooks/flow');

// Real cloud command/state handlers with an in-memory persistence adapter.
// Only the WeChat transport is substituted; idempotency and domain logic are real.
function install(t: test.TestContext) {
  const tables = new Map<string, any>([['families:family_test', {storyBooks:{status:'active',pending:[]}}]]);
  const io = {
    get: async (table: string, id: string) => structuredClone(tables.get(table+':'+id)),
    set: async (table: string, id: string, value: unknown) => tables.set(table+':'+id, structuredClone(value)),
    remove: async (table: string, id: string) => tables.delete(table+':'+id),
  };
  const repo = {...io, all: async (table: string, familyId: string) => [...tables]
    .filter(([key,value]) => key.startsWith(table+':') && value.familyId === familyId)
    .map(([key,value]) => ({...structuredClone(value), _id:key.slice(table.length+1)})),
    transaction: (fn: (tx: typeof io) => unknown) => fn(io)};
  const handlers = createHandlers(repo);
  let failRead = false, response: any, failWrite: unknown;
  let writes = 0;
  const wxBefore = Object.getOwnPropertyDescriptor(globalThis, 'wx');
  const appBefore = Object.getOwnPropertyDescriptor(globalThis, 'getApp');
  Object.defineProperty(globalThis, 'getApp', {configurable:true,value:()=>({globalData:{cloudReady:true}})});
  Object.defineProperty(globalThis, 'wx', {configurable:true,value:{cloud:{callFunction:async ({name,data}:any)=>{
    if(name==='getOpenId') return {result:{openid:'test'}};
    if(data.action==='state') {
      if(failRead) throw {errCode:-501000,errMsg:'response size exceeded 1048576 bytes'};
      return {result:await handlers.state({familyId:'family_test'},data)};
    }
    writes++;
    if(failWrite) throw failWrite;
    return {result:response ?? await handlers.command({familyId:'family_test'},data)};
  }}}});
  t.after(()=>{
    for(const [key,old] of [['wx',wxBefore],['getApp',appBefore]] as const) {
      if(old) Object.defineProperty(globalThis,key,old); else delete (globalThis as any)[key];
    }
  });
  return {tables, writes:()=>writes, failRead:(value:boolean)=>{failRead=value;}, receipt:(value:any)=>{response=value;}, failWrite:(value:unknown)=>{failWrite=value;}};
}
const command = {action:'create',storyId:'story-recovery',title:'恢复测试',writingMode:'objective',memoryIds:[],requestId:'create-recovery-0001'};

test('acknowledged write followed by failed read stays saved and same-request retry is idempotent', async t => {
  const fixture=install(t); fixture.failRead(true);
  await assert.rejects(storyCommand(command), error => error instanceof SavedRefreshError && error.saved && error.requestId===command.requestId);
  assert.equal(fixture.writes(),1, 'never automatically resend a mutation');
  assert.ok(fixture.tables.has('stories:family_test_story-recovery'));
  fixture.failRead(false);
  const state=await storyCommand(command);
  assert.equal(state.stories?.length,1);
  assert.equal(state.stories?.[0].version,1);
  assert.equal([...fixture.tables.keys()].filter(key=>key.startsWith('story_operations:')).length,1);
});

test('unknown receipts and write timeouts never claim saved; server refusal retains its error', async t => {
  const fixture=install(t);
  for(const receipt of [{},{ok:false},{ok:true,storyId:'story-other'}]) {
    fixture.receipt(receipt);
    await assert.rejects(storyCommand(command), (error:any)=>error.code==='WRITE_UNCONFIRMED' && error.saved!==true);
  }
  const refusal=Object.assign(new Error('故事已有更新'),{code:'VERSION_CONFLICT'});
  fixture.failWrite(refusal);
  await assert.rejects(storyCommand(command), error=>error===refusal);
  const timeout={errCode:-504003};fixture.failWrite(timeout);
  await assert.rejects(storyCommand(command), error=>error===timeout);
  assert.equal(fixture.tables.has('stories:family_test_story-recovery'),false);
});
