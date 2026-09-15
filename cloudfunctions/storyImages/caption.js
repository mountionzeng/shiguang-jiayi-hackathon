const core = require("./core");

const CAPTION_DAILY_LIMIT = 30;
const CAPTION_MAX_PHOTOS = 3;
const CAPTION_MAX_LENGTH = 60;
const CAPTION_TIMEOUT_MS = 15_000;
/** A request that reached the model, or may have, counts toward the daily limit. */
const CAPTION_COUNTED_STATUSES = ["submitted", "ok", "unknown"];
const PHOTO_ID_PATTERN = /^photo-[a-z0-9-]{1,80}$/;
const REQUEST_ID_PATTERN = /^req-[0-9a-z-]{8,60}$/;
const FALLBACK_MESSAGE = "没看出来，自己写一句吧";

const CAPTION_PROMPT = [
  "请看这几张照片，帮用户起草一句回忆的开头。",
  "只写照片里看得见的场景、物件、光线、季节和年代线索，用一句中文，不超过 60 个字。",
  "不猜照片里的人是谁，不写姓名、关系和长相。",
  "看不清就只回答：看不清。",
  "只输出这一句话，不加引号，不加解释。",
].join("\n");

const PHOTO_MESSAGES = {
  not_uploaded: "这张照片还没存到云端，稍后再试",
  deleted: "这张照片已经删掉了",
  too_large: "这张照片太大了，换一张试试",
  forbidden: "没找到这张照片",
  not_found: "没找到这张照片",
};

function normalizeCaptionInput(event) {
  const input = event || {};
  const familyId = String(input.familyId || "").trim();
  const requestId = String(input.requestId || "").trim();
  const photoIds = Array.isArray(input.photoIds) ? input.photoIds.map(id => String(id || "").trim()) : [];
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new core.StoryImageError("INVALID_REQUEST", "请求编号无效，请重试");
  if (photoIds.length < 1 || photoIds.length > CAPTION_MAX_PHOTOS) {
    throw new core.StoryImageError("INVALID_PHOTOS", `一次选 1 到 ${CAPTION_MAX_PHOTOS} 张照片`);
  }
  if (!photoIds.every(id => PHOTO_ID_PATTERN.test(id)) || new Set(photoIds).size !== photoIds.length) {
    throw new core.StoryImageError("INVALID_PHOTOS", "照片信息不完整");
  }
  return { familyId, requestId, photoIds };
}

/** First non-empty line, quotes removed, at most 60 characters. "看不清" means no draft. */
function parseCaption(content) {
  const firstLine = String(content || "").split(/\r?\n/).map(line => line.trim()).find(Boolean) || "";
  const unquoted = firstLine.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "");
  const text = core.cleanText(unquoted, CAPTION_MAX_LENGTH * 2);
  if (!text || /^看不清/.test(text)) return { unclear: true, caption: "" };
  return { unclear: false, caption: Array.from(text).slice(0, CAPTION_MAX_LENGTH).join("") };
}

/** 422 is a content check and other 4xx a refusal; timeouts and server errors may have reached the model. */
function classifyVisionError(errorCode) {
  const match = /^VISION_HTTP_(\d{3})$/.exec(String(errorCode || ""));
  if (match) {
    const status = Number(match[1]);
    if (status === 422) return "blocked";
    if (status >= 400 && status < 500) return "failed";
  }
  return "unknown";
}

/**
 * 看图写一句话: reads 1–3 of the owner's cloud photos (small, base64) through photoAccess,
 * asks the vision model for one sentence and hands it back as a draft marked AI-generated.
 * The log keeps who, which photos and the outcome; it never keeps the sentence or the photos.
 */
function createCaptionHandler({ repo, vision, readPhotos, now = () => Date.now(), log = console }) {
  async function caption(ctx, event) {
    const input = normalizeCaptionInput(event);
    core.requireOwner(ctx.openid, input.familyId);
    if (!vision.configured) throw new core.StoryImageError("VISION_NOT_CONFIGURED", "看图服务还没配置好");

    const logId = `${input.familyId}_${input.requestId}`;
    if (await repo.getCaptionLog(logId)) {
      throw new core.StoryImageError("DUPLICATE_REQUEST", "这一次已经看过了，请重新点一下");
    }
    const nowMs = now();
    const dayKey = core.chinaDayKey(nowMs);
    const used = await repo.countCaptionLogs({ familyId: input.familyId, dayKey, statuses: CAPTION_COUNTED_STATUSES });
    if (used >= CAPTION_DAILY_LIMIT) {
      throw new core.StoryImageError("CAPTION_LIMIT", `今天已经看了 ${CAPTION_DAILY_LIMIT} 次，明天再来`);
    }

    await repo.createCaptionLog(logId, {
      familyId: input.familyId,
      requesterOpenId: ctx.openid,
      requestId: input.requestId,
      photoIds: input.photoIds,
      photoCount: input.photoIds.length,
      model: vision.model || "",
      status: "submitted",
      dayKey,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    const finish = async (status, extra = {}) => {
      await repo.updateCaptionLog(logId, { status, ...extra, updatedAtMs: now() });
    };

    let photos;
    try {
      photos = await readPhotos({
        familyId: input.familyId,
        photoIds: input.photoIds,
        variant: "small",
        format: "base64",
        purpose: "ai-caption",
        onBehalfOfOpenid: ctx.openid,
      });
    } catch (error) {
      log.error("storyImages caption read", String(error && (error.code || error.message)));
      await finish("failed", { errorCode: String((error && error.code) || "PHOTO_READ_FAILED").slice(0, 40) });
      return { status: "failed", message: "照片暂时读不出来，稍后再试", aiGenerated: false };
    }

    const unavailable = photos.filter(photo => photo.status !== "ok" || typeof photo.base64 !== "string" || !photo.base64);
    if (unavailable.length) {
      await finish("failed", { errorCode: "PHOTO_UNAVAILABLE" });
      return {
        status: "photo_unavailable",
        message: PHOTO_MESSAGES[unavailable[0].status] || "没找到这张照片",
        photos: unavailable.map(photo => ({ photoId: photo.photoId, status: photo.status === "ok" ? "not_found" : photo.status })),
        aiGenerated: false,
      };
    }

    const images = photos.map(photo => `data:${photo.contentType || "image/jpeg"};base64,${photo.base64}`);
    const answer = await vision.ask({ text: CAPTION_PROMPT, images, timeoutMs: CAPTION_TIMEOUT_MS });
    if (!answer.ok) {
      const status = classifyVisionError(answer.errorCode);
      await finish(status, { errorCode: answer.errorCode });
      return { status, message: FALLBACK_MESSAGE, aiGenerated: false };
    }

    const parsed = parseCaption(answer.content);
    await finish("ok", { unclear: parsed.unclear, captionLength: Array.from(parsed.caption).length });
    if (parsed.unclear) return { status: "unclear", message: FALLBACK_MESSAGE, aiGenerated: false };
    return { status: "ok", caption: parsed.caption, aiGenerated: true, message: "" };
  }

  return { caption };
}

module.exports = {
  CAPTION_COUNTED_STATUSES,
  CAPTION_DAILY_LIMIT,
  CAPTION_MAX_LENGTH,
  CAPTION_PROMPT,
  classifyVisionError,
  createCaptionHandler,
  normalizeCaptionInput,
  parseCaption,
};
