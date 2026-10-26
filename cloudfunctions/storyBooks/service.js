const { accountActivity } = require('./accountActivity');
const { saveArticle } = require('./article');
const { createHandlers } = require('./flow');
const { measurePerformance } = require('./performance');
const { resolveStoryIdentity, assertSpaceOwner, identityError } = require('./identity');
const { readAuthorizedStory } = require('./access');
const { createInvitationService } = require('./invitations');
const { isRolledOut } = require('./rollout');
const { readStoryMedia } = require('./media');
const { shareExcerpt } = require('./excerpts');
const { editAuthorizedChapter } = require('./collaboration');
const { listChapterChanges } = require('./changes');
const { receiveTextCopy, appendOwnExperience } = require('./copies');
const { receiveMediaCopy } = require('./copyMedia');
const { sendOwnReturn, listReturns, decideReturn } = require('./returns');
const { importChapterPackage, reviseReceivedChapter } = require('./chapterPackage');
const { listShareCardSource, previewShareCard, exportShareCard } = require('./exports');
const { previewBookExport, exportBookImages } = require('./bookExports');
const { memoryExportSource } = require('./memoryExports');
const { encodeStateResponse } = require('./stateTransport');
const { readHistory } = require('./history');
const { prepareInvitation } = require('./prepareInvitation');

function accessError(code) {
  return Object.assign(new Error(code === 'STORY_ACCESS_NOT_READY' ? '故事权限服务尚未准备好' : '故事共享尚未开放'), { code });
}

async function approveArticleImage(repo, ctx, id, storyId, chapterId, purpose = 'illustration') {
  if (/^photo-ai-req-[a-z0-9-]{8,60}$/.test(id)) {
    const image = await repo.get('story_images', `${ctx.familyId}_img_${id.slice(9)}`);
    return Boolean(image && image.familyId === ctx.familyId && image.storyId === storyId && image.chapterId === chapterId &&
      (image.requestId === undefined || image.requestId === id.slice(9)) && image.purpose === purpose && image.moderation === 'pass' &&
      image.deletedAtMs === undefined && !image.sourcePolicyRequired && image.sourceIds === undefined &&
      typeof image.fileID === 'string' && image.fileID.startsWith('cloud://') &&
      ['png','jpg','jpeg','webp'].some(ext => image.fileID.endsWith(`/story-images/${ctx.familyId}/${storyId}/${id.slice(9)}.${ext}`)));
  }
  const photo = await repo.get('photos', `${ctx.familyId}__${id}`);
  return Boolean(photo && photo.familyId === ctx.familyId && photo._openid === ctx.verifiedOpenid && !photo.deletedAt &&
    !photo.sourcePolicyRequired && photo.sourceIds === undefined && photo.moderation?.ok === true && photo.moderation?.suggest === 'pass');
}

function createStoryService(repo, options = {}) {
  const accessEnabled = options.accessEnabled === true;
  const canaryFamilies = new Set(options.sharedReadFamilyIds || []);
  const invitations = createInvitationService(repo, options);
  const rolledOut = familyId => isRolledOut(repo, canaryFamilies, familyId);
  async function dispatch(context, event = {}, phases) {
    const measure = async (operation, work) => {
      const started = Date.now();
      try { return await (event?.action === 'state' ? measurePerformance(operation,work) : work()); }
      finally { if (phases) phases[operation] = Math.max(0, Date.now() - started); }
    };
    if (!context || typeof context.OPENID !== 'string' || !/^[0-9A-Za-z_-]{1,128}$/.test(context.OPENID)) throw identityError('AUTH_REQUIRED');
    if (accessEnabled && options.rulesReady !== true) throw accessError('STORY_ACCESS_NOT_READY');
    const ctx = accessEnabled
      ? {...await measure('state.identity',()=>resolveStoryIdentity(repo, context, { bootstrapAppId: options.bootstrapAppId })),verifiedOpenid:context.OPENID}
      : { familyId: `family_${context.OPENID}`, verifiedOpenid: context.OPENID };
    const action = String(event?.action || '');
    if (action === 'capabilities') {
      const inRollout = accessEnabled && await rolledOut(ctx.familyId);
      return { apiVersion: 1, independentStories: true, identityVersion: accessEnabled ? 1 : 0,
        familyId: accessEnabled ? ctx.familyId : undefined,
        invitations: options.invitationsEnabled === true && inRollout,
        sharedRead: inRollout,
        excerptShare: options.excerptSharingEnabled === true && inRollout,
        sharedEdit: options.sharedEditEnabled === true && inRollout,
        copy: options.copyReceiveEnabled === true && inRollout,
        chapterPackage: options.chapterPackageEnabled === true && inRollout,
        // Owner-only book image export is locally rendered and resolves the
        // trusted WeChat identity again before preview, save, and share. It is
        // independent from both the public share-card and shared-read rollouts.
        bookExport: true, ownerHistory: true, preparedInvitation: true,
        memoryBookExport: true,
        shareCard: options.shareCardEnabled === true && inRollout, forward: false, publish: false };
    }
    if (action.startsWith('invite')) {
      if (!accessEnabled || options.invitationsEnabled !== true) throw accessError('STORY_ACCESS_DISABLED');
      if (action === 'invitePrepare') {
        if (options.copyReceiveEnabled !== true || !canaryFamilies.has(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
        return prepareInvitation(repo,ctx,event,invitations,options);
      }
      return invitations(ctx, event.action === 'inviteManage' && event.includePeople === true
        ? {...event,familyId:ctx.familyId} : event);
    }
    if (action === 'sharedMedia') {
      if (!accessEnabled || options.sharedMediaEnabled !== true || !await rolledOut(ctx.familyId) || !canaryFamilies.has(event.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return readStoryMedia(repo,ctx,event,options.signMedia);
    }
    if (action === 'sharedRead') {
      if (!accessEnabled || !await rolledOut(ctx.familyId) || !canaryFamilies.has(event.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      const result = await readAuthorizedStory(repo, ctx, event, {sharedEditEnabled:options.sharedEditEnabled === true,copyReceiveEnabled:options.copyReceiveEnabled === true});
      result.capabilities.requestInvitation = options.invitationsEnabled === true && result.capabilities.requestInvitation;
      return result;
    }
    if (action === 'copyReceive') {
      if (!accessEnabled || options.copyReceiveEnabled !== true || !await rolledOut(ctx.familyId) || !canaryFamilies.has(event.sourceFamilyId)) throw accessError('STORY_ACCESS_DISABLED');
      const input={sourceFamilyId:event.sourceFamilyId,sourceStoryId:event.sourceStoryId,sourceRevisionId:event.sourceRevisionId,
        chapterIds:event.chapterIds,requestId:event.requestId,target:event.target};
      try{return await receiveTextCopy(repo,ctx,input,{now:options.now});}
      catch(error){
        if(error?.code!=='STORY_COPY_MEDIA_PENDING')throw error;
        if(!options.copyStorage)throw accessError('STORY_ACCESS_NOT_READY');
        return receiveMediaCopy(repo,ctx,input,options.copyStorage,{nowMs:options.nowMs});
      }
    }
    if (action === 'chapterPackageImport') {
      if (!accessEnabled || options.chapterPackageEnabled !== true || !await rolledOut(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      // Keep ownership/path checks ahead of the retryable moderation state.
      const approveImage = async (c, photoId) => {
        const photo = await repo.get('photos', `${c.familyId}__${photoId}`);
        if (!photo || photo.familyId !== c.familyId || photo.photoId !== photoId || photo._openid !== c.verifiedOpenid ||
          photo.deletedAt || photo.sourcePolicyRequired || photo.sourceIds !== undefined ||
          typeof photo.displayFileID !== 'string' || !photo.displayFileID.startsWith('cloud://') ||
          !photo.displayFileID.endsWith(`/user-photos/${c.familyId}/${photoId}/display.jpg`)) return false;
        if (photo.moderation?.ok === false && photo.moderation?.suggest === 'review')
          throw Object.assign(new Error('图片仍在审核中，请稍后从收件箱继续接收'), { code: 'MODERATION_PENDING' });
        return photo.moderation?.ok === true && photo.moderation?.suggest === 'pass';
      };
      return importChapterPackage(repo,ctx,{requestId:event.requestId,target:event.target,chapter:event.chapter,layout:event.layout ?? null,
        origin:event.origin,packageId:event.packageId,senderName:event.senderName,lineage:event.lineage,assets:event.assets,assetPhotos:event.assetPhotos,
        coverAssetId:event.coverAssetId ?? null},{now:options.now,approveText:options.approveChapterText,approveImage});
    }
    if (action === 'accountActivity') {
      if (!accessEnabled) throw accessError('STORY_ACCESS_DISABLED');
      return accountActivity(repo,ctx);
    }
    if (action === 'articleSave') {
      // Saving one's own article is core writing, independent of sharing rollout.
      // saveArticle still checks space ownership, sources, moderation and versions.
      if (!accessEnabled) throw accessError('STORY_ACCESS_DISABLED');
      return saveArticle(repo,ctx,event,{now:options.now,approveText:options.approveChapterText,
        approveImage:(c,id)=>approveArticleImage(repo,c,id,event.storyId,event.chapter?.id),
        approveBackdrop:(c,id)=>id.startsWith(c.familyId+'_img_') && approveArticleImage(repo,c,'photo-ai-'+id.slice(id.lastIndexOf('_img_')+5),event.storyId,event.chapter?.id,'backdrop')});
    }
    if (action === 'chapterPackageRevise') {
      if (!accessEnabled || options.chapterPackageEnabled !== true || !await rolledOut(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return reviseReceivedChapter(repo,ctx,{requestId:event.requestId,storyId:event.storyId,revisionId:event.revisionId,
        expectedVersion:event.expectedVersion,chapterId:event.chapterId,edits:event.edits,layout:event.layout},
      {now:options.now,approveText:options.approveChapterText});
    }
    if (action === 'copyAppendOwn') {
      if (!accessEnabled || options.copyReceiveEnabled !== true || !await rolledOut(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return appendOwnExperience(repo,ctx,{storyId:event.storyId,revisionId:event.revisionId,expectedVersion:event.expectedVersion,
        chapterId:event.chapterId,text:event.text,requestId:event.requestId},{now:options.now});
    }
    if (action === 'copyReturnOwn') {
      if (!accessEnabled || options.copyReceiveEnabled !== true || !await rolledOut(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return sendOwnReturn(repo,ctx,{storyId:event.storyId,revisionId:event.revisionId,expectedVersion:event.expectedVersion,
        chapterId:event.chapterId,requestId:event.requestId},{now:options.now});
    }
    if (action === 'copyReturns') {
      if (!accessEnabled || options.copyReceiveEnabled !== true || !await rolledOut(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return listReturns(repo,ctx);
    }
    if (action === 'copyReturnDecision') {
      if (!accessEnabled || options.copyReceiveEnabled !== true || !await rolledOut(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return decideReturn(repo,ctx,{returnId:event.returnId,decision:event.decision,requestId:event.requestId},{now:options.now});
    }
    if (action === 'chapterChanges') {
      if (!accessEnabled || !canaryFamilies.has(ctx.familyId)) throw accessError('STORY_ACCESS_DISABLED');
      return listChapterChanges(repo,ctx,{familyId:event.familyId,storyId:event.storyId,chapterId:event.chapterId});
    }
    if (action === 'sharedEdit') {
      if (!accessEnabled || options.sharedEditEnabled !== true || !await rolledOut(ctx.familyId) || !canaryFamilies.has(event.familyId)) throw accessError('STORY_ACCESS_DISABLED');
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
      let exportCtx = ctx;
      if (memoryExport) {
        if (accessEnabled) await assertSpaceOwner(repo, ctx);
      } else if (!accessEnabled) {
        exportCtx = { ...await resolveStoryIdentity(repo, context, { bootstrapAppId: options.bootstrapAppId }),
          verifiedOpenid: context.OPENID };
      }
      const input = memoryExport
        ? { familyId: exportCtx.familyId, sourceKind: 'memory', memoryId: event.memoryId,
          ...(event.revisionId !== undefined ? { revisionId: event.revisionId } : {}),
          expectedSourceVersion: event.expectedSourceVersion,
          ...(event.includePhotos !== undefined ? { includePhotos: event.includePhotos } : {}),
          ...(event.targetTextImageCount !== undefined ? { targetTextImageCount: event.targetTextImageCount } : {}) }
        : { familyId: exportCtx.familyId, storyId: event.storyId, revisionId: event.revisionId, expectedVersion: event.expectedVersion,
          scope: event.scope, chapterIds: event.chapterIds, ...(event.excerpt !== undefined ? { excerpt: event.excerpt } : {}),
          ...(event.coverImageIds !== undefined ? { coverImageIds: event.coverImageIds } : {}),
          ...(event.targetTextImageCount !== undefined ? { targetTextImageCount: event.targetTextImageCount } : {}) };
      return action === 'bookExportPreview' ? previewBookExport(repo, exportCtx, input, { approve: options.approveShareCard })
        : exportBookImages(repo, exportCtx, { ...input, descriptorId: event.descriptorId }, { approve: options.approveShareCard, sign: options.signMedia });
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
    if (action === 'state') result = await measure('state.load',()=>handlers.state(ctx,{view:event.view}));
    else if (action === 'history' || action === 'revision') result = await readHistory(guardedRepo,ctx,event);
    else if (action === 'migrate') result = await handlers.migrate(ctx);
    else if (action === 'context') result = await handlers.aiContext(ctx, event);
    else if (action === 'memberAdd') result = await handlers.memberAdd(ctx, event);
    else if (action === 'memberUpdate') result = await handlers.memberUpdate(ctx, event);
    else if (action === 'memberDelete') result = await handlers.memberDelete(ctx, event);
    else if (action === 'memberRestore') result = await handlers.memberRestore(ctx, event);
    else if (action === 'roomProfileUpdate') result = await handlers.roomProfileUpdate(ctx, event);
    else {
      // Response shape is not part of a write's idempotency fingerprint.
      const {returnState, ...command} = event;
      result = await handlers.command(ctx, command);
      if (action === 'save' && returnState === 'home' && result?.ok === true) {
        try {
          const savedState = await measure('state.load',()=>handlers.state(ctx,{view:'home'}));
          // Leave large results to the existing chunked read protocol. A receipt
          // must remain small enough to acknowledge the already committed write.
          const encoded = encodeStateResponse(savedState,{stateTransport:1});
          if (encoded.stateTransport !== 1) result = {...result,savedState};
        } catch {
          // The write succeeded. Return its receipt and let the client retry the
          // read; do not turn a readback outage into an unacknowledged write.
        }
      }
    }
    // Reads and already-acknowledged operations can return without a write
    // transaction. Do not release data if identity was revoked during the read.
    if (accessEnabled) await measure('state.authorize.after',()=>assertSpaceOwner(repo, ctx));
    return ['state','history','revision'].includes(action) ? encodeStateResponse(result, event) : result;
  }
  return async (context,event={}) => {
    const started = Date.now();
    const phases = event.performanceDiagnostics === 1 && ['state','save'].includes(event.action) ? {} : undefined;
    const result = event?.action === 'state'
      ? await measurePerformance('state.total',()=>dispatch(context,event,phases))
      : await dispatch(context,event,phases);
    // Attach outside chunk encoding: changing timings must not change a state digest.
    // Only fixed operation names and elapsed milliseconds, never document values.
    return phases ? {...result,performance:{serverDurationMs:Math.max(0,Date.now()-started),phases}} : result;
  };
}

module.exports = { createStoryService, approveArticleImage };
