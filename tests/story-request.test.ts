import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryCaller } from '../miniprogram/services/storyRequest';
const {fixture}=require('./helpers/story-access-fixture');
const {createStoryService}=require('../cloudfunctions/storyBooks/service');
const core=require('../cloudfunctions/storyBooks/core');
const call=createStoryCaller('unavailable','failed');

test('first-time recipient opens invitation, joins, reads, reopens and loses access after owner revokes',async()=>{
  const f=fixture();f.account('owner');
  const service=createStoryService(f.repo,{accessEnabled:true,rulesReady:true,invitationsEnabled:true,approveChapterText:async()=>true,
    bootstrapAppId:'wx-original',sharedReadFamilyIds:['family_owner']});
  const owner=(action:string,data:any={})=>service({APPID:'wx-original',OPENID:'owner'},{action,...data});
  await owner('create',{storyId:'story-a',title:'夏天',writingMode:'objective',memoryIds:[],requestId:'create-story-a'});
  f.tables.get('stories:family_owner_story-a').currentRevisionId='revision-a';
  const chapters=[{id:'chapter-one',title:'井水',memoryIds:[],content:[{text:'井水里的西瓜很凉。'}]}];
  f.tables.set('biography_drafts:family_owner_revision-a',{familyId:'family_owner',storyId:'story-a',revision:{id:'revision-a',storyId:'story-a',draft:{title:'夏天',chapters,...core.flatten(chapters),sourceCount:0,generatedAt:'',generationMode:'local-demo'}}});
  const invitation=await owner('inviteCreate',{familyId:'family_owner',storyId:'story-a',chapterIds:['chapter-one'],inviteeName:'朋友',permissions:{read:true,forward:false}});
  const previous=(globalThis as any).wx;let registrations=0;
  (globalThis as any).wx={cloud:{callFunction:async({name,data}:any)=>{
    if(name==='getOpenId'){registrations++;const account=f.account('new-friend');return {result:{accountLinked:true,account:{accountId:account.accountId,primaryFamilyId:account.familyId}}};}
    try{return {result:await service({APPID:'wx-original',OPENID:'new-friend'},data)};}
    catch(error:any){return {result:{error:'STORY_BOOK_ERROR',code:error.code,message:error.message}};}
  }}};
  try{
    const status:any=await call('inviteGet',{token:invitation.token});assert.equal(status.status,'unrequested');
    const accepted:any=await call('inviteAccept',{token:invitation.token});assert.equal(accepted.status,'approved');
    const read:any=await call('sharedRead',{familyId:'family_owner',storyId:'story-a'});
    assert.equal(read.chapters[0].title,'井水');assert.equal(read.chapters[0].content[0].text,'井水里的西瓜很凉。');
    assert.equal((await call<any>('inviteAccept',{token:invitation.token})).status,'approved');
    await owner('inviteRevoke',{familyId:'family_owner',storyId:'story-a',invitationId:invitation.invitationId});
    await assert.rejects(call('sharedRead',{familyId:'family_owner',storyId:'story-a'}),{code:'STORY_FORBIDDEN'});
    assert.equal(registrations,1);
  }finally{(globalThis as any).wx=previous;}
});

test('initialization is bounded, failures stop retry, and forbidden/network errors never initialize an account',async()=>{
  const previous=(globalThis as any).wx;
  try{for(const scenario of ['unlinked','registration-failed','forbidden','network']){
    let reads=0,registrations=0;
    (globalThis as any).wx={cloud:{callFunction:async({name}:any)=>{
      if(name==='getOpenId'){registrations++;return {result:{accountLinked:scenario!=='registration-failed',account:{accountId:'account-test',primaryFamilyId:'family-test'}}};}
      reads++;if(scenario==='network')throw new Error('network');
      return {result:{error:'STORY_BOOK_ERROR',code:scenario==='forbidden'?'STORY_FORBIDDEN':'IDENTITY_UNLINKED'}};
    }}};
    await assert.rejects(call('inviteGet',{token:'test'}));
    assert.equal(reads,scenario==='unlinked'?2:1);
    assert.equal(registrations,['unlinked','registration-failed'].includes(scenario)?1:0);
  }}finally{(globalThis as any).wx=previous;}
});
