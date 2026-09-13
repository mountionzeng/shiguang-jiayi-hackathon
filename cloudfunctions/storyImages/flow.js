const core = require("./core");

const RECENT_JOB_WINDOW_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 10;

/**
 * Every outside effect (database, storage, Hunyuan, the text model, WeChat
 * content checks, the clock) is passed in, so the whole flow runs in tests.
 */
function createStoryImageHandlers(deps) {
  const {
    repo,
    provider,
    extractScene,
    sceneConfigured,
    storage,
    moderation,
    downloadImage,
    now = () => Date.now(),
    log = console,
  } = deps;

  async function submit(ctx, event) {
    const input = core.normalizeSubmitInput(event);
    core.requireOwner(ctx.openid, input.familyId);
    if (!provider.configured) throw new core.StoryImageError("IMAGE_NOT_CONFIGURED", "出图服务还没配置好");
    if (!sceneConfigured) throw new core.StoryImageError("AI_NOT_CONFIGURED", "在线 AI 还没配置好");

    const jobId = `${input.familyId}_${input.requestId}`;
    const existing = await repo.getJob(jobId);
    if (existing) return { job: core.publicJob(existing) };

    const draft = core.latestDraftForMember(
      await repo.listDraftRecords(input.familyId, input.memberId),
      input.memberId,
    );
    const source = core.chapterSource(draft, input.chapterId);
    const nowMs = now();
    const dayKey = core.chinaDayKey(nowMs);
    const [todayCount, bookCount] = await Promise.all([
      repo.countJobs({ familyId: input.familyId, dayKey, statuses: core.COUNTED_STATUSES }),
      repo.countJobs({ familyId: input.familyId, memberId: input.memberId, statuses: core.COUNTED_STATUSES }),
    ]);
    const quota = core.quotaDecision({ todayCount, bookCount });
    if (!quota.allowed) throw new core.StoryImageError(quota.code, quota.message);

    // The record is written before any paid call, so an interrupted request
    // leaves a trace that the sweep can mark as uncertain instead of losing it.
    const job = {
      _id: jobId,
      familyId: input.familyId,
      requesterOpenId: ctx.openid,
      requestId: input.requestId,
      memberId: input.memberId,
      storyId: "",
      chapterId: input.chapterId,
      purpose: input.purpose,
      provider: provider.name,
      model: provider.model,
      prompt: "",
      source: { chapterId: input.chapterId, textHash: core.textHash(source.text), textLength: source.textLength },
      referencePhotoCount: 0,
      status: "submitted",
      dayKey,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    await repo.createJob(jobId, job);

    let scene;
    try {
      scene = await extractScene(source);
    } catch (error) {
      const patch = { status: "failed", errorCode: (error && error.code) || "SCENE_FAILED", updatedAtMs: now() };
      await repo.updateJob(jobId, patch);
      return { job: core.publicJob({ ...job, ...patch }) };
    }

    const { prompt, width, height } = core.buildImagePrompt(scene, input.purpose);
    await repo.updateJob(jobId, { prompt, scene, width, height, updatedAtMs: now() });

    let submitted;
    try {
      submitted = await provider.submit({ prompt, width, height });
    } catch (error) {
      const outcome = core.classifySubmitError(error);
      log.error("storyImages submit", outcome.errorCode, String(error && error.message));
      const patch = { status: outcome.status, errorCode: outcome.errorCode, updatedAtMs: now() };
      await repo.updateJob(jobId, patch);
      return { job: core.publicJob({ ...job, ...patch }) };
    }

    const patch = { status: "running", providerJobId: submitted.providerJobId, submittedAtMs: now(), updatedAtMs: now() };
    await repo.updateJob(jobId, patch);
    return { job: core.publicJob({ ...job, prompt, width, height, ...patch }) };
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

  async function store(job, result) {
    let image;
    try {
      image = await downloadImage(result.imageUrl);
    } catch (error) {
      if (error && error.expired) {
        const patch = { status: "expired", errorCode: String(error.message).slice(0, 40), updatedAtMs: now() };
        await repo.updateJob(job._id, patch);
        return { ...job, ...patch };
      }
      log.error("storyImages download", String(error && error.message));
      const patch = { status: "running", updatedAtMs: now() };
      await repo.updateJob(job._id, patch);
      return { ...job, ...patch };
    }

    const imageId = `${job.familyId}_img_${job.requestId}`;
    const cloudPath = `story-images/${job.familyId}/${job.memberId}/${job.requestId}.${core.extensionFor(image.contentType)}`;
    let fileID;
    try {
      fileID = await storage.upload(cloudPath, image.buffer);
    } catch (error) {
      log.error("storyImages upload", String(error && error.message));
      const patch = { status: "running", updatedAtMs: now() };
      await repo.updateJob(job._id, patch);
      return { ...job, ...patch };
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
      bytes: image.buffer.length,
      contentType: image.contentType,
      moderation: "unchecked",
      aiGenerated: true,
      jobId: job._id,
      createdAtMs: nowMs,
    };
    await repo.createImage(imageId, imageDoc);
    const patch = { status: "stored", imageId, revisedPrompt: result.revisedPrompt || "", storedAtMs: nowMs, updatedAtMs: nowMs };
    await repo.updateJob(job._id, patch);
    await requestModeration(imageId, imageDoc, job.requesterOpenId);
    return { ...job, ...patch };
  }

  async function advance(job) {
    if (job.status !== "running" || !job.providerJobId) return job;
    let result;
    try {
      result = await provider.query(job.providerJobId);
    } catch (error) {
      if (error && error.providerCode === "FailedOperation.JobNotExist") {
        const patch = { status: "unknown", errorCode: error.providerCode, updatedAtMs: now() };
        await repo.updateJob(job._id, patch);
        return { ...job, ...patch };
      }
      log.error("storyImages query", String(error && error.message));
      return job;
    }
    if (result.state === "running") return job;
    if (result.state === "failed" || result.state === "blocked") {
      const patch = { status: result.state, errorCode: result.errorCode || "", updatedAtMs: now() };
      await repo.updateJob(job._id, patch);
      return { ...job, ...patch };
    }
    // Two polls can see the same finished job; only the one that claims it stores the file.
    const claimed = await repo.claimJob(job._id, ["running"], { status: "storing", updatedAtMs: now() });
    if (!claimed) return (await repo.getJob(job._id)) || job;
    return store({ ...job, status: "storing" }, result);
  }

  async function loadOwnedJob(ctx, event) {
    const familyId = String((event && event.familyId) || "").trim();
    core.requireOwner(ctx.openid, familyId);
    const jobId = String((event && event.jobId) || "");
    const job = jobId.startsWith(`${familyId}_`) ? await repo.getJob(jobId) : undefined;
    if (!job || job.familyId !== familyId) throw new core.StoryImageError("JOB_NOT_FOUND", "没找到这次配图");
    return job;
  }

  async function status(ctx, event) {
    const job = await advance(await loadOwnedJob(ctx, event));
    if (job.status !== "stored" || !job.imageId) return { job: core.publicJob(job) };
    const image = await repo.getImage(job.imageId);
    if (!image || image.deletedAtMs !== undefined) return { job: core.publicJob(job) };
    const urls = await storage.tempUrls([image.fileID]);
    return { job: core.publicJob(job), image: core.publicImage(image, urls[image.fileID]) };
  }

  async function list(ctx, event) {
    const familyId = String((event && event.familyId) || "").trim();
    core.requireOwner(ctx.openid, familyId);
    const memberId = core.normalizeMemberInput(event);
    const [images, jobs] = await Promise.all([
      repo.listImages(familyId, memberId),
      repo.listRecentJobs(familyId, memberId, now() - RECENT_JOB_WINDOW_MS),
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
    const nowMs = now();
    await repo.updateImage(imageId, { deletedAtMs: nowMs });
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
    const nowMs = now();
    const results = [];
    for (const job of await repo.listActiveJobs(SWEEP_BATCH)) {
      const action = core.sweepAction(job, nowMs);
      try {
        if (action === "mark-unknown") {
          await repo.claimJob(job._id, ["submitted"], { status: "unknown", errorCode: "SUBMIT_INTERRUPTED", updatedAtMs: nowMs });
        } else if (action === "release") {
          await repo.claimJob(job._id, ["storing"], { status: "running", updatedAtMs: nowMs });
        } else if (action === "poll") {
          await advance(job);
        }
      } catch (error) {
        log.error("storyImages sweep", job._id, String(error && error.message));
      }
      results.push({ jobId: job._id, action });
    }
    return { swept: results.length, results };
  }

  /** WeChat pushes wxa_media_check within 30 minutes of a request. */
  async function moderationResult(event) {
    const traceId = String((event && event.trace_id) || "");
    if (!traceId) return { ok: false };
    const image = await repo.findImageByTrace(traceId);
    if (!image) return { ok: false };
    const result = (event && event.result) || {};
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
    return { ok: true };
  }

  return { submit, status, list, remove, sweep, moderationResult };
}

module.exports = { createStoryImageHandlers };
