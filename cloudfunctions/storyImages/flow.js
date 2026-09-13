const core = require("./core");

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
    downloadImage,
    qualityChecker,
    now = () => Date.now(),
    log = console,
  } = deps;
  const qualityEnabled = Boolean(qualityChecker && qualityChecker.configured);

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

    // The record is written before any model call, so an interrupted request still leaves a trace.
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
    const patch = { status: "queued", prompt, scene, width, height, queuedAtMs: now(), updatedAtMs: now() };
    await repo.updateJob(jobId, patch);
    return { job: core.publicJob({ ...job, ...patch }) };
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
    let result;
    try {
      result = await provider.generate({ prompt: job.prompt, width: job.width, height: job.height });
    } catch (error) {
      const outcome = core.classifyGenerateError(error);
      log.error("storyImages generate", outcome.errorCode, String(error && error.message));
      const patch = { status: outcome.status, errorCode: outcome.errorCode, updatedAtMs: now() };
      await repo.updateJob(job._id, patch);
      return { ...job, ...patch };
    }
    // The link is saved first, so a failed upload retries from it instead of paying for a new picture.
    const patch = {
      status: "generated",
      resultUrl: result.resultUrl,
      revisedPrompt: result.revisedPrompt || "",
      providerJobId: result.providerJobId || "",
      usageTokens: result.usageTokens || 0,
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

    const imageId = `${job.familyId}_img_${job.requestId}`;
    const cloudPath = `story-images/${job.familyId}/${job.memberId}/${job.requestId}.${core.extensionFor(image.contentType)}`;
    let fileID;
    try {
      fileID = await storage.upload(cloudPath, image.buffer);
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
      bytes: image.buffer.length,
      contentType: image.contentType,
      moderation: "unchecked",
      quality: qualityEnabled ? "pending" : "unchecked",
      qualityIssues: [],
      aiGenerated: true,
      jobId: job._id,
      createdAtMs: nowMs,
    };
    await repo.createImage(imageId, imageDoc);
    const patch = { status: "stored", imageId, storedAtMs: nowMs, updatedAtMs: nowMs };
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
    const jobId = String((event && event.jobId) || "");
    const job = jobId.startsWith(`${familyId}_`) ? await repo.getJob(jobId) : undefined;
    if (!job || job.familyId !== familyId) throw new core.StoryImageError("JOB_NOT_FOUND", "没找到这次配图");
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
          await repo.claimJob(job._id, ["generating"], { status: "unknown", errorCode: "GENERATE_INTERRUPTED", updatedAtMs: now() });
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
