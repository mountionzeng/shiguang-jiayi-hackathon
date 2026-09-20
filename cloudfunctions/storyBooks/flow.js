const core = require('./core');
const { assertLegacyWritable, protocolError } = require('./provenance');
const docId = (familyId,id) => familyId+'_'+id;
const MIGRATION_BATCH_SIZE=80;
function createHandlers(repo, {migrationReady = false, migrationFamilyIds = null, now = ()=>new Date().toISOString()} = {}) {
  async function assertLegacyTransaction(tx, familyId, story) {
    if (!story) return;
    assertLegacyWritable(story);
    if (story.currentRevisionId) {
      const record=await tx.get('biography_drafts',docId(familyId,story.currentRevisionId));
      if (!record || record.familyId!==familyId || record.storyId!==story.id || record.revision?.id!==story.currentRevisionId || record.revision.storyId!==story.id) throw protocolError();
      assertLegacyWritable(story,record.revision.draft);
    }
  }
  const migrationTables=['stories','story_names','biography_drafts','story_migration_items','story_image_links','story_image_job_links'];
  const legacySource = source => ({
    contributions:[...(source.contributions || [])].sort((a,b)=>String(a.id).localeCompare(String(b.id))),
    deletedStories:[...(source.deletedStories || [])].sort((a,b)=>String(a.key).localeCompare(String(b.key))),
    legacyPersonalDrafts:source.legacyPersonalDrafts || {},
    personalDrafts:source.personalDrafts || {},
    manuscriptRevisions:[...(source.manuscriptRevisions || [])].filter(r=>!r.storyId).sort((a,b)=>String(a.id).localeCompare(String(b.id))),
    legacyImages:[...(source.legacyImages || [])].filter(image=>!image.storyId).sort((a,b)=>String(a._id).localeCompare(String(b._id))),
    legacyImageJobs:[...(source.legacyImageJobs || [])].filter(job=>!job.storyId).sort((a,b)=>String(a._id).localeCompare(String(b._id))),
  });
  const sourceDigest = source => core.hash(core.stable(legacySource(source)));
  async function load(ctx,{includeMemories=true,includeMigrationSources=false}={}) {
    const family = await repo.get('families',ctx.familyId);
    if (!family) throw new Error('没有找到你的记录空间');
    const [stories,drafts,pending,memories,legacyImages,legacyImageJobs] = await Promise.all([
      repo.all('stories',ctx.familyId),repo.all('biography_drafts',ctx.familyId),repo.all('story_migration_items',ctx.familyId),
      includeMemories ? repo.all('memories',ctx.familyId) : [],
      includeMigrationSources ? repo.all('story_images',ctx.familyId) : [],
      includeMigrationSources ? repo.all('image_jobs',ctx.familyId) : [],
    ]);
    const contributions=memories.map(m=>({...m,id:m.frontendContributionId || m.id || m.sourceRecordId?.replace(/^src_/,'')?.replace(ctx.familyId+'_','') || m._id?.replace(ctx.familyId+'_','')}));
    const visibleStories=stories.map(({_id,migrationSourceDigest,migrationDocumentId,...story})=>story);
    const state={roomName:family.roomName || '',protagonistName:'',members:[],contributions,stories:visibleStories,deletedStories:family.deletedStories || [],
      manuscriptRevisions:drafts.filter(d=>d.revision).map(d=>d.revision),
      legacyPersonalDrafts:Object.fromEntries(drafts.filter(d=>d.draftType==='personal' && d.memberId && d.draft).map(d=>[d.memberId,d.draft])),legacyImages,legacyImageJobs};
    if (family.storyBooks) state.storyMigration={...family.storyBooks,pending:pending.map(p=>p.item)};
    return state;
  }
  async function state(ctx) {
    const loaded=await load(ctx,{includeMemories:false});
    if (loaded.storyMigration?.status!=='active') return {storyMigration:loaded.storyMigration,stories:[]};
    return {storyMigration:loaded.storyMigration,stories:loaded.stories,manuscriptRevisions:loaded.manuscriptRevisions.filter(r=>r.storyId)};
  }
  async function command(ctx,event) {
    const input={...event,familyId:ctx.familyId}, previous=await load(ctx);
    const previousStory=previous.stories.find(story=>story.id===input.storyId);
    const guardsContent=!['delete','restore'].includes(input.action);
    if (guardsContent && previousStory) assertLegacyWritable(previousStory,core.current(previous,previousStory.id).draft);
    if (input.revision?.draft) assertLegacyWritable({},input.revision.draft);
    const opId=docId(ctx.familyId,String(input.requestId)), savedOp=await repo.get('story_operations',opId);
    if(savedOp) {
      if(savedOp.fingerprint!==core.stable(input))throw new Error('请求编号冲突');
      return {ok:true,storyId:savedOp.storyId};
    }
    if(input.action==='resolveAsset') {
      if(typeof input.requestId!=='string' || !/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId))throw new Error('请求编号无效');
      return repo.transaction(async tx=>{
        const family=await tx.get('families',ctx.familyId);
        if(family?.storyBooks?.status!=='active')throw new Error('故事书迁移尚未完成');
        const retry=await tx.get('story_operations',opId);
        if(retry) {
          if(retry.fingerprint!==core.stable(input))throw new Error('请求编号冲突');
          return {ok:true,storyId:retry.storyId};
        }
        const storyId=String(input.storyId || ''), storyDocId=docId(ctx.familyId,storyId);
        const story=await tx.get('stories',storyDocId);
        if(!story || story.deletedAt)throw Object.assign(new Error('这本故事书已不可用，请返回书架'),{code:'STORY_NOT_FOUND'});
        await assertLegacyTransaction(tx,ctx.familyId,story);
        if(story.version!==input.expectedVersion)throw new Error('故事已有更新，请刷新后重试');
        const pendingId=docId(ctx.familyId,String(input.pendingId || '')), pending=await tx.get('story_migration_items',pendingId);
        if(!pending || pending.item.resolvedStoryId || !['image','image-job'].includes(pending.item.kind))throw new Error('此迁移资源已处理，请刷新');
        if(pending.item.kind==='image') {
          const image=await tx.get('story_images',pending.item.imageId);
          if(!image || image.familyId!==ctx.familyId || image.deletedAtMs!==undefined)throw Object.assign(new Error('这张旧图已不可用'),{code:'STORY_NOT_FOUND'});
          const linkId=docId(ctx.familyId,core.hash(storyId+'|'+pending.item.imageId));
          await tx.set('story_image_links',linkId,{familyId:ctx.familyId,storyId,imageId:pending.item.imageId});
          story.imageIds=[...new Set([...(story.imageIds || []),pending.item.imageId])];
        } else {
          const job=await tx.get('image_jobs',pending.item.jobId);
          if(!job || job.familyId!==ctx.familyId)throw Object.assign(new Error('这项旧配图任务已不可用'),{code:'STORY_NOT_FOUND'});
          const linkId=docId(ctx.familyId,core.hash(storyId+'|'+pending.item.jobId));
          await tx.set('story_image_job_links',linkId,{familyId:ctx.familyId,storyId,jobId:pending.item.jobId});
        }
        pending.item.resolvedStoryId=storyId;
        story.version++;story.updatedAt=now();
        await tx.set('story_migration_items',pendingId,pending);
        await tx.set('stories',storyDocId,story);
        await tx.set('story_operations',opId,{familyId:ctx.familyId,fingerprint:core.stable(input),storyId});
        return {ok:true,storyId};
      });
    }
    const next=core.apply(previous,input,now()), story=core.activeStory(next,input.storyId,true);
    const before=previous.stories.find(s=>s.id===story.id);
    const newRevision=next.manuscriptRevisions?.find(r=>r.id===story.currentRevisionId && !(previous.manuscriptRevisions || []).some(old=>old.id===r.id));
    if (newRevision) assertLegacyWritable(story,newRevision.draft);
    const imageRefs=newRevision ? new Set(newRevision.draft.chapters.flatMap(c=>[...(c.backdropImageId?[c.backdropImageId]:[]),...c.content.flatMap(i=>i.photoId?.startsWith('photo-ai-')?[ctx.familyId+'_img_'+i.photoId.slice(9)]:[])])) : new Set();
    return repo.transaction(async tx=>{
      const family=await tx.get('families',ctx.familyId);
      if(family?.storyBooks?.status!=='active')throw new Error('故事书迁移尚未完成');
      const retry=await tx.get('story_operations',opId);
      if(retry) {
        if(retry.fingerprint!==core.stable(input))throw new Error('请求编号冲突');
        return {ok:true,storyId:retry.storyId};
      }
      const stored=await tx.get('stories',docId(ctx.familyId,story.id));
      if (guardsContent) await assertLegacyTransaction(tx,ctx.familyId,stored);
      if((before && (!stored || stored.version!==before.version)) || (!before && stored))throw new Error('故事已有更新，请刷新后重试');
      for(const id of imageRefs) {
        const image=await tx.get('story_images',id);
        const link=await tx.get('story_image_links',docId(ctx.familyId,core.hash(story.id+'|'+id)));
        if(!image || image.familyId!==ctx.familyId || (image.storyId!==story.id && !(story.imageIds || []).includes(id) && link?.storyId!==story.id) || image.deletedAtMs!==undefined)throw Object.assign(new Error('书稿引用了不可用或其他故事的插图'),{code:'STORY_NOT_FOUND'});
      }
      if(imageRefs.size)story.imageIds=[...new Set([...(story.imageIds || []),...imageRefs])];
      const nameId=docId(ctx.familyId,core.hash(story.title)),name=await tx.get('story_names',nameId);
      if(!story.deletedAt && name && name.storyId!==story.id)throw new Error('已有同名故事，请换一个名称');
      if(before && (before.title!==story.title || story.deletedAt)) {
        const oldId=docId(ctx.familyId,core.hash(before.title)),old=await tx.get('story_names',oldId);
        if(old?.storyId===story.id)await tx.remove('story_names',oldId);
      }
      if(!story.deletedAt)await tx.set('story_names',nameId,{familyId:ctx.familyId,storyId:story.id,title:story.title});
      if(input.action==='resolve') {
        const id=docId(ctx.familyId,input.pendingId), pending=await tx.get('story_migration_items',id);
        if(!pending || pending.item.resolvedStoryId)throw new Error('此章节已处理，请刷新');
        await tx.set('story_migration_items',id,{familyId:ctx.familyId,item:next.storyMigration.pending.find(p=>p.id===input.pendingId)});
      }
      if(newRevision)await tx.set('biography_drafts',docId(ctx.familyId,newRevision.id),{familyId:ctx.familyId,storyId:story.id,draftType:'story-revision',revision:newRevision});
      await tx.set('stories',docId(ctx.familyId,story.id),story);
      await tx.set('story_operations',opId,{familyId:ctx.familyId,fingerprint:core.stable(input),storyId:story.id});
      return {ok:true,storyId:story.id};
    });
  }
  async function migrate(ctx) {
    if(!migrationReady)throw new Error('新版故事库正在准备，请保留现有内容，稍后再试');
    if(Array.isArray(migrationFamilyIds) && !migrationFamilyIds.includes(ctx.familyId))throw new Error('这个账号尚未进入故事书迁移测试范围');
    let family=await repo.get('families',ctx.familyId);
    if(family?.storyBooks?.status==='active')return {status:'active'};
    if(!family)throw new Error('请先创建记录档案');
    let source=await load(ctx,{includeMigrationSources:true}), digest=sourceDigest(source);
    await repo.transaction(async tx=>{
      const latest=await tx.get('families',ctx.familyId);
      if(!latest.storyBooks)await tx.set('families',ctx.familyId,{...latest,storyBooks:{version:1,status:'preparing',cursor:0,sourceDigest:digest,startedAt:now()}});
      else if(latest.storyBooks.status!=='active' && latest.storyBooks.sourceDigest!==digest)await tx.set('families',ctx.familyId,{...latest,storyBooks:{...latest.storyBooks,status:'restarting',cursor:0,nextSourceDigest:digest}});
      else if(latest.storyBooks.status==='restarting' && latest.storyBooks.nextSourceDigest!==digest)await tx.set('families',ctx.familyId,{...latest,storyBooks:{...latest.storyBooks,nextSourceDigest:digest}});
    });
    family=await repo.get('families',ctx.familyId);
    if(family.storyBooks.status==='restarting') {
      const oldDigest=family.storyBooks.sourceDigest;
      const staged=(await Promise.all(migrationTables.map(async table=>(await repo.all(table,ctx.familyId))
        .filter(row=>row.migrationSourceDigest===oldDigest && row.migrationDocumentId)
        .map(row=>[table,row.migrationDocumentId])))).flat();
      const batch=staged.slice(0,MIGRATION_BATCH_SIZE);
      if(batch.length) {
        await repo.transaction(async tx=>{
          const latest=await tx.get('families',ctx.familyId);
          if(latest.storyBooks?.status!=='restarting' || latest.storyBooks.sourceDigest!==oldDigest)throw new Error('迁移清理状态已变化，请重试');
          for(const [table,id] of batch)await tx.remove(table,id);
        });
        return {status:'restarting',processed:batch.length,remaining:Math.max(0,staged.length-batch.length)};
      }
      source=await load(ctx,{includeMigrationSources:true}); digest=sourceDigest(source);
      await repo.transaction(async tx=>{
        const latest=await tx.get('families',ctx.familyId);
        if(latest.storyBooks?.status!=='restarting' || latest.storyBooks.sourceDigest!==oldDigest)throw new Error('迁移重启状态已变化，请重试');
        await tx.set('families',ctx.familyId,{...latest,storyBooks:{version:latest.storyBooks.version || 1,status:'preparing',cursor:0,sourceDigest:digest,startedAt:now()}});
      });
      family=await repo.get('families',ctx.familyId);
    }
    source=await load(ctx,{includeMigrationSources:true}); digest=sourceDigest(source);
    if(family.storyBooks.sourceDigest!==digest)return migrate(ctx);
    const snapshot=legacySource(source);
    const planned=core.migrate({...source,...snapshot,stories:[]},ctx.familyId,family.storyBooks.startedAt);
    const chapterOwners=new Map();
    for(const revision of planned.manuscriptRevisions.filter(revision=>revision.storyId))for(const chapter of revision.draft.chapters || []) {
      const owners=chapterOwners.get(chapter.id) || new Set();owners.add(revision.storyId);chapterOwners.set(chapter.id,owners);
    }
    const ownersFor=(record,id)=>{
      const owners=new Set();
      for(const story of planned.stories)if((story.imageIds || []).includes(id))owners.add(story.id);
      for(const owner of chapterOwners.get(record.chapterId) || [])owners.add(owner);
      return [...owners];
    };
    const assetPending=[],imageLinks=[],jobLinks=[];
    for(const image of snapshot.legacyImages) {
      const imageId=image._id || image.imageId, owners=ownersFor(image,imageId);
      if(owners.length===1)imageLinks.push({familyId:ctx.familyId,storyId:owners[0],imageId});
      else assetPending.push({id:'pending-image-'+core.hash(imageId),kind:'image',imageId,reason:owners.length?'这张旧图被多本故事引用，需要保留共享关系':'这张旧图没有唯一的章节归属'});
    }
    const pendingJobStatuses=new Set(['submitted','queued','generating','generated','storing','unknown','expired']);
    for(const job of snapshot.legacyImageJobs.filter(job=>pendingJobStatuses.has(job.status))) {
      const jobId=job._id || job.jobId, owners=ownersFor(job,'');
      if(owners.length===1)jobLinks.push({familyId:ctx.familyId,storyId:owners[0],jobId});
      else assetPending.push({id:'pending-job-'+core.hash(jobId),kind:'image-job',jobId,status:job.status,reason:owners.length?'这项旧配图任务涉及多本故事':'这项旧配图任务没有唯一的章节归属'});
    }
    const staged=(table,id,value)=>[table,id,{...value,migrationSourceDigest:digest,migrationDocumentId:id}];
    const rows=[
      ...planned.stories.map(s=>staged('stories',docId(ctx.familyId,s.id),s)),
      ...planned.stories.filter(s=>!s.deletedAt).map(s=>{const id=docId(ctx.familyId,core.hash(s.title));return staged('story_names',id,{familyId:ctx.familyId,storyId:s.id,title:s.title});}),
      ...planned.manuscriptRevisions.filter(r=>r.storyId).map(r=>{const id=docId(ctx.familyId,r.id);return staged('biography_drafts',id,{familyId:ctx.familyId,storyId:r.storyId,draftType:'story-revision',revision:r});}),
      ...[...planned.storyMigration.pending,...assetPending].map(item=>{const id=docId(ctx.familyId,item.id);return staged('story_migration_items',id,{familyId:ctx.familyId,item});}),
      ...imageLinks.map(link=>{const id=docId(ctx.familyId,core.hash(link.storyId+'|'+link.imageId));return staged('story_image_links',id,link);}),
      ...jobLinks.map(link=>{const id=docId(ctx.familyId,core.hash(link.storyId+'|'+link.jobId));return staged('story_image_job_links',id,link);}),
    ];
    return repo.transaction(async tx=>{
      const latest=await tx.get('families',ctx.familyId);
      if(latest.storyBooks.status==='active')return {status:'active'};
      if(latest.storyBooks.sourceDigest!==digest)throw new Error('迁移来源已变化，不能激活旧快照');
      const cursor=latest.storyBooks.cursor;
      for(const [table,id,value] of rows.slice(cursor,cursor+MIGRATION_BATCH_SIZE))await tx.set(table,id,value);
      const end=Math.min(cursor+MIGRATION_BATCH_SIZE,rows.length),status=end===rows.length?'active':'preparing';
      await tx.set('families',ctx.familyId,{...latest,storyBooks:{...latest.storyBooks,cursor:end,status,total:rows.length,sourceDigest:digest}});
      return {status,processed:end,total:rows.length};
    });
  }
  async function aiContext(ctx,event) {
    const loaded=await load(ctx),story=core.activeStory(loaded,event.storyId);
    if(loaded.storyMigration?.status!=='active')throw new Error('故事库尚未准备好');
    assertLegacyWritable(story,core.current(loaded,story.id).draft);
    if(story.writingMode!=='creative' && event.purpose!=='image')throw new Error('这本书当前使用客观记录');
    const requested=event.memoryIds || story.memoryIds;
    if(!Array.isArray(requested) || requested.some(id=>!story.memoryIds.includes(id)))throw new Error('不能引用其他故事的记忆');
    return {story,draft:core.current(loaded,story.id).draft,memories:loaded.contributions.filter(m=>requested.includes(m.id) && !m.deletedAt && m.scope==='personal'),fingerprint:core.fingerprint(loaded,story.id)};
  }
  return {state,command,migrate,aiContext};
}
module.exports={createHandlers};
