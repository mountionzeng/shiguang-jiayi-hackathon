const { createHandlers } = require('./flow');
const { measurePerformance } = require('./performance');
const { resolveStoryIdentity, assertSpaceOwner, identityError } = require('./identity');
const { readAuthorizedStory } = require('./access');
const { createInvitationService } = require('./invitations');
const { readStoryMedia } = require('./media');
const { shareExcerpt } = require('./excerpts');
const { editAuthorizedChapter } = require('./collaboration');
const { receiveTextCopy, appendOwnExperience } = require('./copies');
const { receiveMediaCopy } = require('./copyMedia');
const { sendOwnReturn, listReturns, decideReturn } = require('./returns');
const { listShareCardSource, previewShareCard, exportShareCard } = require('./exports');
const { previewBookExport, exportBookImages } = require('./bookExports');
const { memoryExportSource } = require('./memoryExports');

function accessError(code) {
  return Object.assign(new Error(code === 'STORY_ACCESS_NOT_READY' ? '故事权限服务尚未准备好' : '故事共享尚未开放'), { code });
}

function createStoryService(repo, options = {}) {
  const accessEnabled = options.accessEnabled === true;
  const canaryFamilies = new Set(options.sharedReadFamilyIds || []);
  const invitations = createInvitationService(repo, options);
  async function dispatch(context, event = {}) {
    const measure = event?.action === 'state' ? measurePerformance : (_operation,work)=>work();
    if (!context || typeof context.OPENID !== 'string' || !/^[0-9A-Za-z_-]{1,128}$/.test(context.OPENID)) throw identityError('AUTH_REQUIRED');
    if (accessEnabled && options.rulesReady !== true) throw accessError('STORY_ACCESS_NOT_READY');
    const ctx = accessEnabled
      ? {...await measure('state.identity',()=>resolveStoryIdentity(repo, context, { bootstrapAppId: options.bootstrapAppId })),verifiedOpenid:context.OPENID}
      : { familyId: `family_${context.OPENID}`, verifiedOpenid: context.OPENID };
    const action = String(event?.action || '');
    if (action === 'capabilities') {
      return { apiVersion: 1, independentStories: true, identityVersion: accessEnabled ? 1 : 0,
        familyId: accessEnabled ? ctx.familyId : undefined,
        invitations: accessEnabled && options.invitationsEnabled === true && canaryFamilies.has(ctx.familyId),
        sharedRead: accessEnabled && canaryFamilies.has(ctx.familyId),
        excerptShare: accessEnabled && options.excerptSharingEnabled === true && canaryFamilies.has(ctx.familyId),
        sharedEdit: accessEnabled && options.sharedEditEnabled === true && canaryFamilies.has(ctx.familyId),
        copy: accessEnabled && options.copyReceiveEnabled === true && canaryFamilies.has(ctx.familyId),
        bookExport: accessEnabled && options.shareCardEnabled === true && canaryFamilies.has(ctx.familyId),
        memoryBookExport: true,
        shareCard: accessEnabled && options.shareCardEnabled === true && canaryFamilies.has(ctx.familyId), forward: false, publish: false };
    }
    if (action.startsWith('invite')) {
      if (!accessEnabled || options.invitationsEnabled !== true) throw accessError('STORY_ACCESS_DISABLED');
      return invitations(ctx, event);
    }
    if (action === 'sharedMedia') {
      if (!accessEnabled || options.sharedMediaEnabled !== true || !canaryFamilies.has(ctx.familyId) || !canaryFamilies.has(event.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return readStoryMedia(repo,ctx,event,options.signMedia);
    }
    if (action === 'sharedRead') {
      if (!accessEnabled || !canaryFamilies.has(ctx.familyId) || !canaryFamilies.has(event.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      const result = await readAuthorizedStory(repo, ctx, event, {sharedEditEnabled:options.sharedEditEnabled === true,copyReceiveEnabled:options.copyReceiveEnabled === true});
      result.capabilities.requestInvitation = options.invitationsEnabled === true && result.capabilities.requestInvitation;
      return result;
    }
    if (action === 'copyReceive') {
      if (!accessEnabled || options.copyReceiveEnabled !== true || !canaryFamilies.has(ctx.familyId) || !canaryFamilies.has(event.sourceFamilyId)) throw accessError('STORY_ACCESS_DISABLED');
      const input={sourceFamilyId:event.sourceFamilyId,sourceStoryId:event.sourceStoryId,sourceRevisionId:event.sourceRevisionId,
        chapterIds:event.chapterIds,requestId:event.requestId,target:event.target};
      try{return await receiveTextCopy(repo,ctx,input,{now:options.now});}
      catch(error){
        if(error?.code!=='STORY_COPY_MEDIA_PENDING')throw error;
        if(!options.copyStorage)throw accessError('STORY_ACCESS_NOT_READY');
        return receiveMediaCopy(repo,ctx,input,options.copyStorage,{nowMs:options.nowMs});
      }
    }
    if (action === 'copyAppendOwn') {
      if (!accessEnabled || options.copyReceiveEnabled !== true || !canaryFamilies.has(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return appendOwnExperience(repo,ctx,{storyId:event.storyId,revisionId:event.revisionId,expectedVersion:event.expectedVersion,
        chapterId:event.chapterId,text:event.text,requestId:event.requestId},{now:options.now});
    }
    if (action === 'copyReturnOwn') {
      if (!accessEnabled || options.copyReceiveEnabled !== true || !canaryFamilies.has(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return sendOwnReturn(repo,ctx,{storyId:event.storyId,revisionId:event.revisionId,expectedVersion:event.expectedVersion,
        chapterId:event.chapterId,requestId:event.requestId},{now:options.now});
    }
    if (action === 'copyReturns') {
      if (!accessEnabled || options.copyReceiveEnabled !== true || !canaryFamilies.has(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return listReturns(repo,ctx);
    }
    if (action === 'copyReturnDecision') {
      if (!accessEnabled || options.copyReceiveEnabled !== true || !canaryFamilies.has(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return decideReturn(repo,ctx,{returnId:event.returnId,decision:event.decision,requestId:event.requestId},{now:options.now});
    }
    if (action === 'sharedEdit') {
      if (!accessEnabled || options.sharedEditEnabled !== true || !canaryFamilies.has(ctx.familyId) || !canaryFamilies.has(event.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return editAuthorizedChapter(repo,ctx,{familyId:event.familyId,storyId:event.storyId,chapterId:event.chapterId,
        revisionId:event.revisionId,expectedVersion:event.expectedVersion,requestId:event.requestId,title:event.title,textBlocks:event.textBlocks},
      {approve:options.approveSharedEdit});
    }
    if (action === 'shareExcerpt') {
      if (!accessEnabled || options.excerptSharingEnabled !== true || !canaryFamilies.has(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      const input={storyId:event.storyId,revisionId:event.revisionId,expectedVersion:event.expectedVersion,
        chapterId:event.chapterId,text:event.text,recipientMemberIds:event.recipientMemberIds,requestId:event.requestId};
      return shareExcerpt(repo,ctx,input,{approve:options.approveExcerpt});
    }
    if (action === 'bookExportPreview' || action === 'bookExportImages') {
      const memoryExport = event.sourceKind === 'memory';
      if (memoryExport) {
        if (accessEnabled) await assertSpaceOwner(repo, ctx);
      } else if (!accessEnabled || options.shareCardEnabled !== true || !canaryFamilies.has(ctx.familyId)) {
        throw accessError('STORY_ACCESS_DISABLED');
      }
      const input = memoryExport
        ? { familyId: ctx.familyId, sourceKind: 'memory', memoryId: event.memoryId,
          ...(event.revisionId !== undefined ? { revisionId: event.revisionId } : {}),
          expectedSourceVersion: event.expectedSourceVersion,
          ...(event.targetTextImageCount !== undefined ? { targetTextImageCount: event.targetTextImageCount } : {}) }
        : { familyId: ctx.familyId, storyId: event.storyId, revisionId: event.revisionId, expectedVersion: event.expectedVersion,
          scope: event.scope, chapterIds: event.chapterIds, ...(event.excerpt !== undefined ? { excerpt: event.excerpt } : {}),
          ...(event.coverImageIds !== undefined ? { coverImageIds: event.coverImageIds } : {}),
          ...(event.targetTextImageCount !== undefined ? { targetTextImageCount: event.targetTextImageCount } : {}) };
      return action === 'bookExportPreview' ? previewBookExport(repo, ctx, input, { approve: options.approveShareCard })
        : exportBookImages(repo, ctx, { ...input, descriptorId: event.descriptorId }, { approve: options.approveShareCard, sign: options.signMedia });
    }
    if (action === 'memoryExportSource') {
      if (accessEnabled) await assertSpaceOwner(repo, ctx);
      const result = await memoryExportSource(repo, ctx, {
        memoryId: event.memoryId,
        ...(event.revisionId !== undefined ? { revisionId: event.revisionId } : {}),
        ...(event.expectedSourceVersion !== undefined ? { expectedSourceVersion: event.expectedSourceVersion } : {}),
      });
      if (accessEnabled) await assertSpaceOwner(repo, ctx);
      return result;
    }
    if (action === 'shareCardSource') {
      if (!accessEnabled || options.shareCardEnabled !== true || !canaryFamilies.has(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      if (!canaryFamilies.has(event.familyId || ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return listShareCardSource(repo,ctx,{familyId:event.familyId || ctx.familyId,storyId:event.storyId});
    }
    if (action === 'shareCardPreview') {
      if (!accessEnabled || options.shareCardEnabled !== true || !canaryFamilies.has(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      if (!canaryFamilies.has(event.familyId || ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return previewShareCard(repo,ctx,{familyId:event.familyId || ctx.familyId,storyId:event.storyId,revisionId:event.revisionId,
        chapterId:event.chapterId,blockIds:event.blockIds,photoIds:event.photoIds},{approve:options.approveShareCard});
    }
    if (action === 'shareCardExport') {
      if (!accessEnabled || options.shareCardEnabled !== true || !canaryFamilies.has(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      if (!canaryFamilies.has(event.familyId || ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return exportShareCard(repo,ctx,{familyId:event.familyId || ctx.familyId,storyId:event.storyId,revisionId:event.revisionId,
        chapterId:event.chapterId,blockIds:event.blockIds,photoIds:event.photoIds,descriptorId:event.descriptorId},
      {approve:options.approveShareCard,sign:options.signMedia});
    }
    if (accessEnabled) await measure('state.authorize.before',()=>assertSpaceOwner(repo, ctx));
    // Existing commands remain owner-only. Revalidate on EVERY transaction,
    // including migration batches and idempotent replay, not just at dispatch.
    const guardedRepo = accessEnabled ? { ...repo, transaction: operation => repo.transaction(async tx => {
      await assertSpaceOwner(tx, ctx);
      return operation(tx);
    }) } : repo;
    const handlers = createHandlers(guardedRepo, options);
    let result;
    if (action === 'state') result = await measure('state.load',()=>handlers.state(ctx));
    else if (action === 'migrate') result = await handlers.migrate(ctx);
    else if (action === 'context') result = await handlers.aiContext(ctx, event);
    else if (action === 'memberAdd') result = await handlers.memberAdd(ctx, event);
    else if (action === 'memberUpdate') result = await handlers.memberUpdate(ctx, event);
    else if (action === 'memberDelete') result = await handlers.memberDelete(ctx, event);
    else if (action === 'memberRestore') result = await handlers.memberRestore(ctx, event);
    else if (action === 'roomProfileUpdate') result = await handlers.roomProfileUpdate(ctx, event);
    else result = await handlers.command(ctx, event);
    // Reads and already-acknowledged operations can return without a write
    // transaction. Do not release data if identity was revoked during the read.
    if (accessEnabled) await measure('state.authorize.after',()=>assertSpaceOwner(repo, ctx));
    return result;
  }
  return (context,event={}) => event?.action === 'state'
    ? measurePerformance('state.total',()=>dispatch(context,event))
    : dispatch(context,event);
}

module.exports = { createStoryService };
