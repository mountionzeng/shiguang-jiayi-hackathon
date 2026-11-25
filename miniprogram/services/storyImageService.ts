import { withComputeRequest, finishImageComputeRequest } from "./computeRequest";
import { prepareReferencePhotos } from "./referencePhotos";
import { classifyServiceFailure, logServiceFailure } from './serviceFailure';
import { measurePerformance } from "./performanceLog";
import { promptComputeBillingFailure } from "./computeBillingPrompt";
import type { ShiguangAppOptions } from "../app";
import { CLOUD_AI_ENABLED } from "../config/runtime";
import { requestAiConsent } from "./aiConsent";
import { requestPhotoAiConsent } from "./photoAiConsent";
import { cachedAccountScope, currentFamilyId } from "./cloudRoomStorage";
import { requestIllustrationReferenceConsent } from "./illustrationReferenceConsent";
import { sha256Hex } from "../domain/chapterPackage";

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
  memoryId?: string;
  jobId: string;
  status: StoryImageStatus;
  message: string;
  chapterId: string;
  purpose: string;
  imageId: string;
  referenceApplied?: boolean;
  referenceImageId?: string;
  referencePhotoIds?: string[];
  ideaApplied?: boolean;
  createdAtMs: number;
}

export interface StoryImage {
  originImageId?: string;
  crop?: {x:number;y:number;width:number;height:number};
  sourceText?: string;
  sourceKind?: "selection" | "memory" | "chapter" | "upload" | "";
  memoryId?: string;
  imageId: string;
  chapterId: string;
  purpose: string;
  url: string;
  bytes: number;
  moderation: string;
  quality: string;
  qualityIssues: string[];
  aiGenerated: boolean;
  createdAtMs: number;
}

export interface StoryImageList {
  images: StoryImage[];
  pending: StoryImageJob[];
  usage: { count: number; bytes: number };
  limits: { daily: number | null; book: number | null; unlimited?: boolean };
}

export class StoryImageServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

class AdditionalImageRejectedError extends StoryImageServiceError {}

function checkAdditionalImageRejection(result: { job?: unknown; rejection?: unknown }, requestId?: string): void {
  if (result.rejection === undefined) return;
  const receipt = result.rejection as { state?: unknown; code?: unknown; requestId?: unknown } | null;
  if (result.job !== null || !requestId || receipt?.requestId !== requestId ||
      receipt.state !== "rejected_before_create" || receipt.code !== "ART_DIRECTION_BLOCKED") {
    throw new StoryImageServiceError("MALFORMED", "原配图任务的拒绝回执不完整，请稍后核对");
  }
  throw new AdditionalImageRejectedError("ART_DIRECTION_BLOCKED", "这段美术想法没通过平台审核，请改写后再试");
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
  const kind = classifyServiceFailure(error);
  if (kind === 'missing') {
    return new StoryImageServiceError("FUNCTION_MISSING", "配图云函数还没部署");
  }
  if (kind === 'timeout') {
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
    const operation = action === "submit" ? "image.submit" : action === "status" ? "image.status" : action === "list" ? "image.list" : "image.other";
    const computeRequestId = typeof data.computeRequestId === "string" ? data.computeRequestId : typeof data.requestId === "string" ? data.requestId : undefined;
    const response = await measurePerformance(operation, () => wx.cloud.callFunction({ name: "storyImages", data: { ...data, action, familyId, ...(computeRequestId ? { computeRequestId } : {}) } }));
    raw = response.result;
  } catch (error) {
    if (['submit', 'caption'].includes(action)) promptComputeBillingFailure(error);
    logServiceFailure('storyImages', ['selectCover', 'remove'].includes(action) ? 'write' : ['submit', 'caption'].includes(action) ? 'ai' : 'read', error);
    const failure = callFailure(error);
    if (["submit", "caption"].includes(action) && ["CLOUD_FAILED", "TIMEOUT"].includes(failure.code)) {
      throw Object.assign(failure, { billingState: { phase: "unknown" } });
    }
    throw failure;
  }
  const result = raw as ({ error?: { code?: unknown; message?: unknown } } & Record<string, unknown>) | undefined;
  if (!result || typeof result !== "object") {
    const failure = new StoryImageServiceError("MALFORMED", "配图服务返回的内容不完整");
    if (["submit", "caption"].includes(action)) throw Object.assign(failure, { billingState: { phase: "unknown" } });
    throw failure;
  }
  if (result.error) {
    const failure = new StoryImageServiceError(String(result.error.code ?? "ERROR"), String(result.error.message ?? "配图没成功"));
    if (['submit', 'caption'].includes(action)) promptComputeBillingFailure(failure);
    throw failure;
  }
  return result as unknown as T;
}

const imageTerminalStatuses = new Set<StoryImageStatus>(["stored", "failed", "blocked", "expired"]);

export async function submitPaidImage<T extends { job?: unknown }>(data: Record<string, unknown>): Promise<T> {
  const { requestId, ...payload } = data;
  if (typeof requestId === "string") return callStoryImages<T>("submit", { ...payload, requestId });
  await currentFamilyId();
  return withComputeRequest(`image:submit:${JSON.stringify(payload)}`,
    id => callStoryImages<T>("submit", { ...payload, requestId: id }), {
      createId: newImageRequestId,
      retainUntilImageStatus: true,
      retain: result => !isJob(result.job) || !imageTerminalStatuses.has(result.job.status),
    });
}

function isJob(value: unknown): value is StoryImageJob {
  const job = value as StoryImageJob | undefined;
  return Boolean(job && typeof job.jobId === "string" && typeof job.status === "string" && typeof job.message === "string");
}

interface ChapterImageScope {
  memoryId?: string;
  storyId?: string;
  memberId?: string;
  chapterId: string;
  purpose: StoryImagePurpose;
}

interface ChapterImageInput extends ChapterImageScope {
  requestId?: string;
  referenceImageId?: string;
  referencePhotoIds?: string[];
  phoneReferencePhotoIds?: string[];
  artDirection?: string;
  selectedText?: string;
  selectedBlockId?: string;
}

async function submitChapterImage(input: ChapterImageInput, additionalImage = false): Promise<StoryImageJob> {
  if (!await requestAiConsent()) {
    throw new StoryImageServiceError("CONSENT_DECLINED", "本次没有允许使用在线 AI；配图需要读取已保存的文字");
  }
  let capabilities: { memoryImages?: unknown; referenceIllustration?: unknown; referencePhotos?: unknown; guidedGeneration?: unknown; selectedTextImages?: unknown } | undefined;
  const loadCapabilities = async (unavailable: () => StoryImageServiceError) => {
    try {
      if (!capabilities) capabilities = await callStoryImages("capabilities", {});
    } catch (error) {
      if (error instanceof StoryImageServiceError && error.code === "UNKNOWN_ACTION") throw unavailable();
      throw error;
    }
    return capabilities as { memoryImages?: unknown; referenceIllustration?: unknown; referencePhotos?: unknown; guidedGeneration?: unknown; selectedTextImages?: unknown };
  };
  if (input.selectedText) {
    const supported = await loadCapabilities(() => new StoryImageServiceError('SELECTION_UNAVAILABLE', '选中文字配图服务正在更新，请稍后再试'));
    if (supported.selectedTextImages !== true) throw new StoryImageServiceError('SELECTION_UNAVAILABLE', '选中文字配图服务正在更新，请稍后再试');
  }
  if (input.memoryId) {
    const supported = await loadCapabilities(() => new StoryImageServiceError('MEMORY_IMAGES_UNAVAILABLE', '记忆配图服务正在更新，请稍后再试'));
    if (supported.memoryImages !== true) throw new StoryImageServiceError('MEMORY_IMAGES_UNAVAILABLE', '记忆配图服务正在更新，请稍后再试');
  }
  const referencePhotoIds = [...new Set((input.referencePhotoIds || []).map(id => String(id || "").trim()).filter(Boolean))].slice(0, 3);
  const phoneReferencePhotoIds = (input.phoneReferencePhotoIds || []).filter(id => referencePhotoIds.includes(id));
  if (input.referenceImageId) {
    capabilities = await loadCapabilities(() =>
      new StoryImageServiceError("REFERENCE_UNAVAILABLE", "配图服务还没更新到参考旧图功能，请稍后再试"));
    if (capabilities.referenceIllustration !== true) {
      throw new StoryImageServiceError("REFERENCE_UNAVAILABLE", "配图服务还没更新到参考旧图功能，请稍后再试");
    }
    if (!await requestIllustrationReferenceConsent(input.referenceImageId)) {
      throw new StoryImageServiceError("CONSENT_DECLINED", "这次没有允许 AI 读取参考插图；你可以直接生成不带参考的配图");
    }
  }
  if (referencePhotoIds.length) {
    capabilities = await loadCapabilities(() =>
      new StoryImageServiceError("REFERENCE_PHOTOS_UNAVAILABLE", "配图服务还没更新到参考本章照片功能，请稍后再试"));
    if (capabilities.referencePhotos !== true) {
      throw new StoryImageServiceError("REFERENCE_PHOTOS_UNAVAILABLE", "配图服务还没更新到参考本章照片功能，请稍后再试");
    }
    if (!await requestPhotoAiConsent(referencePhotoIds.length, "illustration-reference")) {
      throw new StoryImageServiceError("CONSENT_DECLINED", "这次没有允许 AI 读取本章照片；不会发送照片给配图服务");
    }
  }
  if (input.artDirection?.trim()) {
    const supported = await loadCapabilities(() =>
      new StoryImageServiceError("GUIDED_GENERATION_UNAVAILABLE", "配图服务还没更新到画面想法功能，请稍后再试"));
    if (supported.guidedGeneration !== true) {
      throw new StoryImageServiceError("GUIDED_GENERATION_UNAVAILABLE", "配图服务还没更新到画面想法功能，请稍后再试");
    }
  }
  await prepareReferencePhotos(referencePhotoIds);
  const result = await submitPaidImage<{ job?: unknown; rejection?: unknown }>({
    ...(input.memoryId ? {memoryId: input.memoryId} : input.storyId ? { storyId: input.storyId } : { memberId: input.memberId || "" }),
    chapterId: input.chapterId,
    ...(input.selectedText ? { selectedText: input.selectedText, selectedBlockId: input.selectedBlockId } : {}),
    requestId: input.requestId,
    ...(additionalImage ? { additionalImage: true } : {}),
    purpose: input.purpose,
    ...(input.referenceImageId ? { referenceImageId: input.referenceImageId } : {}),
    ...(referencePhotoIds.length ? { referencePhotoIds, phoneReferencePhotoIds, photoReferenceConsent: true } : {}),
    ...(input.artDirection?.trim() ? { artDirection: input.artDirection.trim() } : {}),
  });
  checkAdditionalImageRejection(result, additionalImage ? input.requestId : undefined);
  if (!isJob(result.job)) throw new StoryImageServiceError("MALFORMED", "配图服务返回的内容不完整");
  if (result.job.memoryId !== input.memoryId || result.job.chapterId !== input.chapterId || result.job.purpose !== input.purpose ||
      (additionalImage && result.job.jobId !== `${await currentFamilyId()}_${input.requestId}`)) {
    throw new StoryImageServiceError("REQUEST_CONFLICT", "这次配图对应的章节已经变化，请重新操作");
  }
  if (input.referenceImageId && (result.job.referenceApplied !== true || result.job.referenceImageId !== input.referenceImageId)) {
    throw new StoryImageServiceError("REFERENCE_UNAVAILABLE", "配图服务还没更新到参考旧图功能，请稍后再试");
  }
  if (referencePhotoIds.length) {
    const applied = Array.isArray(result.job.referencePhotoIds) ? result.job.referencePhotoIds : [];
    if (result.job.referenceApplied !== true || JSON.stringify(applied) !== JSON.stringify(referencePhotoIds)) {
      throw new StoryImageServiceError("REFERENCE_PHOTOS_UNAVAILABLE", "配图服务没有使用本章照片，请稍后再试");
    }
  }
  if (input.artDirection?.trim() && result.job.ideaApplied !== true) {
    throw new StoryImageServiceError("GUIDED_GENERATION_UNAVAILABLE", "配图服务没有使用你的画面想法，请稍后再试");
  }
  return result.job;
}

type AdditionalImageIntent = ChapterImageInput & { requestId: string };

function chapterImageScope(input: ChapterImageScope): ChapterImageScope {
  return {
    ...(input.memoryId ? { memoryId: input.memoryId } : input.storyId ? { storyId: input.storyId } : { memberId: input.memberId }),
    chapterId: input.chapterId,
    purpose: input.purpose,
  };
}

async function additionalIntentKey(scope: ChapterImageScope): Promise<string> {
  await currentFamilyId();
  const account = cachedAccountScope();
  if (!account) throw new StoryImageServiceError("CLOUD_NOT_READY", "请重新登录后核对原配图任务");
  return "additional-image:v1:" + sha256Hex(JSON.stringify([account, chapterImageScope(scope)]));
}

function readAdditionalIntent(key: string, scope: ChapterImageScope): AdditionalImageIntent | undefined {
  const intent = wx.getStorageSync<AdditionalImageIntent>(key);
  if (!intent) return undefined;
  if (!/^req-[a-z0-9]+-[a-z0-9]{8}$/.test(intent.requestId) ||
      JSON.stringify(chapterImageScope(intent)) !== JSON.stringify(chapterImageScope(scope))) {
    throw new StoryImageServiceError("REQUEST_CONFLICT", "本机另开任务记录无法确认，请核对原任务");
  }
  return intent;
}

async function lookupChapterImage(scope: ChapterImageScope, requestId?: string): Promise<StoryImageJob | null> {
  const result = await callStoryImages<{ job?: unknown; rejection?: unknown }>("recover", {
    ...chapterImageScope(scope),
    ...(requestId ? { requestId } : {}),
  });
  checkAdditionalImageRejection(result, requestId);
  if (result.job === null) return null;
  if (!isJob(result.job) || result.job.chapterId !== scope.chapterId || result.job.purpose !== scope.purpose ||
      result.job.memoryId !== scope.memoryId ||
      (requestId && result.job.jobId !== `${await currentFamilyId()}_${requestId}`)) {
    throw new StoryImageServiceError("MALFORMED", "原配图任务回执不完整，请稍后核对");
  }
  return result.job;
}

function closeAdditionalImage(key: string, intent: AdditionalImageIntent): void {
  try {
    // A response for an earlier request may arrive after a new intent was saved.
    if (readAdditionalIntent(key, intent)?.requestId === intent.requestId) wx.removeStorageSync(key);
  } catch { /* A retained receipt replays the same job. */ }
}

async function finishAdditionalImage(key: string, intent: AdditionalImageIntent): Promise<StoryImageJob> {
  // A missing reply does not prove that dispatch failed. Use the saved payload
  // and ID until the server confirms a job or a terminal rejection.
  try {
    const job = await lookupChapterImage(intent, intent.requestId) ?? await submitChapterImage(intent, true);
    closeAdditionalImage(key, intent);
    return job;
  } catch (error) {
    if (error instanceof AdditionalImageRejectedError) closeAdditionalImage(key, intent);
    throw error;
  }
}

async function recoverChapterImage(scope: ChapterImageScope): Promise<StoryImageJob | null> {
  const key = await additionalIntentKey(scope);
  const intent = readAdditionalIntent(key, scope);
  return intent ? finishAdditionalImage(key, intent) : lookupChapterImage(scope);
}

async function startAdditionalChapterImage(input: ChapterImageInput): Promise<StoryImageJob> {
  const key = await additionalIntentKey(input);
  let intent = readAdditionalIntent(key, input);
  if (!intent) {
    intent = { ...input, requestId: newImageRequestId() };
    // Persist before any cloud submit. A storage error stops the paid action.
    wx.setStorageSync(key, intent);
  }
  return finishAdditionalImage(key, intent);
}

const bookScope = (bookId?:string) => bookId?.startsWith('story-') ? {storyId:bookId} : (bookId ? {memberId:bookId} : {});

async function checkImageJob(jobId: string,bookId?:string,memoryId?:string): Promise<{ job: StoryImageJob; image?: StoryImage }> {
  const result = await callStoryImages<{ job?: unknown; image?: StoryImage }>("status", { jobId,...(memoryId ? {memoryId} : bookScope(bookId)) });
  if (!isJob(result.job)) throw new StoryImageServiceError("MALFORMED", "配图服务返回的内容不完整");
  if (memoryId && result.job.memoryId !== memoryId) throw new StoryImageServiceError("MALFORMED", "配图来源不一致，请重新打开");
  if (imageTerminalStatuses.has(result.job.status)) {
    finishImageComputeRequest(result.job.jobId.slice(result.job.jobId.lastIndexOf("_") + 1));
  }
  return { job: result.job, image: result.image };
}

async function listStoryImages(bookId: string, memoryId?: string): Promise<StoryImageList> {
  const result = await callStoryImages<Partial<StoryImageList> & { finishedRequestIds?: unknown[] }>("list", memoryId ? {memoryId} : bookId.startsWith("story-") ? { storyId: bookId } : { memberId: bookId });
  if (!Array.isArray(result.images) || !Array.isArray(result.pending) || !result.usage || !result.limits) {
    throw new StoryImageServiceError("MALFORMED", "配图服务返回的内容不完整");
  }
  for (const requestId of Array.isArray(result.finishedRequestIds) ? result.finishedRequestIds : []) {
    if (typeof requestId === "string") finishImageComputeRequest(requestId);
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
  await currentFamilyId();
  const send = (requestId: string) =>
    callStoryImages<Partial<PhotoCaptionResult>>("caption", { photoIds: input.photoIds, requestId }, false);
  const result = input.requestId ? await send(input.requestId) : await withComputeRequest(
    `image:caption:${JSON.stringify(input.photoIds)}`, send,
    { createId: newImageRequestId, retain: value => !value.status || value.status === "unknown" },
  );
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
  async selectMemoryImage(memoryId: string, imageId: string, remove = false): Promise<void> {
    const result = await callStoryImages<{ok?: boolean}>('selectMemoryImage', {memoryId, imageId, remove});
    if (result.ok !== true) throw new StoryImageServiceError('MALFORMED', '配图未确认保存，请重新打开核对');
  },
  captionPhotos,
  submitChapterImage,
  recoverChapterImage,
  startAdditionalChapterImage,
  checkImageJob,
  listStoryImages,
  removeStoryImage,
};
