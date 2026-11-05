const {approveOutgoingText}=require('./outgoingText');
const crypto = require('node:crypto');
const { PRINCIPAL_ID, FAMILY_ID, assertCurrentIdentity, identityError } = require('./identity');

const STORY_ID = /^story-[a-z0-9-]{1,100}$/;
const CHAPTER_ID = /^chapter-[a-z0-9-]{1,60}$/;
const ACTIONS = new Set(['read', 'edit', 'copy', 'forward', 'publish', 'manage']);
const DISTRIBUTION = new Set(['copy', 'forward', 'publish']);
const grantIdFor = (familyId, storyId, principalId) => crypto.createHash('sha256')
  .update(JSON.stringify([familyId, storyId, principalId])).digest('hex');

function validChapterIds(ids) {
  return Array.isArray(ids) && ids.length > 0 && ids.length <= 30 && new Set(ids).size === ids.length &&
    ids.every(id => typeof id === 'string' && CHAPTER_ID.test(id));
}

// No role implies additional rights. Source-bound distribution remains closed
// until the provenance verifier is implemented; ownership is not an exemption.
function evaluateStoryAccess({ principalId, ownerPrincipalId, story, grant, action, chapterIds, nowMs = Date.now() }) {
  if (!PRINCIPAL_ID.test(principalId || '') || !PRINCIPAL_ID.test(ownerPrincipalId || '') || !story ||
      !FAMILY_ID.test(story.familyId || '') || !STORY_ID.test(story.id || '') || story.deletedAt || !ACTIONS.has(action)) return false;
  if (DISTRIBUTION.has(action) && story.sourcePolicyRequired === true) return false;
  if (principalId === ownerPrincipalId) return true;
  if (!grant || grant.status !== 'active' || grant.principalId !== principalId || grant.ownerPrincipalId !== ownerPrincipalId ||
      grant.familyId !== story.familyId || grant.storyId !== story.id || !Number.isSafeInteger(grant.version) || grant.version < 1 ||
      !Number.isFinite(nowMs) || (grant.expiresAtMs !== undefined && (!Number.isFinite(grant.expiresAtMs) || grant.expiresAtMs <= nowMs))) return false;
  if (action === 'manage' || grant.permissions?.read !== true || grant.permissions?.[action] !== true || !validChapterIds(chapterIds)) return false;
  if (grant.scope?.type === 'story') return true;
  return grant.scope?.type === 'chapters' && validChapterIds(grant.scope.chapterIds) && chapterIds.every(id => grant.scope.chapterIds.includes(id));
}

async function readAuthorizedStory(repo, ctx, input, { approveText, now = Date.now, sharedEditEnabled = false, copyReceiveEnabled = false, signMedia } = {}) {
  if (!input || !FAMILY_ID.test(input.familyId || '') || !STORY_ID.test(input.storyId || '') ||
      (input.chapterIds !== undefined && !validChapterIds(input.chapterIds))) throw identityError();
  let requiresCheck=false;
  const load=()=>repo.transaction(async tx => {
    await assertCurrentIdentity(tx, ctx);
    const family = await tx.get('families', input.familyId);
    const space = await tx.get('story_principal_spaces', input.familyId);
    if (!family || family.storyBooks?.status !== 'active' || !space || space.status !== 'active' || family.ownerAccountId !== space.accountId) throw identityError();
    const story = await tx.get('stories', `${input.familyId}_${input.storyId}`);
    if (!story || story.id !== input.storyId || story.familyId !== input.familyId || story.deletedAt) throw identityError();
    const grant = await tx.get('story_grants', grantIdFor(input.familyId, input.storyId, ctx.principalId));
    // Check the grant before loading any manuscript, even for callers guessing
    // valid revision IDs. Only the current revision is ever considered.
    const preliminaryIds = input.chapterIds || (grant?.scope?.type === 'chapters' ? grant.scope.chapterIds : ['chapter-check']);
    const check = chapterIds => evaluateStoryAccess({ principalId: ctx.principalId, ownerPrincipalId: space.principalId,
      story, grant, action: 'read', chapterIds, nowMs: now() });
    if (!check(preliminaryIds) || typeof story.currentRevisionId !== 'string' || !/^revision-[a-zA-Z0-9-]{1,120}$/.test(story.currentRevisionId)) throw identityError();
    const record = await tx.get('biography_drafts', `${input.familyId}_${story.currentRevisionId}`);
    if (!record || record.familyId !== input.familyId || record.storyId !== story.id ||
        record.revision?.id !== story.currentRevisionId || record.revision.storyId !== story.id || !Array.isArray(record.revision.draft?.chapters)) throw identityError();
    const allChapters = record.revision.draft.chapters;
    const chapterIds = input.chapterIds || (grant?.scope?.type === 'chapters' && ctx.principalId !== space.principalId
      ? grant.scope.chapterIds : allChapters.map(chapter => chapter.id));
    if (!validChapterIds(chapterIds) || !check(chapterIds) || chapterIds.some(id => !allChapters.some(chapter => chapter.id === id))) throw identityError();
    const chapters = allChapters.filter(chapter => chapterIds.includes(chapter.id)).map(chapter => ({
      id: chapter.id, title: chapter.title,
      content: chapter.content.map(item => typeof item.text === 'string' ? { text: item.text } : signMedia ? {photoId:item.photoId} : { text: '〔图片共享尚未开放〕' }),
      ...(signMedia?{memoryIds:chapter.memoryIds || [],...(chapter.backdropImageId?{backdropKey:'backdrop:'+chapter.id}:{})}:{}),
      textBlocks: chapter.content.flatMap((item,index) => typeof item.text === 'string' && item.photoId === undefined ? [{index,text:item.text}] : []),
    }));
    requiresCheck=ctx.principalId!==space.principalId;
    const canEdit = sharedEditEnabled === true && chapterIds.every(chapterId => evaluateStoryAccess({principalId:ctx.principalId,
      ownerPrincipalId:space.principalId,story,grant,action:'edit',chapterIds:[chapterId],nowMs:now()}));
    const canCopy = copyReceiveEnabled === true && ctx.familyId !== input.familyId && chapterIds.every(chapterId => evaluateStoryAccess({principalId:ctx.principalId,
      ownerPrincipalId:space.principalId,story,grant,action:'copy',chapterIds:[chapterId],nowMs:now()}));
    const materials=signMedia?await require('./sharedMaterials').storyMaterials(tx,{source:story,sourceFamily:family,selected:allChapters.filter(c=>chapterIds.includes(c.id))}):undefined;
    return {
      ...(materials?{materials}:{}),
      story: { id: story.id, title: story.bookTitle || story.title, version: story.version },
      revisionId: story.currentRevisionId, chapters,
      draftScope: crypto.createHash('sha256').update(JSON.stringify([ctx.principalId,input.familyId,input.storyId])).digest('hex').slice(0,32),
      capabilities: { sharedTextRead: true, sharedEdit: canEdit, mediaRead: !!signMedia, copy: canCopy, forward: false, publish: false,
        requestInvitation: evaluateStoryAccess({principalId:ctx.principalId,ownerPrincipalId:space.principalId,story,grant,action:'forward',chapterIds,nowMs:now()}) },
    };
  });
  const result=await load();
  if(requiresCheck)await approveOutgoingText(approveText,ctx,result.story.title,[...result.chapters,...(result.materials?.memories || []).map(m=>({title:m.title,content:[{text:m.text}]}))]);
  if(signMedia){
    const media={};
    const files=[...new Set(result.materials.assets.map(a=>a.sourceFileID))];
    for(let i=0;i<files.length;i+=4)await Promise.all(files.slice(i,i+4).map(async file=>{
      const url=await signMedia(file,300);
      if(typeof url!=='string' || !url.startsWith('https://'))throw identityError();
      for(const asset of result.materials.assets)if(asset.sourceFileID===file)media[asset.key]=url;
    }));
    const after=await load();
    if(JSON.stringify(after)!==JSON.stringify(result))throw Object.assign(new Error('故事已有更新，请重新打开'),{code:'VERSION_CONFLICT'});
    const {materials,...publicResult}=result;
    return {...publicResult,media,coverUrl:media[materials.coverKey] || '',memories:materials.memories};
  }
  return result;
}

module.exports = { evaluateStoryAccess, grantIdFor, readAuthorizedStory };
