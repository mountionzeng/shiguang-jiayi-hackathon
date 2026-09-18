const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/story-access-fixture');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const { grantIdFor } = require('../cloudfunctions/storyBooks/access');
const { aliasIdFor } = require('../cloudfunctions/storyBooks/identity');
async function setup() {
  const f = fixture(); for (const id of ['owner', 'reader', 'stranger']) f.account(id);
  const options = { accessEnabled:true, rulesReady:true, invitationsEnabled:true, bootstrapAppId:'wx-original', sharedReadFamilyIds:['family_owner','family_reader','family_stranger'] };
  const service = createStoryService(f.repo, options);
  const call = (who, action, input={}) => service({APPID:'wx-original',OPENID:who},{action,...input});
  await call('owner','create',{storyId:'story-a',title:'私密题名',writingMode:'objective',memoryIds:[],requestId:'create-story-a'});
  f.tables.get('stories:family_owner_story-a').currentRevisionId='revision-a';
  f.tables.set('biography_drafts:family_owner_revision-a',{familyId:'family_owner',storyId:'story-a',revision:{id:'revision-a',storyId:'story-a',draft:{chapters:[{id:'chapter-one',title:'私密',content:[{text:'私密正文'}]},{id:'chapter-three',title:'第三章',content:[{text:'共享正文'}]}]}}});
  const create = () => call('owner','inviteCreate',{familyId:'family_owner',storyId:'story-a',chapterIds:['chapter-three'],permissions:{read:true,forward:false}});
  return {...f,call,create,options,service};
}
test('invitation link has no manuscript; owner approval binds exactly one verified applicant',async()=>{
  const f=await setup(), inv=await f.create();
  assert.match(inv.token,/^[a-f0-9]{48}$/);
  assert.equal(JSON.stringify([...f.tables.values()]).includes(inv.token),false,'only token digest is stored');
  const pending=await f.call('stranger','inviteApply',{token:inv.token,displayName:'陌生人'});
  assert.equal(JSON.stringify(pending).includes('私密'),false);
  await assert.rejects(f.call('stranger','sharedRead',{familyId:'family_owner',storyId:'story-a'}),{code:'STORY_FORBIDDEN'});
  await f.call('owner','inviteDecide',{familyId:'family_owner',storyId:'story-a',invitationId:inv.invitationId,applicantId:pending.applicantId,decision:'reject',verificationCode:pending.verificationCode});
  await assert.rejects(f.call('stranger','inviteApply',{token:inv.token,displayName:'再试'}),{code:'STORY_FORBIDDEN'});
  const applicant=await f.call('reader','inviteApply',{token:inv.token,displayName:'亲友'});
  assert.deepEqual(await f.call('reader','inviteApply',{token:inv.token,displayName:'亲友'}),applicant);
  const approve={familyId:'family_owner',storyId:'story-a',invitationId:inv.invitationId,applicantId:applicant.applicantId,decision:'approve',verificationCode:applicant.verificationCode};
  await assert.rejects(f.call('owner','inviteDecide',{...approve,verificationCode:'00000000'}));
  await Promise.all([f.call('owner','inviteDecide',approve),f.call('owner','inviteDecide',approve)]);
  const result=await f.call('reader','sharedRead',{familyId:'family_owner',storyId:'story-a'});
  assert.deepEqual(result.chapters.map(c=>c.id),['chapter-three']);
  await assert.rejects(f.call('stranger','inviteApply',{token:inv.token,displayName:'冒用'}));
  await f.call('owner','inviteRevoke',{familyId:'family_owner',storyId:'story-a',invitationId:inv.invitationId});
  await assert.rejects(f.call('reader','sharedRead',{familyId:'family_owner',storyId:'story-a'}),{code:'STORY_FORBIDDEN'});
});
test('expired/deleted resources, unsupported permissions and non-owner management fail closed',async()=>{
  const f=await setup(),inv=await f.create();
  await assert.rejects(f.call('reader','inviteManage',{familyId:'family_owner',storyId:'story-a'}),{code:'STORY_FORBIDDEN'});
  await assert.rejects(f.call('owner','inviteCreate',{familyId:'family_owner',storyId:'story-a',chapterIds:['chapter-three'],permissions:{read:true,edit:true}}));
  f.tables.get(`story_invitations:${inv.invitationId}`).expiresAtMs=0;
  await assert.rejects(f.call('reader','inviteApply',{token:inv.token,displayName:'亲友'}));
  const next=await f.create();f.tables.get('stories:family_owner_story-a').deletedAt='today';
  await assert.rejects(f.call('reader','inviteApply',{token:next.token,displayName:'亲友'}));
});
test('forwarding is a fresh owner-reviewed invitation and cannot expand scope or capabilities',async()=>{
  const f=await setup(); await f.call('reader','capabilities');
  const principal=who=>f.tables.get(`story_identity_aliases:${aliasIdFor('wx-original',who)}`).principalId;
  const gid=grantIdFor('family_owner','story-a',principal('reader'));
  f.tables.set(`story_grants:${gid}`,{familyId:'family_owner',storyId:'story-a',principalId:principal('reader'),ownerPrincipalId:principal('owner'),status:'active',version:1,scope:{type:'chapters',chapterIds:['chapter-three']},permissions:{read:true,forward:true}});
  const input={familyId:'family_owner',storyId:'story-a',chapterIds:['chapter-three'],permissions:{read:true}};
  for(const change of [{chapterIds:['chapter-one']},{permissions:{read:true,edit:true}},{permissions:{read:true,forward:true}}]) await assert.rejects(f.call('reader','inviteCreate',{...input,...change}));
  const inv=await f.call('reader','inviteCreate',input);
  const applicant=await f.call('stranger','inviteApply',{token:inv.token,displayName:'下一位'});
  await assert.rejects(f.call('reader','inviteDecide',{...input,invitationId:inv.invitationId,applicantId:applicant.applicantId,decision:'approve',verificationCode:applicant.verificationCode}));
  f.tables.get(`story_grants:${gid}`).status='revoked';
  await assert.rejects(f.call('owner','inviteDecide',{...input,invitationId:inv.invitationId,applicantId:applicant.applicantId,decision:'approve',verificationCode:applicant.verificationCode}));
});
test('invitation rollout gate defaults off even when identity and shared reads are ready',async()=>{
  const f=await setup();
  await assert.rejects(createStoryService(f.repo,{...f.options,invitationsEnabled:false})({APPID:'wx-original',OPENID:'owner'},{action:'inviteCreate'}),{code:'STORY_ACCESS_DISABLED'});
});
test('concurrent decisions for different people grant exactly one recipient',async()=>{
  const f=await setup(),inv=await f.create();
  const applicants=await Promise.all(['reader','stranger'].map(who=>f.call(who,'inviteApply',{token:inv.token,displayName:who})));
  const decisions=await Promise.allSettled(applicants.map(a=>f.call('owner','inviteDecide',{familyId:'family_owner',storyId:'story-a',invitationId:inv.invitationId,applicantId:a.applicantId,verificationCode:a.verificationCode,decision:'approve'})));
  assert.equal(decisions.filter(r=>r.status==='fulfilled').length,1);
  assert.equal([...f.tables.keys()].filter(k=>k.startsWith('story_grants:')).length,1);
});
test('changed manuscript retains exact chapter IDs and deleted chapter cannot become whole-story access',async()=>{
  const f=await setup(),inv=await f.create(),a=await f.call('reader','inviteApply',{token:inv.token,displayName:'亲友'});
  const revision=f.tables.get('biography_drafts:family_owner_revision-a').revision;
  revision.draft.chapters=revision.draft.chapters.filter(c=>c.id!=='chapter-three');
  await assert.rejects(f.call('owner','inviteDecide',{familyId:'family_owner',storyId:'story-a',invitationId:inv.invitationId,applicantId:a.applicantId,verificationCode:a.verificationCode,decision:'approve'}),{code:'STORY_FORBIDDEN'});
  assert.equal([...f.tables.keys()].some(k=>k.startsWith('story_grants:')),false);
});
test('per-principal rate guard denies extra invites without leaving orphan records',async()=>{
  const f=await setup();await f.call('owner','capabilities');
  const principal=f.tables.get(`story_identity_aliases:${aliasIdFor('wx-original','owner')}`).principalId;
  f.tables.set(`story_invite_rates:${principal}`,{window:Math.floor(Date.now()/3600000),count:30});
  await assert.rejects(f.create(),{code:'STORY_INVITE_LIMIT'});
  assert.equal([...f.tables.keys()].some(k=>k.startsWith('story_invitations:')),false);
});
