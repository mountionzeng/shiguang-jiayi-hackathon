import type { ShiguangAppOptions } from "../app";
import { CLOUD_AI_ENABLED } from "../config/runtime";
import { requestAiConsent } from "./aiConsent";
import { requestPhotoAiConsent } from "./photoAiConsent";
import { currentFamilyId } from "./cloudRoomStorage";
import { requestIllustrationReferenceConsent } from "./illustrationReferenceConsent";

export type StoryImageStatus =
  | "submitted" | "queued" | "generating" | "generated" | "storing" | "stored" | "failed" | "blocked" | "unknown" | "expired";

export type StoryImagePurpose = "illustration" | "backdrop";

/** 问题七定的标识文案：记忆里有用户自己的照片，所以说「文字」，不说「图片」。 */
export const CAPTION_LABEL = "文字 AI 生成";
export const CAPTION_EDITED_LABEL = "文字 AI 生成 · 已由你修改";

export interface PhotoCaptionResult {
  status: string;
  caption: string;
  message: string;
  aiGenerated: boolean;
  photos?: Array<{ photoId: string; status: string }>;
}

export interface StoryImageJob {
  jobId: string;
  status: StoryImageStatus;
  message: string;
  chapterId: string;
  purpose: string;
  imageId: string;
  referenceApplied?: boolean;
  referenceImageId?: string;
  createdAtMs: number;
}

export interface StoryImage {
  imageId: string;
  chapterId: string;
  purpose: string;
  url: string;
  bytes: number;
  moderation: string;
  quality: string;
  qualityIssues: string[];
  aiGenerated: true;
  createdAtMs: number;
}

export interface StoryImageList {
  images: StoryImage[];
  pending: StoryImageJob[];
  usage: { count: number; bytes: number };
  limits: { daily: number; book: number };
}

export class StoryImageServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const ACTIVE_STATUSES: StoryImageStatus[] = ["submitted", "queued", "generating", "generated", "storing"];

export function isActiveJob(job: Pick<StoryImageJob, "status">): boolean {
  return ACTIVE_STATUSES.includes(job.status);
}

/** One id per tap, so a retried call never starts a second paid picture. */
export function newImageRequestId(now = Date.now(), random = Math.random): string {
  const suffix = random().toString(36).slice(2, 10).padEnd(8, "0");
  return `req-${now.toString(36)}-${suffix}`;
}

/** The first poll draws the picture and can take tens of seconds; later polls back off. */
export function nextPollDelayMs(elapsedMs: number): number {
  return elapsedMs < 90_000 ? 3_000 : 10_000;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function moderationLabel(moderation: string): string {
  if (moderation === "pending") return "平台审核中";
  if (moderation === "unchecked") return "还没送审";
  if (moderation === "review") return "待人工复核";
  return "";
}

export function qualityLabel(image: Pick<StoryImage, "quality" | "qualityIssues">): string {
  if (image.quality === "flawed") return "有瑕疵：" + (image.qualityIssues.length ? image.qualityIssues.join("、") : "请看大图");
  if (image.quality === "pass") return "";
  if (image.quality === "pending") return "质检中";
  return "没质检";
}

function cloudReady(): boolean {
  if (!CLOUD_AI_ENABLED) return false;
  const app = getApp<ShiguangAppOptions>();
  return Boolean(app && app.globalData && app.globalData.cloudReady && wx.cloud);
}

function imageAiReady(): boolean {
  const app = getApp<ShiguangAppOptions>();
  return Boolean(cloudReady() && app?.globalData?.imageAiReady);
}

function callFailure(error: unknown): StoryImageServiceError {
  const text = String((error as { errMsg?: unknown })?.errMsg ?? (error as Error)?.message ?? error);
  if (/FUNCTION_NOT_FOUND|-501000|could not be found/i.test(text)) {
    return new StoryImageServiceError("FUNCTION_MISSING", "配图云函数还没部署");
  }
  if (/timed? ?out|timeout|-504003/i.test(text)) {
    return new StoryImageServiceError("TIMEOUT", "连接配图服务超时，不确定是否已经开始画，稍后刷新看看");
  }
  return new StoryImageServiceError("CLOUD_FAILED", "配图服务暂时出错，请稍后再试");
}

export async function callStoryImages<T>(action: string, data: Record<string, unknown>, requireImageAi = true): Promise<T> {
  if (!cloudReady() || (requireImageAi && !imageAiReady())) {
    throw new StoryImageServiceError("CLOUD_NOT_READY", "微信云开发还没连上，请重新打开小程序");
  }
  const familyId = await currentFamilyId();
  let raw: unknown;
  try {
    const response = await wx.cloud.callFunction({ name: "storyImages", data: { ...data, action, familyId } });
    raw = response.result;
  } catch (error) {
    throw callFailure(error);
  }
  const result = raw as ({ error?: { code?: unknown; message?: unknown } } & Record<string, unknown>) | undefined;
  if (!result || typeof result !== "object") {
    throw new StoryImageServiceError("MALFORMED", "配图服务返回的内容不完整");
  }
  if (result.error) {
    throw new StoryImageServiceError(String(result.error.code ?? "ERROR"), String(result.error.message ?? "配图没成功"));
  }
  return result as unknown as T;
}

function isJob(value: unknown): value is StoryImageJob {
  const job = value as StoryImageJob | undefined;
  return Boolean(job && typeof job.jobId === "string" && typeof job.status === "string" && typeof job.message === "string");
}

async function submitChapterImage(input: { storyId?: string; memberId?: string; chapterId: string; purpose: StoryImagePurpose; requestId?: string; referenceImageId?: string; artDirection?: string }): Promise<StoryImageJob> {
  if (!await requestAiConsent()) {
    throw new StoryImageServiceError("CONSENT_DECLINED", "本次没有允许使用在线 AI；配图要把这一章的文字发给 AI 服务");
  }
  if (input.referenceImageId) {
    let capabilities: { referenceIllustration?: unknown };
    try {
      capabilities = await callStoryImages("capabilities", {});
    } catch (error) {
      if (error instanceof StoryImageServiceError && error.code === "UNKNOWN_ACTION") {
        throw new StoryImageServiceError("REFERENCE_UNAVAILABLE", "配图服务还没更新到参考旧图功能，请稍后再试");
      }
      throw error;
    }
    if (capabilities.referenceIllustration !== true) {
      throw new StoryImageServiceError("REFERENCE_UNAVAILABLE", "配图服务还没更新到参考旧图功能，请稍后再试");
    }
    if (!await requestIllustrationReferenceConsent(input.referenceImageId)) {
      throw new StoryImageServiceError("CONSENT_DECLINED", "这次没有允许 AI 读取参考插图；你可以直接生成不带参考的配图");
    }
  }
  const result = await callStoryImages<{ job?: unknown }>("submit", {
    ...(input.storyId ? { storyId: input.storyId } : { memberId: input.memberId || "" }),
    chapterId: input.chapterId,
    requestId: input.requestId ?? newImageRequestId(),
    purpose: input.purpose,
    ...(input.referenceImageId ? { referenceImageId: input.referenceImageId } : {}),
    ...(input.artDirection?.trim() ? { artDirection: input.artDirection.trim() } : {}),
  });
  if (!isJob(result.job)) throw new StoryImageServiceError("MALFORMED", "配图服务返回的内容不完整");
  if (result.job.chapterId !== input.chapterId || result.job.purpose !== input.purpose) {
    throw new StoryImageServiceError("REQUEST_CONFLICT", "这次配图对应的章节已经变化，请重新操作");
  }
  if (input.referenceImageId && (result.job.referenceApplied !== true || result.job.referenceImageId !== input.referenceImageId)) {
    throw new StoryImageServiceError("REFERENCE_UNAVAILABLE", "配图服务还没更新到参考旧图功能，请稍后再试");
  }
  return result.job;
}

const bookScope = (bookId?:string) => bookId?.startsWith('story-') ? {storyId:bookId} : (bookId ? {memberId:bookId} : {});

async function checkImageJob(jobId: string,bookId?:string): Promise<{ job: StoryImageJob; image?: StoryImage }> {
  const result = await callStoryImages<{ job?: unknown; image?: StoryImage }>("status", { jobId,...bookScope(bookId) });
  if (!isJob(result.job)) throw new StoryImageServiceError("MALFORMED", "配图服务返回的内容不完整");
  return { job: result.job, image: result.image };
}

async function listStoryImages(bookId: string): Promise<StoryImageList> {
  const result = await callStoryImages<Partial<StoryImageList>>("list", bookId.startsWith("story-") ? { storyId: bookId } : { memberId: bookId });
  if (!Array.isArray(result.images) || !Array.isArray(result.pending) || !result.usage || !result.limits) {
    throw new StoryImageServiceError("MALFORMED", "配图服务返回的内容不完整");
  }
  return result as StoryImageList;
}

/** 看图写一句话：先单独征得同意，再把选中的照片交给云函数，草稿回来标「文字 AI 生成」。 */
async function captionPhotos(input: { photoIds: string[]; requestId?: string }): Promise<PhotoCaptionResult> {
  if (!input.photoIds.length) throw new StoryImageServiceError("INVALID_PHOTOS", "先选一张照片");
  const app = getApp<ShiguangAppOptions>();
  if (!app?.globalData?.aiReady) {
    throw new StoryImageServiceError("TEXT_AI_NOT_READY", "AI 看图写文字尚未开放，你可以自己写一句");
  }
  if (!await requestPhotoAiConsent(input.photoIds.length)) {
    throw new StoryImageServiceError("CONSENT_DECLINED", "这次没有允许把照片发给 AI；你可以自己写一句");
  }
  const result = await callStoryImages<Partial<PhotoCaptionResult>>("caption", {
    photoIds: input.photoIds,
    requestId: input.requestId ?? newImageRequestId(),
  }, false);
  if (typeof result.status !== "string") throw new StoryImageServiceError("MALFORMED", "看图服务返回的内容不完整");
  return {
    status: result.status,
    caption: typeof result.caption === "string" ? result.caption : "",
    message: typeof result.message === "string" ? result.message : "",
    aiGenerated: result.aiGenerated === true,
    photos: Array.isArray(result.photos) ? result.photos : undefined,
  };
}

async function removeStoryImage(imageId: string,bookId?:string): Promise<void> {
  await callStoryImages<{ ok?: boolean }>("remove", { imageId,...bookScope(bookId) });
}

/** Pages call through this object so page tests can stand in for the cloud. */
export const storyImageApi = {
  captionPhotos,
  submitChapterImage,
  checkImageJob,
  listStoryImages,
  removeStoryImage,
};
