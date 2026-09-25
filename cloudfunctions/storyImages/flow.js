const core = require("./core");
const { classifyAigcMetadataError } = require("./aigcMetadata");

const RECENT_JOB_WINDOW_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 10;
/** The timer shares the function's 60-second timeout; stop starting new work well before it. */
const SWEEP_BUDGET_MS = 20_000;
/** A synchronous generation can take tens of seconds, so only start one while the invocation is fresh. */
const GENERATE_START_WINDOW_MS = 5_000;
/** Downloading and uploading need a few seconds of the remaining time. */
const STORE_START_WINDOW_MS = 48_000;
/** The quality check waits up to 12 seconds; otherwise the sweep runs it later. */
const QUALITY_START_WINDOW_MS = 40_000;
const QUALITY_BATCH = 3;

/**
 * Every outside effect (database, storage, TokenHub, the text model, WeChat
 * content checks, the clock) is passed in, so the whole flow runs in tests.
 *
 * Tapping 配图 only reads the chapter and queues a prompt, so it returns quickly.
 * The picture is drawn by the next status poll, or by the timer when nobody polls.
 */
function createStoryImageHandlers(deps) {
  const {
    repo,
    provider,
    extractScene,
    sceneConfigured,
    storage,
    moderation,
    forwardPhotoModeration,
    downloadImage,
    aigcMetadata,
    qualityChecker,
    referenceAnalyzer,
    coverServices,
    textChecker,
    readPhotos,
    now = () => Date.now(),
    log = console,
  } = deps;
  const qualityEnabled = Boolean(qualityChecker && qualityChecker.configured);
  const assertSameRequest = (existing,input) => {
    if (String(existing.storyId || "") !== input.storyId || existing.memberId !== input.memberId || existing.chapterId !== input.chapterId ||
      existing.purpose !== input.purpose || String(existing.referenceImageId || "") !== input.referenceImageId ||
      String(existing.artDirectionHash || "") !== (input.artDirection ? core.textHash(input.artDirection) : "") ||
      JSON.stringify(existing.referenceImageIds || []) !== JSON.stringify(input.referenceImageIds || []) ||
      JSON.stringify(existing.referencePhotoIds || []) !== JSON.stringify(input.referencePhotoIds || [])) {
      throw new core.StoryImageError("REQUEST_CONFLICT", "这次请求的章节或参考图已经变化，请重新操作");
    }
  };
  async function assertStorySource(job) {
    if(!job.storyId)return "";
    if(typeof repo.assertStoryImageSource!=='function')throw new core.StoryImageError("IMAGE_REPOSITORY_CONFIG_REQUIRED","故事配图服务尚未准备好");
    try{await repo.assertStoryImageSource(job);return "";}
    catch(error){
      if(!["STORY_PROTOCOL_REQUIRED","STORY_NOT_FOUND","REVISION_CHANGED","CHAPTER_NOT_FOUND","CHAPTER_EMPTY","BOOK_EMPTY","BOOK_TOO_LONG"].includes(error?.code))throw error;
      await repo.updateJob(job._id,{status:"failed",errorCode:error.code,prompt:"",updatedAtMs:now()});
      return error.code;
    }
  }

  async function storyArtMemories(familyId, storyContext) {
    if (!storyContext || typeof repo.listStoryMemories !== "function") return [];
    return await repo.listStoryMemories(familyId, storyContext.story);
  }

  function assertReferencePhotosInChapter(source, photoIds) {
    if (!photoIds?.length) return;
    const allowed = new Set(source.photoIds || []);
    if (photoIds.some(id => !allowed.has(id))) {
      throw new core.StoryImageError("REFERENCE_IMAGE_NOT_FOUND", "只能参考本章正文里的照片");
    }
  }

  async function readReferencePhotoUrls(ctx, input, photoIds) {
    if (!photoIds?.length) return [];
    if (!readPhotos) throw new core.StoryImageError("REFERENCE_NOT_CONFIGURED", "参考照片服务还没配置好");
    const photos = await readPhotos({
      familyId: input.familyId, photoIds, variant: "display", purpose: "ai-reference", onBehalfOfOpenid: ctx.openid,
    });
    if (photos.length !== photoIds.length || photos.some(photo => photo.status !== "ok" || !photo.url)) {
      throw new core.StoryImageError("REFERENCE_IMAGE_NOT_READY", "本章照片尚未上传或暂时无法用于 AI，请稍后再试");
    }
    return photos.map(photo => photo.url);
  }

  async function referenceImagesForJob(job) {
    const photoIds = Array.isArray(job.referencePhotoIds) ? job.referencePhotoIds : [];
    if (!photoIds.length) return [];
    return await readReferencePhotoUrls({ openid: job.requesterOpenId }, job, photoIds);
  }

  async function submit(ctx, event) {
    const input = core.normalizeSubmitInput(event);
    core.requireOwner(ctx.openid, input.familyId);
    if (!provider.configured) throw new core.StoryImageError("IMAGE_NOT_CONFIGURED", "出图服务还没配置好");
    if (!sceneConfigured) throw new core.StoryImageError("AI_NOT_CONFIGURED", "在线 AI 还没配置好");
    if (!aigcMetadata || !aigcMetadata.configured) {
      throw new core.StoryImageError("AIGC_METADATA_NOT_CONFIGURED", "AI 图片的文件标识还没配置好");
    }

    const jobId = `${input.familyId}_${input.requestId}`;
    const existing = await repo.getJob(jobId);
    if (existing) {
      assertSameRequest(existing,input);
      return { job: core.publicJob(existing) };
    }

    if (input.artDirection) {
      if (!textChecker) throw new core.StoryImageError("ART_DIRECTION_CHECK_FAILED", "美术想法暂时无法审核，请稍后重试");
      const verdict = await textChecker.check({ text: input.artDirection, openid: ctx.openid });
      if (!verdict.ok) throw new core.StoryImageError(
        verdict.risky ? "ART_DIRECTION_BLOCKED" : "ART_DIRECTION_CHECK_FAILED",
        verdict.risky ? "这段美术想法没通过平台审核，请改写后再试" : "美术想法暂时无法审核，请稍后重试",
      );
    }

    let storyContext;
    if(input.storyId){
      if(typeof repo.getActiveStoryDraft!=='function')throw new core.StoryImageError("IMAGE_REPOSITORY_CONFIG_REQUIRED","故事配图服务尚未准备好");
      storyContext=await repo.getActiveStoryDraft(input.familyId,input.storyId);
      if(!storyContext)throw new core.StoryImageError("STORY_NOT_FOUND","这本故事书已不可用，请返回书架");
      core.assertUnrestrictedStory(storyContext.story,storyContext.draft);
    }
    const draft = input.storyId?storyContext.draft:core.latestDraftForMember(await repo.listDraftRecords(input.familyId, input.memberId),input.memberId);
    const artMemories = await storyArtMemories(input.familyId, storyContext);
    const source = input.purpose === "cover" ? core.bookSource(draft, artMemories) : core.chapterSource(draft, input.chapterId, artMemories);
    assertReferencePhotosInChapter(source, input.purpose === "cover" ? [] : input.referencePhotoIds);
    let chapterReferenceUrls = [];
    if (["illustration", "backdrop"].includes(input.purpose) && input.referencePhotoIds.length) {
      if (!referenceAnalyzer?.configured) throw new core.StoryImageError("REFERENCE_NOT_CONFIGURED", "参考图服务还没配置好");
      chapterReferenceUrls = await readReferencePhotoUrls(ctx, input, input.referencePhotoIds);
    }
    let coverReferenceUrls = [];
    if (input.purpose === "cover") {
      if (!coverServices) throw new core.StoryImageError("COVER_NOT_CONFIGURED", "封面服务尚未准备好");
      if ((input.referenceImageIds.length || input.referencePhotoIds.length) && !referenceAnalyzer?.configured) {
        throw new core.StoryImageError("REFERENCE_NOT_CONFIGURED", "参考图服务还没配置好");
      }
      coverReferenceUrls = await coverServices.prepare(ctx, input, storyContext);
    }
    let referenceUrl = "";
    if (input.referenceImageId) {
      if (!referenceAnalyzer || !referenceAnalyzer.configured) {
        throw new core.StoryImageError("REFERENCE_NOT_CONFIGURED", "参考图服务还没配置好");
      }
      const referenceImage = await repo.getImage(input.referenceImageId);
      const linkedReference=!referenceImage?.storyId && input.storyId && repo.isImageLinkedToStory
        ? await repo.isImageLinkedToStory(input.familyId,input.storyId,input.referenceImageId) : false;
      if (!referenceImage || referenceImage.familyId !== input.familyId || (String(referenceImage.storyId || "") !== input.storyId && !linkedReference) || (!input.storyId && referenceImage.memberId !== input.memberId) ||
        referenceImage.chapterId !== input.chapterId || referenceImage.purpose !== "illustration" ||
        referenceImage.deletedAtMs !== undefined || !referenceImage.fileID) {
        throw new core.StoryImageError("REFERENCE_IMAGE_NOT_FOUND", "这张参考图已不可用，请重新选择");
      }
      if (referenceImage.moderation !== "pass") {
        throw new core.StoryImageError("REFERENCE_IMAGE_NOT_READY", "这张插图还没通过平台审核，暂时不能作为参考");
      }
      referenceUrl = (await storage.tempUrls([referenceImage.fileID], 5 * 60))[referenceImage.fileID] || "";
      if (!referenceUrl) throw new core.StoryImageError("REFERENCE_IMAGE_NOT_FOUND", "暂时读不到这张参考图，请稍后再试");
    }
    const nowMs = now();
    const dayKey = core.chinaDayKey(nowMs);
    const [todayCount, bookCount] = await Promise.all([
      repo.countJobs({ familyId: input.familyId, dayKey, statuses: core.COUNTED_STATUSES }),
      repo.countJobs({ familyId: input.familyId, ...(input.storyId ? {storyId:input.storyId} : {memberId:input.memberId}), statuses: core.COUNTED_STATUSES }),
    ]);
    const quota = core.quotaDecision({ todayCount, bookCount });
    if (!quota.allowed) throw new core.StoryImageError(quota.code, quota.message);

    // The record is written before any model call, so an interrupted request still leaves a trace.
    const job = {
      _id: jobId,
      familyId: input.familyId,
      requesterOpenId: ctx.openid,
      requestId: input.requestId,
      memberId: input.memberId,
      storyId: input.storyId,
      ...(storyContext?{sourceRevisionId:storyContext.revision.id}:{}),
      chapterId: input.chapterId,
      purpose: input.purpose,
      provider: provider.name,
      model: provider.model,
      seed: core.imageSeed(input.familyId, input.requestId),
      prompt: "",
      source: {
        chapterId: input.chapterId,
        textHash: source.fullTextHash || core.textHash(source.text),
        textLength: source.textLength,
        artTextLength: source.artTextLength || source.textLength,
        characterContextLength: source.characterContext.length,
        ...(source.photoIds?.length ? { photoHash: source.photoHash, photoCount: source.photoIds.length } : {}),
      },
      referencePhotoCount: input.referencePhotoIds?.length || 0,
      referenceImageCount: input.referenceImageIds?.length || (input.referenceImageId ? 1 : 0),
      ...(input.artDirection ? { artDirectionHash: core.textHash(input.artDirection) } : {}),
      ...(input.referencePhotoIds?.length ? { referencePhotoIds: input.referencePhotoIds } : {}),
      ...(input.purpose === "cover" ? { referenceImageIds: input.referenceImageIds, referencePhotoIds: input.referencePhotoIds } : {}),
      ...(input.referenceImageId ? { referenceImageId: input.referenceImageId } : {}),
      status: "submitted",
      dayKey,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    const raced=input.storyId && repo.createJobForActiveStory
      ? await repo.createJobForActiveStory(jobId,job)
      : (await repo.createJob(jobId,job),undefined);
    if(raced) {
      assertSameRequest(raced,input);
      return {job:core.publicJob(raced)};
    }
    const sourceError=await assertStorySource(job);
    if(sourceError)return {job:core.publicJob({...job,status:"failed",errorCode:sourceError})};

    let scene;
    try {
      const [extracted, extractedReference] = await Promise.all([
        extractScene(source),
        coverReferenceUrls.length ? referenceAnalyzer.analyzeCover(coverReferenceUrls)
          : chapterReferenceUrls.length ? (referenceAnalyzer.analyzeChapterPhotos || referenceAnalyzer.analyzeCover)(chapterReferenceUrls)
          : referenceUrl ? referenceAnalyzer.analyze(referenceUrl) : Promise.resolve(undefined),
      ]);
      scene = extracted;
      scene = core.alignSceneFigures(scene, source);
      const visualReference = core.alignVisualReference(extractedReference, source, scene, {
        photoReference: chapterReferenceUrls.length > 0, trustedChapterPhoto: chapterReferenceUrls.length > 0,
      });
      const { prompt, width, height } = core.buildImagePrompt(scene, input.purpose, visualReference, source, input.artDirection);
      const patch = {
        status: "queued", prompt, scene, width, height, queuedAtMs: now(), updatedAtMs: now(),
      };
      await repo.updateJob(jobId, patch);
      return { job: core.publicJob({ ...job, ...patch }) };
    } catch (error) {
      const patch = { status: "failed", errorCode: (error && error.code) || "SCENE_FAILED", updatedAtMs: now() };
      await repo.updateJob(jobId, patch);
      return { job: core.publicJob({ ...job, ...patch }) };
    }

  }

  async function requestModeration(imageId, image, openid) {
    try {
      const traceId = await moderation.check({ fileID: image.fileID, openid });
      await repo.updateImage(imageId, { moderation: "pending", moderationTraceId: traceId });
    } catch (error) {
      log.error("storyImages moderation", String((error && (error.errCode || error.message)) || error));
      await repo.updateImage(imageId, {
        moderation: "unchecked",
        moderationError: String((error && (error.errCode || error.message)) || error).slice(0, 80),
      });
    }
  }

  /** Looks for stray text, watermarks or logos. A missing link leaves it pending for the sweep. */
  async function runQualityCheck(imageId, image) {
    try {
      const url = (await storage.tempUrls([image.fileID]))[image.fileID];
      if (!url) return;
      const outcome = await qualityChecker.check(url);
      await repo.updateImage(imageId, {
        quality: outcome.quality,
        qualityIssues: outcome.qualityIssues || [],
        qualityNote: outcome.qualityNote || "",
        qualityError: outcome.qualityError || "",
      });
    } catch (error) {
      log.error("storyImages quality", String(error && error.message));
    }
  }

  async function generate(job) {
    const claimed = await repo.claimJob(job._id, ["queued"], { status: "generating", generatingAtMs: now(), updatedAtMs: now() });
    if (!claimed) return (await repo.getJob(job._id)) || job;
    try{
      const sourceError=await assertStorySource({...job,status:"generating"});
      if(sourceError)return {...job,status:"failed",errorCode:sourceError};
    }catch(error){
      await repo.updateJob(job._id,{status:"queued",updatedAtMs:now()});
      throw error;
    }
    let referenceImages;
    try {
      referenceImages = await referenceImagesForJob(job);
    } catch (error) {
      const patch = { status: "failed", errorCode: (error && error.code) || "REFERENCE_IMAGE_NOT_READY", prompt: "", updatedAtMs: now() };
      await repo.updateJob(job._id, patch);
      return { ...job, ...patch };
    }
    let result;
    try {
      result = await provider.generate({
        prompt: job.prompt, width: job.width, height: job.height, seed: job.seed,
        ...(referenceImages.length ? { referenceImages } : {}),
      });
    } catch (error) {
      const outcome = core.classifyGenerateError(error);
      log.error("storyImages generate", outcome.errorCode, String(error && error.message));
      const patch = { status: outcome.status, errorCode: outcome.errorCode, prompt: "", updatedAtMs: now() };
      await repo.updateJob(job._id, patch);
      return { ...job, ...patch };
    }
    // The link is saved first, so a failed upload retries from it instead of paying for a new picture.
    const patch = {
      status: "generated",
      resultUrl: result.resultUrl,
      revisedPrompt: "",
      providerJobId: result.providerJobId || "",
      usageTokens: result.usageTokens || 0,
      prompt: "",
      generatedAtMs: now(),
      updatedAtMs: now(),
    };
    await repo.updateJob(job._id, patch);
    return { ...job, ...patch };
  }

  async function store(job, startedMs) {
    const release = async () => {
      const patch = { status: "generated", updatedAtMs: now() };
      await repo.updateJob(job._id, patch);
      return { ...job, ...patch };
    };
    let image;
    try {
      image = await downloadImage(job.resultUrl);
    } catch (error) {
      if (error && error.expired) {
        const patch = { status: "expired", errorCode: String(error.message).slice(0, 40), updatedAtMs: now() };
        await repo.updateJob(job._id, patch);
        return { ...job, ...patch };
      }
      log.error("storyImages download", String(error && error.message));
      return release();
    }

    let markedImage;
    let aigcProduceId;
    try {
      markedImage = aigcMetadata.writeForSource(image.buffer, image.contentType, job._id);
      aigcProduceId = markedImage.produceId;
    } catch (error) {
      const outcome = classifyAigcMetadataError(error);
      log.error("storyImages AIGC metadata", outcome.errorCode);
      if (!outcome.terminal) return release();
      const patch = { status: "failed", errorCode: outcome.errorCode, updatedAtMs: now() };
      await repo.updateJob(job._id, patch);
      return { ...job, ...patch };
    }

    const imageId = `${job.familyId}_img_${job.requestId}`;
    const cloudPath = `story-images/${job.familyId}/${job.storyId || job.memberId}/${job.requestId}.${core.extensionFor(markedImage.contentType)}`;
    let fileID;
    try {
      fileID = await storage.upload(cloudPath, markedImage.buffer);
    } catch (error) {
      log.error("storyImages upload", String(error && error.message));
      return release();
    }

    const nowMs = now();
    const imageDoc = {
      familyId: job.familyId,
      memberId: job.memberId,
      storyId: job.storyId || "",
      chapterId: job.chapterId,
      purpose: job.purpose,
      fileID,
      width: job.width,
      height: job.height,
      bytes: markedImage.buffer.length,
      contentType: markedImage.contentType,
      aigcProduceId,
      moderation: "unchecked",
      quality: qualityEnabled ? "pending" : "unchecked",
      qualityIssues: [],
      aiGenerated: true,
      jobId: job._id,
      createdAtMs: nowMs,
    };
    await repo.createImage(imageId, imageDoc);
    const patch = { status: "stored", imageId, aigcProduceId, storedAtMs: nowMs, updatedAtMs: nowMs };
    await repo.updateJob(job._id, patch);
    await requestModeration(imageId, imageDoc, job.requesterOpenId);
    if (qualityEnabled && now() - startedMs <= QUALITY_START_WINDOW_MS) await runQualityCheck(imageId, imageDoc);
    return { ...job, ...patch };
  }

  async function advance(job, startedMs) {
    let current = job;
    if (current.status === "queued") {
      if (now() - startedMs > GENERATE_START_WINDOW_MS) return current;
      current = await generate(current);
    }
    if (current.status === "generated") {
      if (now() - startedMs > STORE_START_WINDOW_MS) return current;
      // Two polls can see the same finished picture; only the one that claims it stores the file.
      const claimed = await repo.claimJob(current._id, ["generated"], { status: "storing", updatedAtMs: now() });
      if (!claimed) return (await repo.getJob(current._id)) || current;
      current = await store({ ...current, status: "storing" }, startedMs);
    }
    return current;
  }

  async function loadOwnedJob(ctx, event) {
    const familyId = String((event && event.familyId) || "").trim();
    core.requireOwner(ctx.openid, familyId);
    const storyId=String((event && event.storyId) || '').trim(), memberId=String((event && event.memberId) || '').trim();
    const jobId = String((event && event.jobId) || "");
    const job = jobId.startsWith(`${familyId}_`) ? await repo.getJob(jobId) : undefined;
    if (!job || job.familyId !== familyId) throw new core.StoryImageError("JOB_NOT_FOUND", "没找到这次配图");
    if(job.storyId) {
      if(storyId!==job.storyId)throw new core.StoryImageError("JOB_NOT_FOUND", "没找到这次配图");
    } else if(storyId) {
      if(!repo.isJobLinkedToStory || !await repo.isJobLinkedToStory(familyId,storyId,jobId))throw new core.StoryImageError("JOB_NOT_FOUND", "没找到这次配图");
    } else if(memberId && memberId!==job.memberId)throw new core.StoryImageError("JOB_NOT_FOUND", "没找到这次配图");
    if(storyId && repo.isActiveStory && !await repo.isActiveStory(familyId,storyId))throw new core.StoryImageError("STORY_NOT_FOUND", "这本故事书已不可用，请返回书架");
    return job;
  }

  async function status(ctx, event) {
    const startedMs = now();
    const job = await advance(await loadOwnedJob(ctx, event), startedMs);
    if (job.status !== "stored" || !job.imageId) return { job: core.publicJob(job) };
    const image = await repo.getImage(job.imageId);
    if (!image || image.deletedAtMs !== undefined) return { job: core.publicJob(job) };
    const urls = await storage.tempUrls([image.fileID]);
    return { job: core.publicJob(job), image: core.publicImage(image, urls[image.fileID]) };
  }

  async function list(ctx, event) {
    const familyId = String((event && event.familyId) || "").trim();
    core.requireOwner(ctx.openid, familyId);
    const storyId = String((event && event.storyId) || "").trim();
    const memberId = storyId ? "" : core.normalizeMemberInput(event);
    const [images, jobs] = await Promise.all([
      storyId ? repo.listStoryImages(familyId, core.normalizeStoryInput(event)) : repo.listImages(familyId, memberId),
      storyId ? repo.listRecentStoryJobs(familyId, storyId, now() - RECENT_JOB_WINDOW_MS) : repo.listRecentJobs(familyId, memberId, now() - RECENT_JOB_WINDOW_MS),
    ]);
    const visible = images.filter(image => image.deletedAtMs === undefined && image.moderation !== "risky");
    const urls = await storage.tempUrls(visible.map(image => image.fileID));
    return {
      images: visible
        .sort((a, b) => Number(b.createdAtMs) - Number(a.createdAtMs))
        .map(image => core.publicImage(image, urls[image.fileID])),
      pending: jobs
        .filter(job => job.status !== "stored")
        .sort((a, b) => Number(b.createdAtMs) - Number(a.createdAtMs))
        .map(core.publicJob),
      usage: { count: visible.length, bytes: visible.reduce((sum, image) => sum + Number(image.bytes || 0), 0) },
      limits: { daily: core.DAILY_LIMIT, book: core.BOOK_LIMIT },
    };
  }

  async function remove(ctx, event) {
    const familyId = String((event && event.familyId) || "").trim();
    core.requireOwner(ctx.openid, familyId);
    const imageId = String((event && event.imageId) || "");
    const image = imageId.startsWith(`${familyId}_`) ? await repo.getImage(imageId) : undefined;
    if (!image || image.familyId !== familyId || image.deletedAtMs !== undefined) {
      throw new core.StoryImageError("IMAGE_NOT_FOUND", "没找到这张图");
    }
    const requestedStoryId=String((event && event.storyId) || '').trim(), requestedMemberId=String((event && event.memberId) || '').trim();
    const linkedStoryIds=repo.listImageStoryIds ? await repo.listImageStoryIds(familyId,imageId) : [];
    if(image.storyId) {
      if(requestedStoryId!==image.storyId)throw new core.StoryImageError("IMAGE_NOT_FOUND", "没找到这张图");
    } else if(requestedStoryId) {
      if(!linkedStoryIds.includes(requestedStoryId))throw new core.StoryImageError("IMAGE_NOT_FOUND", "没找到这张图");
    } else if(requestedMemberId && requestedMemberId!==image.memberId)throw new core.StoryImageError("IMAGE_NOT_FOUND", "没找到这张图");
    const records = image.storyId
      ? await repo.listStoryDraftRecords(familyId, image.storyId)
      : await repo.listDraftRecords(familyId, image.memberId);
    const referencedByHistory = records.some(record => core.draftReferencesStoryImage(
      record && record.revision ? record.revision.draft : record && record.draft,
      imageId,
    ));
    if (referencedByHistory) {
      throw new core.StoryImageError("IMAGE_IN_MANUSCRIPT", "这张插图仍被正文或历史版本使用，不能删除");
    }
    const nowMs = now();
    if(repo.softDeleteImage) {
      const outcome=await repo.softDeleteImage(imageId,{familyId,storyIds:[...new Set([String(image.storyId || ''),...linkedStoryIds].filter(Boolean))],nowMs});
      if(outcome==='missing')throw new core.StoryImageError("IMAGE_NOT_FOUND", "没找到这张图");
      if(outcome==='referenced')throw new core.StoryImageError("IMAGE_IN_MANUSCRIPT", "这张插图仍被正文、封面或历史版本使用，不能删除");
    } else await repo.updateImage(imageId, { deletedAtMs: nowMs });
    try {
      await storage.remove([image.fileID]);
    } catch (error) {
      log.error("storyImages remove file", String(error && error.message));
      await repo.updateImage(imageId, { fileDeleteFailed: true });
    }
    if (image.jobId) await repo.updateJob(image.jobId, { imageDeletedAtMs: nowMs, updatedAtMs: nowMs });
    return { ok: true };
  }

  async function sweep() {
    const startedMs = now();
    const results = [];
    for (const job of await repo.listActiveJobs(SWEEP_BATCH)) {
      const action = core.sweepAction(job, now());
      if (action === "skip") continue;
      const elapsed = now() - startedMs;
      if (elapsed > SWEEP_BUDGET_MS || (action === "generate" && elapsed > GENERATE_START_WINDOW_MS)) {
        results.push({ jobId: job._id, action: "deferred" });
        continue;
      }
      try {
        if (action === "mark-failed") {
          await repo.claimJob(job._id, ["submitted"], { status: "failed", errorCode: "SCENE_INTERRUPTED", updatedAtMs: now() });
        } else if (action === "mark-unknown") {
          await repo.claimJob(job._id, ["generating"], { status: "unknown", errorCode: "GENERATE_INTERRUPTED", prompt: "", updatedAtMs: now() });
        } else if (action === "release") {
          await repo.claimJob(job._id, ["storing"], { status: "generated", updatedAtMs: now() });
        } else {
          await advance(job, startedMs);
        }
      } catch (error) {
        log.error("storyImages sweep", job._id, String(error && error.message));
      }
      results.push({ jobId: job._id, action });
    }

    // Pictures whose quality check did not fit inside the request that stored them.
    let qualityChecked = 0;
    if (qualityEnabled) {
      for (const image of await repo.listImagesPendingQuality(QUALITY_BATCH)) {
        if (now() - startedMs > QUALITY_START_WINDOW_MS) break;
        await runQualityCheck(image._id, image);
        qualityChecked++;
      }
    }
    const deferred = results.filter(item => item.action === "deferred").length;
    return { swept: results.length - deferred, deferred, qualityChecked, results };
  }

  /**
   * WeChat pushes wxa_media_check within 30 minutes, and one event type can only reach
   * one cloud function, so this is also where photo checks land. Results that do not
   * belong to a generated story image are forwarded to photoAccess, the sole writer of
   * the photos collection. User photos are never deleted here.
   */
  async function moderationResult(event) {
    const traceId = String((event && event.trace_id) || "");
    if (!traceId) return { ok: false };
    const image = await repo.findImageByTrace(traceId);
    const result = (event && event.result) || {};
    if (!image) {
      if (!forwardPhotoModeration) return { ok: false };
      await forwardPhotoModeration({ traceId, suggest: result.suggest, label: result.label });
      return { ok: true, target: "photos" };
    }
    const nowMs = now();
    if (result.suggest === "pass") {
      await repo.updateImage(image._id, { moderation: "pass", moderationLabel: result.label, moderatedAtMs: nowMs });
    } else if (result.suggest === "risky") {
      await repo.updateImage(image._id, { moderation: "risky", moderationLabel: result.label, moderatedAtMs: nowMs, deletedAtMs: nowMs });
      try {
        await storage.remove([image.fileID]);
      } catch (error) {
        log.error("storyImages remove risky file", String(error && error.message));
        await repo.updateImage(image._id, { fileDeleteFailed: true });
      }
    } else {
      await repo.updateImage(image._id, { moderation: "review", moderationLabel: result.label, moderatedAtMs: nowMs });
    }
    return { ok: true, target: "story_images" };
  }

  return { submit, status, list, remove, sweep, moderationResult };
}

module.exports = { createStoryImageHandlers };
