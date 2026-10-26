import test from 'node:test';
import assert from 'node:assert/strict';
import {loadCloudRoomState} from '../miniprogram/services/cloudRoomStorage';
import {createEmptyRoomState} from '../miniprogram/domain/biography';

test('first home load waits for account registration before requesting the protected story state',async()=>{
  const previous=(globalThis as any).wx;
  let registered=false,release!:()=>void;const calls:string[]=[];
  const registration=new Promise<void>(resolve=>{release=resolve;});
  (globalThis as any).wx={cloud:{callFunction:async({name}:any)=>{
    calls.push(name);
    if(name==='getOpenId') {await registration;registered=true;return {result:{openid:'first-login-fixture',account:{primaryFamilyId:'family_first-login-fixture'}}};}
    assert.equal(registered,true,'story identity depends on the account registration');
    return {result:{...createEmptyRoomState(),roomStateVersion:1,manuscriptRevisions:[],stories:[],deletedStories:[],personalDraftSourceFingerprints:{}}};
  }}};
  try {
    const pending=loadCloudRoomState({view:'home'});
    await Promise.resolve();
    release();
    await pending;
    assert.deepEqual(calls,['getOpenId','storyBooks']);
  } finally {(globalThis as any).wx=previous;}
});
