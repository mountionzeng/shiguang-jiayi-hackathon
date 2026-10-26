const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/story-access-fixture');
const {resolveStoryIdentity}=require('../cloudfunctions/storyBooks/identity');
const {readHistory}=require('../cloudfunctions/storyBooks/history');
test('history names the actual editor using their current self-chosen name without exposing identity',async()=>{
 const f=fixture(),account=f.account('owner');
 const ctx=await resolveStoryIdentity(f.repo,{APPID:'wx-original',OPENID:'owner'},{bootstrapAppId:'wx-original'});
 f.tables.get('user_accounts:'+account.accountId).displayName='小禾';
 f.tables.set('stories:family_owner_story-test',{id:'story-test',familyId:'family_owner'});
 f.tables.set('biography_drafts:family_owner_revision-test',{familyId:'family_owner',storyId:'story-test',revision:{id:'revision-test',storyId:'story-test',kind:'version',label:'自动保存',savedAt:'2026-10-26',editedByPrincipalId:ctx.principalId,editorName:'旧名字',changeSummary:'修改 1 段文字'}});
 let result=await readHistory(f.repo,ctx,{storyId:'story-test',action:'history'});
 assert.equal(result.history[0].editorName,'小禾');assert.equal(result.history[0].changeSummary,'修改 1 段文字');
 assert.ok(!JSON.stringify(result).includes(ctx.principalId));
 f.tables.get('user_accounts:'+account.accountId).displayName='小满';
 result=await readHistory(f.repo,ctx,{storyId:'story-test',action:'history'});assert.equal(result.history[0].editorName,'小满');
});
test('legacy import history shows source signature separately from unrecorded editor',async()=>{
 const f=fixture(); f.account('owner');const ctx={familyId:'family_owner'};
 f.tables.set('stories:family_owner_story-test',{id:'story-test',familyId:'family_owner'});
 f.tables.set('biography_drafts:family_owner_revision-test',{familyId:'family_owner',storyId:'story-test',revision:{id:'revision-test',storyId:'story-test',label:'导入章节包',savedAt:'2026-10-26'}});
 f.tables.set('story_copies:copy',{familyId:'family_owner',storyId:'story-test',revisionId:'revision-test',senderName:'亲友小禾'});
 const row=(await readHistory(f.repo,ctx,{storyId:'story-test',action:'history'})).history[0];
 assert.equal(row.receivedFromName,'亲友小禾');assert.equal(row.editorName,'');
});
