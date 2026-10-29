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

test('complete revision summaries skip legacy receipt and edit collections',async()=>{
 const f=fixture();f.account('owner');
 f.tables.set('stories:family_owner_story-test',{id:'story-test',familyId:'family_owner'});
 f.tables.set('biography_drafts:family_owner_revision-test',{familyId:'family_owner',storyId:'story-test',
   revision:{id:'revision-test',storyId:'story-test',receivedFromName:'亲友小禾',changeSummary:'收到文章'}});
 const reads=[],all=f.repo.all;
 f.repo.all=async (...args)=>{reads.push(args[0]);return all(...args)};
 const row=(await readHistory(f.repo,{familyId:'family_owner'},{storyId:'story-test',action:'history'})).history[0];
 assert.deepEqual(reads,['biography_drafts']);
 assert.equal(row.receivedFromName,'亲友小禾');
 assert.equal(row.changeSummary,'收到文章');
});

test('legacy history scopes and projects its fallback queries without losing attribution',async()=>{
 const f=fixture();f.account('owner');
 f.tables.set('stories:family_owner_story-test',{id:'story-test',familyId:'family_owner'});
 f.tables.set('biography_drafts:family_owner_revision-test',{familyId:'family_owner',storyId:'story-test',
   revision:{id:'revision-test',storyId:'story-test'}});
 f.tables.set('story_copies:copy',{familyId:'family_owner',storyId:'story-test',revisionId:'revision-test',senderName:'亲友小禾'});
 f.tables.set('story_chapter_edits:edit',{familyId:'family_owner',storyId:'story-test',revisionId:'revision-test',
   changes:[{kind:'text',action:'changed',before:'虚构旧稿',after:'虚构新稿'}]});
 f.tables.set('story_copies:unrelated',{familyId:'family_owner',storyId:'story-other',revisionId:'revision-test',senderName:'别的故事'});
 const reads=[],all=f.repo.all;
 f.repo.all=async (...args)=>{reads.push(args);return all(...args)};
 const row=(await readHistory(f.repo,{familyId:'family_owner'},{storyId:'story-test',action:'history'})).history[0];
 assert.equal(row.receivedFromName,'亲友小禾');
 assert.equal(row.changeSummary,'修改 1 段文字');
 for(const table of ['story_copies','story_chapter_edits']) {
   const read=reads.find(([name])=>name===table);
   assert.equal(read[1],'family_owner');
   assert.deepEqual(read[3],{storyId:'story-test'});
 }
 assert.deepEqual(reads.find(([name])=>name==='story_copies')[2],
   {familyId:true,storyId:true,revisionId:true,senderName:true});
 assert.deepEqual(reads.find(([name])=>name==='story_chapter_edits')[2],
   {familyId:true,storyId:true,revisionId:true,'changes.kind':true,'changes.action':true});
});

test('legacy attribution tolerates missing collections but rejects other read failures',async()=>{
 const f=fixture();f.account('owner');
 f.tables.set('stories:family_owner_story-test',{id:'story-test',familyId:'family_owner'});
 f.tables.set('biography_drafts:family_owner_revision-test',{familyId:'family_owner',storyId:'story-test',
   revision:{id:'revision-test',storyId:'story-test'}});
 const all=f.repo.all;
 let failure=new Error('DATABASE_COLLECTION_NOT_EXIST');
 f.repo.all=(...args)=>args[0]==='biography_drafts'?all(...args):Promise.reject(failure);
 const row=(await readHistory(f.repo,{familyId:'family_owner'},{storyId:'story-test',action:'history'})).history[0];
 assert.equal(row.receivedFromName,'');assert.equal(row.changeSummary,'');
 failure=new Error('permission denied');
 await assert.rejects(readHistory(f.repo,{familyId:'family_owner'},{storyId:'story-test',action:'history'}),error=>error===failure);
});
