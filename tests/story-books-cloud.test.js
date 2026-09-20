const test = require('node:test');
const assert = require('node:assert/strict');
const {createHandlers} = require('../cloudfunctions/storyBooks/flow');
const core = require('../cloudfunctions/storyBooks/core');
const {writableDocument} = require('../cloudfunctions/storyBooks/repository');
function fixture({ migrationStatus = 'active' } = {}) {
  const tables = new Map(); let chain = Promise.resolve();
  const key = (t,id)=>t+':'+id;
  const io = {
    get: async(t,id)=>structuredClone(tables.get(key(t,id))),
    set: async(t,id,v)=>{tables.set(key(t,id),structuredClone(v));},
    remove: async(t,id)=>{tables.delete(key(t,id));},
  };
  tables.set('families:family_test',migrationStatus ? {storyBooks:{status:migrationStatus,version:1}} : {});
  const repo = {...io,all:async(t,f)=>[...tables].filter(([k,v])=>k.startsWith(t+':') && v.familyId===f).map(([k,v])=>structuredClone({_id:k.slice(t.length+1),...v})),
    transaction:fn=>{const result=chain.then(async()=>{const before=new Map(tables);try{return await fn(io);}catch(e){tables.clear();for(const [k,v] of before)tables.set(k,v);throw e;}});chain=result.catch(()=>{});return result;}};
  return {handlers:createHandlers(repo,{migrationReady:true}),tables,repo};
}
test('cloud writes never send the database-owned _id field back to document.set',()=>{
  const source={_id:'family_test',roomName:'测试',storyBooks:{status:'preparing'}};
  assert.deepEqual(writableDocument(source),{roomName:'测试',storyBooks:{status:'preparing'}});
  assert.equal(source._id,'family_test','normalization does not mutate the loaded document');
});
test('cloud transactions reject same-book concurrent saves and allow independent books',async()=>{
  const {handlers:h}=fixture(), ctx={familyId:'family_test'};
  const create=id=>h.command(ctx,{action:'create',storyId:id,title:id,writingMode:'objective',memoryIds:[],requestId:'create-'+id});
  await create('story-a');await create('story-b');
  const op=(id,req)=>h.command(ctx,{action:'update',storyId:id,expectedVersion:1,patch:{bookTitle:req},requestId:req});
  const same=await Promise.allSettled([op('story-a','request-1111'),op('story-a','request-2222')]);
  assert.equal(same.filter(r=>r.status==='fulfilled').length,1);
  await op('story-b','request-3333');
  assert.equal((await h.state(ctx)).stories.length,2);
});
test('migration allowlist keeps non-canary families inactive',async()=>{
  const tables=new Map([['families:family_test',{}]]), key=(table,id)=>table+':'+id;
  const io={get:async(table,id)=>structuredClone(tables.get(key(table,id))),set:async(table,id,value)=>tables.set(key(table,id),structuredClone(value)),remove:async(table,id)=>tables.delete(key(table,id))};
  const repo={...io,all:async()=>[],transaction:fn=>fn(io)};
  const handlers=createHandlers(repo,{migrationReady:true,migrationFamilyIds:['family_canary']});
  await assert.rejects(handlers.migrate({familyId:'family_test'}),/尚未进入/);
  assert.equal(tables.get('families:family_test').storyBooks,undefined);
});
test('a completed single-batch migration recovers metadata erased by a legacy client',async()=>{
  const tables=new Map(), key=(table,id)=>table+':'+id;
  const io={get:async(table,id)=>structuredClone(tables.get(key(table,id))),set:async(table,id,value)=>tables.set(key(table,id),structuredClone(value)),remove:async(table,id)=>tables.delete(key(table,id))};
  const repo={...io,all:async(table,familyId)=>[...tables].filter(([entryKey,value])=>entryKey.startsWith(table+':')&&value.familyId===familyId).map(([entryKey,value])=>structuredClone({_id:entryKey.slice(table.length+1),...value})),transaction:fn=>fn(io)};
  const ctx={familyId:'family_test'};
  const source={contributions:[],deletedStories:[],legacyPersonalDrafts:{},personalDrafts:{},manuscriptRevisions:[],legacyImages:[],legacyImageJobs:[]};
  const digest=core.hash(core.stable(source));
  tables.set('families:family_test',{roomName:'仍在的房间'});
  tables.set('stories:family_test_story-recovered',{familyId:'family_test',id:'story-recovered',title:'找回的故事',bookTitle:'找回的故事',writingMode:'objective',version:1,currentRevisionId:'',memoryIds:[],imageIds:[],protagonistMemberIds:[],createdAt:'2026-09-19',updatedAt:'2026-09-19',migrationSourceDigest:digest,migrationDocumentId:'family_test_story-recovered'});
  tables.set('story_names:family_test_name',{familyId:'family_test',storyId:'story-recovered',title:'找回的故事',migrationSourceDigest:digest,migrationDocumentId:'family_test_name'});
  tables.set('memories:family_test_later-memory',{familyId:'family_test',frontendContributionId:'later-memory',scope:'personal',storyTitle:'后来新增',text:'迁移激活后才新增的内容'});
  const handlers=createHandlers(repo,{migrationReady:false});

  assert.deepEqual(await handlers.migrate(ctx),{status:'active',recovered:2});
  assert.equal(tables.get('families:family_test').storyBooks.status,'active');
  assert.equal((await handlers.state(ctx)).stories[0].title,'找回的故事');
});
test('missing migrated revision records do not hide the shelf and can be rebuilt from pending chapters',async()=>{
  const {handlers:h,tables}=fixture(),ctx={familyId:'family_test'};
  tables.set('stories:family_test_story-a',{familyId:'family_test',id:'story-a',title:'保留下来的故事',bookTitle:'保留下来的故事',writingMode:'objective',version:1,currentRevisionId:'revision-missing',memoryIds:[],imageIds:[],protagonistMemberIds:[],createdAt:'2026-09-19',updatedAt:'2026-09-19'});
  tables.set('story_migration_items:family_test_pending-a',{familyId:'family_test',item:{id:'pending-a',sourceRevisionId:'legacy-revision',memberId:'owner',chapter:{id:'legacy-chapter',title:'旧章节',memoryIds:[],content:[{text:'仍然完整的旧正文'}]},reason:'没有明确来源记忆'}});

  const visible=await h.state(ctx);
  assert.equal(visible.stories[0].currentRevisionId,'');
  const revision={id:'revision-recovered',storyId:'story-a',memberId:'owner',kind:'version',label:'恢复旧章节',savedAt:'',sourceFingerprint:'',draft:{title:'',paragraphs:[],sourceCount:0,generatedAt:'',generationMode:'local-demo'}};
  await h.command(ctx,{action:'resolve',storyId:'story-a',expectedVersion:1,expectedRevisionId:'',pendingId:'pending-a',revision,requestId:revision.id});

  const story=tables.get('stories:family_test_story-a');
  const saved=tables.get('biography_drafts:family_test_revision-recovered');
  assert.equal(story.currentRevisionId,'revision-recovered');
  assert.equal(story.orphanedRevisionId,'revision-missing');
  assert.equal(saved.revision.draft.chapters[0].content[0].text,'仍然完整的旧正文');
});
test('lost acknowledgement retry is idempotent and foreign stories are inaccessible',async()=>{
  const {handlers:h}=fixture(), ctx={familyId:'family_test'};
  const input={action:'create',storyId:'story-a',title:'A',writingMode:'objective',memoryIds:[],requestId:'create-story-a'};
  await h.command(ctx,input);await h.command(ctx,input);
  assert.equal((await h.state(ctx)).stories.length,1);
  await assert.rejects(h.command({familyId:'family_other'},{action:'update',storyId:'story-a',expectedVersion:1,patch:{title:'偷改'},requestId:'request-9999'}));
});
test('production-shaped memory records keep their frontend contribution ids',async()=>{
  const {handlers:h,tables}=fixture(), ctx={familyId:'family_test'};
  tables.set('memories:family_test_memory-a',{familyId:'family_test',frontendContributionId:'memory-a',scope:'personal',text:'一段记忆'});
  await h.command(ctx,{action:'create',storyId:'story-a',title:'A',writingMode:'objective',memoryIds:['memory-a'],requestId:'create-story-a'});
  assert.deepEqual((await h.state(ctx)).stories[0].memoryIds,['memory-a']);
});

test('authenticated state returns the complete owner room without database metadata',async()=>{
  const {handlers:h,tables}=fixture(),ctx={familyId:'family_test'};
  tables.set('families:family_test',{roomName:'服务端房间',protagonistName:'测试者',deletedStories:[],storyBooks:{status:'active',version:1}});
  tables.set('family_members:family_test_owner',{familyId:'family_test',memberId:'owner',name:'测试者',relation:'自己',role:'owner',avatarText:'测'});
  tables.set('memories:family_test_memory-a',{familyId:'family_test',frontendContributionId:'memory-a',authorMemberId:'owner',authorName:'测试者',relation:'自己',scope:'personal',visibility:'private',reviewStatus:'approved',text:'一段记忆',createdAt:'2026-09-19'});
  tables.set('biography_drafts:family_test_personal',{familyId:'family_test',draftType:'personal',memberId:'owner',draft:{title:'旧稿'}});

  const state=await h.state(ctx);

  assert.equal(state.roomStateVersion,1);
  assert.equal(state.roomName,'服务端房间');
  assert.deepEqual(state.members,[{id:'owner',name:'测试者',relation:'自己',role:'owner',avatarText:'测'}]);
  assert.equal(state.contributions[0].id,'memory-a');
  assert.equal(state.contributions[0]._id,undefined);
  assert.equal(state.contributions[0].familyId,undefined);
  assert.equal(state.personalDrafts.owner.title,'旧稿');
  assert.equal(state.legacyPersonalDrafts,undefined,'versioned state does not duplicate personal drafts');
});

test('owner member actions add and edit people without client database permissions',async()=>{
  const {handlers:h,tables}=fixture(),ctx={familyId:'family_test'};
  tables.set('families:family_test',{roomName:'服务端房间',storyBooks:{status:'active',version:1}});
  tables.set('family_members:family_test_owner',{familyId:'family_test',memberId:'owner',name:'测试者',relation:'自己',role:'owner',avatarText:'测',kind:'recording-profile'});

  await h.memberAdd(ctx,{memberId:'member-friend',name:' 老朋友 ',relation:'朋友',kind:'person'});
  tables.set('memories:family_test_memory-a',{familyId:'family_test',frontendContributionId:'memory-a',authorMemberId:'member-friend',authorName:'老朋友',relation:'朋友',scope:'personal',text:'原文保持不变'});
  tables.set('source_records:src_family_test_memory-a',{familyId:'family_test',frontendContributionId:'memory-a',contributorMemberId:'member-friend',contributorName:'老朋友',relation:'朋友',rawText:'原文保持不变'});

  await h.memberUpdate(ctx,{memberId:'member-friend',name:'新名字',relation:'多年好友'});

  const member=tables.get('family_members:family_test_member-friend');
  assert.deepEqual({memberId:member.memberId,name:member.name,relation:member.relation,kind:member.kind,avatarText:member.avatarText},
    {memberId:'member-friend',name:'新名字',relation:'多年好友',kind:'person',avatarText:'新'});
  assert.equal(tables.get('memories:family_test_memory-a').text,'原文保持不变');
  assert.equal(tables.get('source_records:src_family_test_memory-a').rawText,'原文保持不变');
  tables.set('memories:family_test_memory-late',{familyId:'family_test',frontendContributionId:'memory-late',authorMemberId:'member-friend',authorName:'老朋友',relation:'朋友',text:'并发写入的旧署名'});
  const late=(await h.state(ctx)).contributions.find(item=>item.id==='memory-late');
  assert.deepEqual({id:late.id,authorName:late.authorName,relation:late.relation,text:late.text},
    {id:'memory-late',authorName:'新名字',relation:'多年好友',text:'并发写入的旧署名'});
  await h.command(ctx,{action:'create',storyId:'story-member-name',title:'署名测试',writingMode:'creative',memoryIds:['memory-a'],requestId:'create-member-name'});
  const ai=await h.aiContext(ctx,{storyId:'story-member-name',memoryIds:['memory-a']});
  assert.deepEqual({authorName:ai.memories[0].authorName,relation:ai.memories[0].relation},
    {authorName:'新名字',relation:'多年好友'});
  await assert.rejects(h.memberUpdate(ctx,{memberId:'member-friend',name:'测试者',relation:'朋友'}),{code:'MEMBER_CONFLICT'});
});

test('legacy id-only members can be edited and are backfilled with memberId',async()=>{
  const {handlers:h,tables}=fixture(),ctx={familyId:'family_test'};
  tables.set('family_members:family_test_legacy',{familyId:'family_test',id:'legacy',name:'旧名字',relation:'朋友',role:'contributor',avatarText:'旧',kind:'person'});

  await h.memberUpdate(ctx,{memberId:'legacy',name:'新名字',relation:'老朋友'});

  const member=tables.get('family_members:family_test_legacy');
  assert.deepEqual({id:member.id,memberId:member.memberId,name:member.name,relation:member.relation},
    {id:'legacy',memberId:'legacy',name:'新名字',relation:'老朋友'});
});

test('concurrent member additions cannot claim the same name',async()=>{
  const {handlers:h,tables}=fixture(),ctx={familyId:'family_test'};
  tables.set('family_members:family_test_owner',{familyId:'family_test',memberId:'owner',name:'测试者',relation:'自己',role:'owner',avatarText:'测',kind:'recording-profile'});

  const results=await Promise.allSettled([
    h.memberAdd(ctx,{memberId:'friend-a',name:'同名亲友',relation:'朋友',kind:'person'}),
    h.memberAdd(ctx,{memberId:'friend-b',name:'同名亲友',relation:'朋友',kind:'person'}),
  ]);

  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal([...tables.values()].filter(row=>row?.familyId==='family_test' && row?.name==='同名亲友').length,1);
});

test('migration resumes across batches and activates only after every planned row is written',async()=>{
  const {handlers:h,tables}=fixture({migrationStatus:null}), ctx={familyId:'family_test'};
  for(let index=0;index<41;index++) {
    const id='memory-'+String(index).padStart(2,'0');
    tables.set('memories:family_test_'+id,{familyId:'family_test',frontendContributionId:id,scope:'personal',storyTitle:'故事 '+index,text:'记忆 '+index});
  }

  const first=await h.migrate(ctx);
  assert.deepEqual(first,{status:'preparing',processed:80,total:82});
  assert.equal(tables.get('families:family_test').storyBooks.status,'preparing');

  const second=await h.migrate(ctx);
  assert.deepEqual(second,{status:'active',processed:82,total:82});
  assert.equal(tables.get('families:family_test').storyBooks.status,'active');
  assert.equal((await h.state(ctx)).stories.length,41);
});

test('migration restarts from fresh legacy source when data changes between batches',async()=>{
  const {handlers:h,tables}=fixture({migrationStatus:null}), ctx={familyId:'family_test'};
  for(let index=0;index<41;index++) {
    const id='memory-'+String(index).padStart(2,'0');
    tables.set('memories:family_test_'+id,{familyId:'family_test',frontendContributionId:id,scope:'personal',storyTitle:'故事 '+index,text:'记忆 '+index});
  }
  const first=await h.migrate(ctx);
  assert.equal(first.status,'preparing');

  tables.set('memories:family_test_memory-new',{familyId:'family_test',frontendContributionId:'memory-new',scope:'personal',storyTitle:'后来新增的故事',text:'迁移期间新增'});
  const restart=await h.migrate(ctx);
  assert.equal(restart.status,'restarting');
  assert.equal((await h.state(ctx)).stories.length,0,'partially prepared stories stay hidden');

  let result=restart;
  for(let attempt=0;attempt<5 && result.status!=='active';attempt++) result=await h.migrate(ctx);
  assert.equal(result.status,'active');
  assert.equal((await h.state(ctx)).stories.length,42);
});

test('revision save revalidates image availability inside its transaction',async()=>{
  const {handlers:h,tables,repo}=fixture(), ctx={familyId:'family_test'};
  await h.command(ctx,{action:'create',storyId:'story-a',title:'A',writingMode:'objective',memoryIds:[],requestId:'create-story-a'});
  const imageId='family_test_img_req-aaaaaaaa';
  tables.set('story_images:'+imageId,{familyId:'family_test',storyId:'story-a',deletedAtMs:undefined});
  const chapter={id:'chapter-a',title:'图文',memoryIds:[],content:[{text:'正文'},{photoId:'photo-ai-req-aaaaaaaa'}]};
  const revision={id:'revision-save-image',storyId:'story-a',memberId:'owner',kind:'version',label:'保存',savedAt:'',sourceFingerprint:'',draft:{title:'A',chapters:[chapter],...core.flatten([chapter]),sourceCount:0,generatedAt:'',generationMode:'local-demo'}};
  const transaction=repo.transaction;
  repo.transaction=fn=>{
    repo.transaction=transaction;
    tables.set('story_images:'+imageId,{...tables.get('story_images:'+imageId),deletedAtMs:1});
    return transaction(fn);
  };
  await assert.rejects(h.command(ctx,{action:'save',storyId:'story-a',expectedVersion:1,expectedRevisionId:'',revision,requestId:revision.id}),/不可用/);
  assert.equal((await h.state(ctx)).manuscriptRevisions.length,0);
});

test('migration links legacy images and in-flight jobs to the uniquely owning story and exposes unassigned assets',async()=>{
  const {handlers:h,tables}=fixture({migrationStatus:null}), ctx={familyId:'family_test'};
  tables.set('memories:family_test_memory-a',{familyId:'family_test',frontendContributionId:'memory-a',authorMemberId:'owner',scope:'personal',storyTitle:'旧故事',text:'旧记忆'});
  const chapter={id:'chapter-old',title:'旧章',memoryIds:['memory-a'],content:[{text:'正文'},{photoId:'photo-ai-req-abcdefgh'}]};
  tables.set('biography_drafts:family_test_legacy-revision',{familyId:'family_test',draftType:'manuscript-revision',revision:{id:'legacy-revision',memberId:'owner',kind:'version',label:'旧稿',savedAt:'2026-09-17',sourceFingerprint:'',draft:{title:'旧书',chapters:[chapter],...core.flatten([chapter]),sourceCount:1,generatedAt:'2026-09-17',generationMode:'local-demo'}}});
  const imageId='family_test_img_req-abcdefgh';
  tables.set('story_images:'+imageId,{familyId:'family_test',memberId:'owner',chapterId:'chapter-old',fileID:'cloud://used'});
  tables.set('story_images:family_test_img_req-unowned1',{familyId:'family_test',memberId:'owner',chapterId:'chapter-missing',fileID:'cloud://unowned'});
  tables.set('image_jobs:family_test_req-job-old',{familyId:'family_test',memberId:'owner',chapterId:'chapter-old',status:'unknown'});

  let result=await h.migrate(ctx);
  while(result.status!=='active')result=await h.migrate(ctx);
  const story=(await h.state(ctx)).stories[0];
  const imageLinks=[...tables].filter(([key])=>key.startsWith('story_image_links:')).map(([,value])=>value);
  const jobLinks=[...tables].filter(([key])=>key.startsWith('story_image_job_links:')).map(([,value])=>value);
  const pending=[...tables].filter(([key])=>key.startsWith('story_migration_items:')).map(([,value])=>value.item);
  assert.ok(imageLinks.some(link=>link.storyId===story.id && link.imageId===imageId));
  assert.ok(jobLinks.some(link=>link.storyId===story.id && link.jobId==='family_test_req-job-old'));
  const unassigned=pending.find(item=>item.kind==='image' && item.imageId==='family_test_img_req-unowned1');
  assert.ok(unassigned);
  await h.command(ctx,{action:'resolveAsset',storyId:story.id,expectedVersion:story.version,pendingId:unassigned.id,requestId:'resolve-unowned-image'});
  const resolved=[...tables].find(([key])=>key.startsWith('story_migration_items:') && tables.get(key).item.id===unassigned.id)?.[1].item;
  assert.equal(resolved.resolvedStoryId,story.id);
  assert.ok([...tables].some(([key,value])=>key.startsWith('story_image_links:') && value.storyId===story.id && value.imageId==='family_test_img_req-unowned1'));
});

const {errorCode} = require('../cloudfunctions/storyBooks/errors');

test('业务错误在抛出处自带错误码，不靠消息文字匹配',()=>{
  assert.throws(
    ()=>core.activeStory({stories:[{id:'story-a',title:'测试',deletedAt:'2026-01-01T00:00:00.000Z'}]},'story-a'),
    error=>error.code==='STORY_NOT_FOUND',
  );
  assert.equal(errorCode(Object.assign(new Error('这本故事书已不可用，请返回书架'),{code:'STORY_NOT_FOUND'})),'STORY_NOT_FOUND');
});

/*
 * 回归：内部故障不能再被当成「这本故事书不见了」。
 * 原实现用 /不可用|没找到|不存在/ 兜底，任何带这些字的报错都会被归成 STORY_NOT_FOUND，
 * 真实故障因此被掩盖，排查会走偏。
 */
test('意料之外的内部错误归为 STORY_BOOK_ERROR，不再误判成 STORY_NOT_FOUND',()=>{
  assert.equal(errorCode(new Error('数据库连接不可用')),'STORY_BOOK_ERROR');
  assert.equal(errorCode(new Error('集合 story_images 不存在')),'STORY_BOOK_ERROR');
  assert.equal(errorCode(new Error('临时密钥没找到')),'STORY_BOOK_ERROR');
});

test('其余错误码映射保持不变',()=>{
  assert.equal(errorCode(new Error('没有找到你的记录空间')),'AUTH_REQUIRED');
  assert.equal(errorCode(new Error('已有更新，请重新加载')),'VERSION_CONFLICT');
  assert.equal(errorCode(new Error('已有同名故事，请换一个名称')),'DUPLICATE_TITLE');
  assert.equal(errorCode(Object.assign(new Error('无权访问'),{code:'STORY_FORBIDDEN'})),'STORY_FORBIDDEN');
  assert.equal(errorCode(new Error('未知故障')),'STORY_BOOK_ERROR');
});


/*
 * 回归：名字占用只在改名时释放，删除人物时从不释放。
 * 今天没咬人只因为人物仅有软删除、记录还留在名单里；一旦人物记录真的不在了，
 * 遗留的占用会把这个名字永久挡住，报错还指向一个用户看不见的人。
 */
test('人物记录已不在名单里时，遗留的名字占用不再把名字挡死',async()=>{
  const {handlers:h,tables}=fixture(),ctx={familyId:'family_test'};
  tables.set('families:family_test',{roomName:'服务端房间',storyBooks:{status:'active',version:1},
    memberNameClaims:{[core.hash('小敏')]:{name:'小敏',memberId:'ghost-1'}}});
  tables.set('family_members:family_test_owner',{familyId:'family_test',memberId:'owner',name:'测试者',relation:'自己',role:'owner',avatarText:'测',kind:'recording-profile'});

  await h.memberAdd(ctx,{memberId:'member-min',name:'小敏',relation:'朋友',kind:'person'});

  assert.equal(tables.get('family_members:family_test_member-min').name,'小敏');
  assert.deepEqual(tables.get('families:family_test').memberNameClaims[core.hash('小敏')],
    {name:'小敏',memberId:'member-min'},'陈旧占用应被新人物接管');
});

test('占用方确实还在名单里时，同名依然被拒',async()=>{
  const {handlers:h,tables}=fixture(),ctx={familyId:'family_test'};
  tables.set('families:family_test',{roomName:'服务端房间',storyBooks:{status:'active',version:1},
    memberNameClaims:{[core.hash('小敏')]:{name:'小敏',memberId:'member-held'}}});
  tables.set('family_members:family_test_owner',{familyId:'family_test',memberId:'owner',name:'测试者',relation:'自己',role:'owner',avatarText:'测',kind:'recording-profile'});
  tables.set('family_members:family_test_member-held',{familyId:'family_test',memberId:'member-held',name:'小敏',relation:'朋友',kind:'person'});

  await assert.rejects(()=>h.memberAdd(ctx,{memberId:'member-new',name:'小敏',relation:'朋友',kind:'person'}),
    error=>error.code==='MEMBER_CONFLICT');
});
