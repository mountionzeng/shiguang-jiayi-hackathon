import type { ManuscriptChapter } from "../domain/biography";
import type { ChapterPackage } from "../domain/chapterPackage";
import { enqueuePhotoUpload, ensurePhotoUploads } from "./photoCloud";
import { exportChapterToCloud } from "./chapterPackageFlow";
import { chapterPackageEnabled, chapterPackages, prepareImport, type ImportTarget } from "./chapterPackageService";
import { CHAPTER_DELIVERY_ENABLED } from "../config/runtime";

const OUTBOX_KEY = "chapterDelivery.outbox.v1";
const IMPORTS_KEY = "chapterDelivery.imports.v1";
const READS_KEY = "chapterDelivery.reads.v1";
const ROOTS_KEY = "chapterDelivery.roots.v1";
const suffix = () => Math.random().toString(36).slice(2, 12).padEnd(10, "0");
const requestId = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, char => {
  const random = Math.random() * 16 | 0;
  return (char === "x" ? random : (random & 0x3 | 0x8)).toString(16);
});

type UploadResult = { deliveryId: string; uploadTickets: Array<{ assetId: string; path: string; token: string; mime: string; bytes: number; sha256: string; expiresAt: string }>; repeated: boolean; claimUrl?: string | null };
type Outbox = {
  action: "sendChapter" | "createChapterClaimLink" | "returnChapter";
  requestId: string;
  package: ChapterPackage;
  assetFiles: Record<string, string>;
  assetPhotos: Record<string, string>;
  assetFileIDs: Record<string, string>;
  cloudPaths: Record<string, string>;
  recipientContactId?: string;
};

export function deliveryResolutionAfterImport(kind: "send" | "return", mode: ImportTarget["mode"]): "kept" | "appended" | "adopted" {
  if (kind === "return") return "adopted";
  return mode === "append" ? "appended" : "kept";
}

function guarded() {
  if (!CHAPTER_DELIVERY_ENABLED || !chapterPackageEnabled()) throw new Error("章节投递暂未开放");
  if (!wx.cloud) throw new Error("当前版本暂不支持章节投递");
}
async function call<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  guarded();
  const response = await wx.cloud.callFunction({ name: "drinkingTimeBridge", data: { ...data, action } });
  const result = response.result as (T & { error?: string; code?: string; message?: string }) | undefined;
  if (!result || result.error) throw Object.assign(new Error(result?.message || result?.error || "章节投递暂时不可用，请重试"), { code: result?.code || result?.error });
  return result;
}

function readOutbox(): Outbox[] {
  const value: unknown = wx.getStorageSync(OUTBOX_KEY);
  return Array.isArray(value) ? value.filter((item): item is Outbox => Boolean(item &&
    ["sendChapter", "createChapterClaimLink", "returnChapter"].includes(item.action) &&
    typeof item.requestId === "string" && item.package && typeof item.package.packageId === "string" &&
    item.assetFiles && typeof item.assetFiles === "object" && item.assetPhotos && typeof item.assetPhotos === "object" &&
    item.assetFileIDs && typeof item.assetFileIDs === "object" && item.cloudPaths && typeof item.cloudPaths === "object")) : [];
}
function writeOutbox(items: Outbox[]) { wx.setStorageSync(OUTBOX_KEY, items); }
function saveOutbox(item: Outbox) {
  const items = readOutbox().filter(old => !(old.action === item.action && old.requestId === item.requestId));
  items.push(item); writeOutbox(items);
}
function removeOutbox(action: Outbox["action"], id: string) { writeOutbox(readOutbox().filter(item => item.action !== action || item.requestId !== id)); }

async function createOutbox(action: Outbox["action"], chapter: ManuscriptChapter, displayName: string, storyTitle: string, storyId?: string, recipientContactId?: string) {
  const exported = await exportChapterToCloud(chapter, displayName, storyTitle, storyId, action === "returnChapter" ? "return" : "copy");
  if (Object.keys(exported.assetPhotos).length !== Object.keys(exported.assetFiles).length)
    throw new Error("章节图片来源映射不完整，请重新添加图片后再投递");
  if (action !== "returnChapter" && storyId) {
    const roots = (wx.getStorageSync(ROOTS_KEY) || {}) as Record<string, { storyId: string; chapterId: string }>;
    roots[exported.package.lineage.rootPackageId] = { storyId, chapterId: chapter.id };
    wx.setStorageSync(ROOTS_KEY, roots);
  }
  return {
    action, requestId: requestId(), package: exported.package, assetFiles: exported.assetFiles,
    assetPhotos: exported.assetPhotos, assetFileIDs: {}, cloudPaths: {}, ...(recipientContactId ? { recipientContactId } : {}),
  } satisfies Outbox;
}

async function uploadOutgoing(item: Outbox): Promise<UploadResult> {
  const assetIds = Object.keys(item.assetFiles);
  if (assetIds.length && Object.keys(item.cloudPaths).length !== assetIds.length) {
    const staged = await call<{ uploads: Record<string, string> }>("stageChapterAssets", {
      package: item.package, assetPhotos: item.assetPhotos, purpose: item.action === "returnChapter" ? "return" : "send",
    });
    for (const assetId of assetIds) {
      const cloudPath = staged.uploads?.[assetId];
      if (typeof cloudPath !== "string" || !/^chapter-delivery-staging\/[a-f0-9]{64}\//.test(cloudPath) ||
        !cloudPath.includes(`/${item.package.packageId}/${assetId}/`)) throw new Error("图片临时地址无效，请重试");
      item.cloudPaths[assetId] = cloudPath;
    }
    saveOutbox(item);
  }
  for (const assetId of assetIds) {
    if (item.assetFileIDs[assetId]) continue;
    const uploaded = await wx.cloud.uploadFile({ cloudPath: item.cloudPaths[assetId], filePath: item.assetFiles[assetId] });
    if (!uploaded.fileID) throw new Error("图片还没有临时保存成功，请重试");
    item.assetFileIDs[assetId] = uploaded.fileID;
    saveOutbox(item);
  }
  const common = { package: item.package, requestId: item.requestId, assetFileIDs: item.assetFileIDs, assetPhotos: item.assetPhotos };
  const data = item.action === "sendChapter"
    ? { ...common, recipientContactId: item.recipientContactId }
    : common;
  const result = await call<UploadResult>(item.action, data);
  if (result.uploadTickets.length && result.uploadTickets.some(ticket => !item.assetFileIDs[ticket.assetId]))
    throw new Error("图片临时文件缺失，请重新选择章节后再发");
  removeOutbox(item.action, item.requestId);
  return result;
}

export async function chapterDeliveryEnabled() {
  if (!CHAPTER_DELIVERY_ENABLED || !chapterPackageEnabled()) return false;
  try { return (await call<{ enabled: boolean }>("chapterDeliveryEnabled")).enabled === true; }
  catch { return false; }
}
export const listChapterDeliveryContacts = () => call<{ contacts: Array<{ contactId: string; displayName: string }> }>("listChapterContacts");
export const listChapterDeliveryInbox = () => call<{ items: Array<{ deliveryId: string; packageId: string; kind: "send" | "return"; status: string; createdAt: string }> }>("listChapterInbox");

export async function sendChapter(chapter: ManuscriptChapter, displayName: string, storyTitle: string, storyId: string | undefined, recipientContactId: string) {
  guarded();
  const prior = readOutbox().find(item => item.action === "sendChapter" && item.recipientContactId === recipientContactId && item.package.chapters[0]?.chapterId === chapter.id);
  const item = prior ?? await createOutbox("sendChapter", chapter, displayName, storyTitle, storyId, recipientContactId);
  saveOutbox(item);
  return uploadOutgoing(item);
}
export async function createChapterClaimLink(chapter: ManuscriptChapter, displayName: string, storyTitle: string, storyId?: string) {
  guarded();
  const prior = readOutbox().find(item => item.action === "createChapterClaimLink" && item.package.chapters[0]?.chapterId === chapter.id);
  const item = prior ?? await createOutbox("createChapterClaimLink", chapter, displayName, storyTitle, storyId);
  saveOutbox(item);
  return uploadOutgoing(item);
}
/** Recover legacy copies only from the exact received package; never guess from title or order. */
export function chapterWithReturnSource(chapter: ManuscriptChapter, reads: Record<string, { package?: ChapterPackage }>): ManuscriptChapter {
  const lineage = chapter.packageLineage;
  if (!lineage) throw new Error("这一章没有原始章节来源，不能发回");
  if (lineage.sourceChapterId) return chapter;
  const original = Object.values(reads).map(item => item.package).find(pkg =>
    pkg?.packageId === lineage.receivedPackageId && pkg.lineage.rootPackageId === lineage.rootPackageId);
  if (!original || original.chapters.length !== 1)
    throw new Error("旧副本缺少原章节编号，请重新接收原章节后再发回");
  return { ...chapter, packageLineage: { ...lineage, sourceChapterId: original.chapters[0].chapterId } };
}

export async function returnChapter(chapter: ManuscriptChapter, displayName: string, storyTitle: string, storyId?: string) {
  guarded();
  const source = chapterWithReturnSource(chapter, (wx.getStorageSync(READS_KEY) || {}) as Record<string, { package?: ChapterPackage }>);
  const prior = readOutbox().find(item => item.action === "returnChapter" &&
    item.package.chapters[0]?.chapterId === source.packageLineage?.sourceChapterId &&
    item.package.lineage.parentPackageId === source.packageLineage?.receivedPackageId);
  const item = prior ?? await createOutbox("returnChapter", source, displayName, storyTitle, storyId);
  saveOutbox(item);
  return uploadOutgoing(item);
}

export async function readChapterDelivery(deliveryId: string) {
  const result = await call<{ delivery: { deliveryId: string; kind: "send" | "return"; status: string }; package: ChapterPackage; imageUrls: Record<string, string> }>("readChapterPackage", { deliveryId });
  const reads = (wx.getStorageSync(READS_KEY) || {}) as Record<string, unknown>;
  reads[deliveryId] = { package: result.package, imageUrls: result.imageUrls, kind: result.delivery.kind };
  wx.setStorageSync(READS_KEY, reads);
  return result;
}

function readImports(): Record<string, { requestId: string; target: ImportTarget; kind?: "send" | "return"; package: ChapterPackage; imageUrls: Record<string, string>; assetFileIDs?: Record<string, string>; assetUrls?: Record<string, string>; photoIds: Record<string, string> }> {
  const value: unknown = wx.getStorageSync(IMPORTS_KEY);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, { requestId: string; target: ImportTarget; kind?: "send" | "return"; package: ChapterPackage; imageUrls: Record<string, string>; assetFileIDs?: Record<string, string>; assetUrls?: Record<string, string>; photoIds: Record<string, string> }> : {};
}

export async function importChapterDelivery(deliveryId: string, target: ImportTarget) {
  guarded();
  const imported = readImports();
  let record = imported[deliveryId];
  if (!record) {
    const reads = (wx.getStorageSync(READS_KEY) || {}) as Record<string, { package?: ChapterPackage; imageUrls?: Record<string, string>; kind?: "send" | "return" }>;
    const cached = reads[deliveryId];
    const fetched = cached?.package && cached.imageUrls && cached.kind
      ? cached
      : await readChapterDelivery(deliveryId).then(result => ({ ...result, kind: result.delivery.kind }));
    record = { requestId: requestId(), target, kind: fetched.kind, package: fetched.package!, imageUrls: fetched.imageUrls!, photoIds: {} };
    imported[deliveryId] = record; wx.setStorageSync(IMPORTS_KEY, imported);
  }
  if (!record.kind) {
    record.kind = (await readChapterDelivery(deliveryId)).delivery.kind;
    imported[deliveryId] = record; wx.setStorageSync(IMPORTS_KEY, imported);
  }
  if (!record.assetFileIDs || record.package.assets.some(asset => !record.photoIds[asset.assetId])) {
    const fresh = await readChapterDelivery(deliveryId);
    record.imageUrls = fresh.imageUrls;
    const cached = await call<{ assetFileIDs: Record<string, string>; assetUrls: Record<string, string> }>("cacheChapterDeliveryAssets", {
      deliveryId, package: record.package, imageUrls: record.imageUrls,
    });
    record.assetFileIDs = cached.assetFileIDs;
    record.assetUrls = cached.assetUrls;
    imported[deliveryId] = record; wx.setStorageSync(IMPORTS_KEY, imported);
  }
  for (const assetId of Object.keys(record.assetFileIDs)) {
    if (record.photoIds[assetId]) continue;
    const url = record.assetUrls?.[assetId];
    if (!url?.startsWith("https://")) throw new Error("章节图片地址已失效，请重新领取");
    const downloaded = await new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>((resolve, reject) => wx.downloadFile({ url, success: resolve, fail: reject }));
    if (downloaded.statusCode !== 200) throw new Error("章节图片读取失败，请重试");
    if (!downloaded.tempFilePath) throw new Error("章节图片暂时没有下载成功，请重试");
    const photoId = `photo-delivery-${Date.now().toString(36)}-${suffix()}`;
    enqueuePhotoUpload(photoId, downloaded.tempFilePath, "import");
    record.photoIds[assetId] = photoId;
    imported[deliveryId] = record; wx.setStorageSync(IMPORTS_KEY, imported);
  }
  await ensurePhotoUploads(Object.values(record.photoIds));
  const payload = prepareImport(record.package, record.photoIds);
  const roots = (wx.getStorageSync(ROOTS_KEY) || {}) as Record<string, { storyId: string; chapterId: string }>;
  const origin = roots[record.package.lineage.rootPackageId];
  let result;
  try { result = await chapterPackages.import(payload, record.target, record.requestId, origin); }
  catch (error) {
    if ((error as { code?: string }).code !== 'DUPLICATE_TITLE' || record.target.mode !== 'new') throw error;
    // The rejected transaction wrote nothing. Keep the source title in the chapter,
    // and distinguish this received story without overwriting another story.
    record.target = { ...record.target, title: record.target.title.slice(0, 25) + '（' + deliveryId.slice(0, 8) + '）' };
    record.requestId = requestId();
    imported[deliveryId] = record; wx.setStorageSync(IMPORTS_KEY, imported);
    result = await chapterPackages.import(payload, record.target, record.requestId, origin);
  }
  // 04's import endpoint writes the approved chapter directly. Resolve only
  // after its durable receipt; a retry reuses the same requestId and target.
  const status = deliveryResolutionAfterImport(record.kind ?? "send", record.target.mode);
  await call("resolveChapterDelivery", { deliveryId, status });
  delete imported[deliveryId]; wx.setStorageSync(IMPORTS_KEY, imported);
  return { ...result, target: record.target };
}

export async function declineChapterDelivery(deliveryId: string) {
  return call("resolveChapterDelivery", { deliveryId, status: "declined" });
}

export async function claimChapterDelivery(token: string) {
  return call<{ deliveryId: string }>("claimChapterPackage", { token });
}

/** Accept only our public claim links; never navigate to a pasted URL. */
export function chapterClaimToken(input: string): string {
  const match = /^https:\/\/www\.drinkingtime\.top\/chapter\/claim\/([A-Za-z0-9_-]{43})$/.exec(input.trim());
  if (!match) throw new Error("请粘贴网页生成的完整领取链接");
  return match[1];
}
