const crypto = require("node:crypto");
const core = require("./core");

const DIAGNOSTIC_FAMILY = "_diagnostics";
const DIAGNOSTIC_DAILY_LIMIT = 3;
const MIN_TOKEN_LENGTH = 24;
/** Leave the quality check to the timer when the paid picture already used most of the 60 seconds. */
const QUALITY_START_WINDOW_MS = 45_000;

/** A made-up paragraph: diagnostics never read anyone's book. */
const DIAGNOSTIC_TEXT = "这是用于检查配图服务的虚构段落，不属于任何真实故事。清晨，小镇河边的石桥上落着一层薄霜，桥下停着一只木船，岸边的柳树刚冒出新芽。";
const DIAGNOSTIC_CHAPTER = { title: "测试章节（虚构）", text: DIAGNOSTIC_TEXT, textLength: DIAGNOSTIC_TEXT.length };
const DIAGNOSTIC_SCENE = {
  scene: "清晨小镇河边的石桥与木船",
  setting: "清晨的小镇河边",
  objects: ["石桥", "木船", "柳树"],
  light: "清晨薄霜",
  mood: "安静",
  eraHint: "",
  figures: [],
};

/** Same rule as the collection bootstrap: a long token that only the console knows. */
function authorizeDiagnose(event, expectedToken) {
  const given = Buffer.from(String((event && event.diagnoseToken) || ""));
  const expected = Buffer.from(String(expectedToken || ""));
  if (expected.length < MIN_TOKEN_LENGTH || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

/** Error codes and short messages only; nothing here carries a key or a request body. */
function describeError(error) {
  const code = (error && (error.code || (error.httpStatus ? `HTTP_${error.httpStatus}` : "") || error.errCode || error.name)) || "ERROR";
  return { code: String(code).slice(0, 40), message: String((error && error.message) || error).slice(0, 120) };
}

/**
 * Checks, from the developer tools' cloud test, whether storyImages can really work:
 * config (which settings are present, free), scene (the text model on a made-up paragraph)
 * and image (one paid picture from a fixed made-up prompt, through storage, moderation and quality).
 */
function createDiagnostics({
  repo,
  provider,
  extractScene,
  sceneConfigured,
  qualityChecker,
  storage,
  moderation,
  downloadImage,
  expectedToken,
  runtime = process.version,
  now = () => Date.now(),
}) {
  async function step(steps, name, action) {
    const startedMs = now();
    try {
      const detail = await action();
      steps.push({ name, ok: true, ms: now() - startedMs, ...(detail || {}) });
      return { ok: true, detail: detail || {} };
    } catch (error) {
      steps.push({ name, ok: false, ms: now() - startedMs, error: describeError(error) });
      return { ok: false, error };
    }
  }

  const qualityEnabled = () => Boolean(qualityChecker && qualityChecker.configured);

  async function run(ctx, event) {
    if (!authorizeDiagnose(event, expectedToken)) {
      throw new core.StoryImageError("DIAGNOSE_FORBIDDEN", "诊断口令不对，或云函数还没配置 STORY_IMAGES_DIAGNOSE_TOKEN");
    }
    const mode = String((event && event.sample) || "config");
    const base = {
      mode,
      runtime,
      configured: { image: Boolean(provider.configured), sceneModel: Boolean(sceneConfigured), quality: qualityEnabled() },
      hasOpenId: Boolean(ctx.openid),
    };
    if (mode === "config") return { ok: true, ...base };
    if (mode === "scene") return runScene(base);
    if (mode === "image") return runImage(ctx, base);
    throw new core.StoryImageError("DIAGNOSE_UNKNOWN_MODE", "sample 只能是 scene 或 image，不填就是只检查配置");
  }

  async function runScene(base) {
    if (!sceneConfigured) {
      return { ok: false, ...base, steps: [{ name: "scene", ok: false, ms: 0, error: { code: "AI_NOT_CONFIGURED", message: "AI_API_KEY 或 AI_MODEL 没有配置" } }] };
    }
    const steps = [];
    const outcome = await step(steps, "scene", async () => {
      const scene = await extractScene(DIAGNOSTIC_CHAPTER);
      return { scene, prompt: core.buildImagePrompt(scene, "illustration").prompt };
    });
    return { ok: outcome.ok, ...base, steps };
  }

  async function runImage(ctx, base) {
    if (!provider.configured) {
      return { ok: false, ...base, steps: [{ name: "generate", ok: false, ms: 0, error: { code: "IMAGE_NOT_CONFIGURED", message: "TOKENHUB_API_KEY 没有配置" } }] };
    }
    const runStartedMs = now();
    const dayKey = core.chinaDayKey(runStartedMs);
    const used = await repo.countJobs({ familyId: DIAGNOSTIC_FAMILY, dayKey, statuses: core.COUNTED_STATUSES });
    if (used >= DIAGNOSTIC_DAILY_LIMIT) {
      throw new core.StoryImageError("DIAGNOSE_LIMIT", `今天已经试画 ${DIAGNOSTIC_DAILY_LIMIT} 张，明天再试`);
    }

    const requestId = `req-diag-${runStartedMs.toString(36)}`;
    const jobId = `${DIAGNOSTIC_FAMILY}_${requestId}`;
    const { prompt, width, height } = core.buildImagePrompt(DIAGNOSTIC_SCENE, "illustration");
    await repo.createJob(jobId, {
      familyId: DIAGNOSTIC_FAMILY,
      requesterOpenId: ctx.openid || "",
      requestId,
      memberId: DIAGNOSTIC_FAMILY,
      storyId: "",
      chapterId: "",
      purpose: "diagnostic",
      provider: provider.name,
      model: provider.model,
      prompt,
      width,
      height,
      referencePhotoCount: 0,
      status: "generating",
      dayKey,
      createdAtMs: runStartedMs,
      updatedAtMs: runStartedMs,
    });
    const steps = [];
    const done = (ok, jobStatus, extra = {}) => ({ ok, ...base, jobStatus, prompt, ...extra, steps });

    const generated = await step(steps, "generate", async () => {
      const result = await provider.generate({ prompt, width, height });
      return { size: `${width}x${height}`, revisedPrompt: result.revisedPrompt || "", usageTokens: result.usageTokens || 0, resultUrl: result.resultUrl };
    });
    if (!generated.ok) {
      const outcome = core.classifyGenerateError(generated.error);
      await repo.updateJob(jobId, { status: outcome.status, errorCode: outcome.errorCode, updatedAtMs: now() });
      return done(false, outcome.status);
    }
    const { resultUrl } = generated.detail;
    await repo.updateJob(jobId, {
      status: "generated",
      resultUrl,
      revisedPrompt: generated.detail.revisedPrompt,
      usageTokens: generated.detail.usageTokens,
      updatedAtMs: now(),
    });

    let image;
    const downloaded = await step(steps, "download", async () => {
      image = await downloadImage(resultUrl);
      return { bytes: image.buffer.length, contentType: image.contentType };
    });
    if (!downloaded.ok) return done(false, "generated");

    let fileID;
    const cloudPath = `story-images/${DIAGNOSTIC_FAMILY}/${requestId}.${core.extensionFor(image.contentType)}`;
    const uploaded = await step(steps, "upload", async () => {
      fileID = await storage.upload(cloudPath, image.buffer);
      return { fileID };
    });
    if (!uploaded.ok) return done(false, "generated");

    const imageId = `${DIAGNOSTIC_FAMILY}_img_${requestId}`;
    const qualityFits = () => now() - runStartedMs <= QUALITY_START_WINDOW_MS;
    await repo.createImage(imageId, {
      familyId: DIAGNOSTIC_FAMILY,
      memberId: DIAGNOSTIC_FAMILY,
      storyId: "",
      chapterId: "",
      purpose: "diagnostic",
      fileID,
      width,
      height,
      bytes: image.buffer.length,
      contentType: image.contentType,
      moderation: "unchecked",
      quality: qualityEnabled() ? "pending" : "unchecked",
      qualityIssues: [],
      aiGenerated: true,
      jobId,
      createdAtMs: now(),
    });
    await repo.updateJob(jobId, { status: "stored", imageId, updatedAtMs: now() });

    if (ctx.openid) {
      await step(steps, "moderation", async () => {
        const traceId = await moderation.check({ fileID, openid: ctx.openid });
        await repo.updateImage(imageId, { moderation: "pending", moderationTraceId: traceId });
        return { traceId, note: "检测结果会在 30 分钟内由微信推送" };
      });
    } else {
      steps.push({ name: "moderation", ok: false, skipped: true, ms: 0, error: { code: "NO_OPENID", message: "这次调用没有带微信用户身份，内容安全检测需要 openid" } });
    }

    if (!qualityEnabled()) {
      steps.push({ name: "quality", ok: false, skipped: true, ms: 0, error: { code: "VISION_NOT_CONFIGURED", message: "没有可用的看图模型密钥" } });
    } else if (!qualityFits()) {
      steps.push({ name: "quality", ok: false, skipped: true, ms: 0, error: { code: "NO_TIME", message: "这次调用剩余时间不够，质检留给定时任务" } });
    } else {
      await step(steps, "quality", async () => {
        const url = (await storage.tempUrls([fileID]))[fileID];
        if (!url) throw new Error("TEMP_URL_UNAVAILABLE");
        const outcome = await qualityChecker.check(url);
        await repo.updateImage(imageId, {
          quality: outcome.quality,
          qualityIssues: outcome.qualityIssues || [],
          qualityNote: outcome.qualityNote || "",
          qualityError: outcome.qualityError || "",
        });
        return { quality: outcome.quality, issues: outcome.qualityIssues || [], note: outcome.qualityNote || "", qualityError: outcome.qualityError || "" };
      });
    }

    const viewUrl = (await storage.tempUrls([fileID]))[fileID] || "";
    return done(steps.every(item => item.ok || item.skipped), "stored", { imageId, fileID, viewUrl, totalMs: now() - runStartedMs });
  }

  return { run };
}

module.exports = {
  DIAGNOSTIC_CHAPTER,
  DIAGNOSTIC_DAILY_LIMIT,
  DIAGNOSTIC_FAMILY,
  authorizeDiagnose,
  createDiagnostics,
};
