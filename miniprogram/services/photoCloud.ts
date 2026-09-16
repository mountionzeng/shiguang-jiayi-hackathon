import { currentFamilyId } from "./cloudRoomStorage";

const QUEUE_KEY = "shiguang-photo-upload-queue-v1";
const MAX_ATTEMPTS_PER_SESSION = 3;
const SMALL_MAX_BYTES = 100 * 1024;

export type PhotoSource = "book" | "import" | "backfill";
export type PhotoUploadStatus = "waiting" | "uploading" | "failed";

export interface PhotoUploadItem {
  photoId: string;
  localPath: string;
  source: PhotoSource;
  status: PhotoUploadStatus;
  attempts: number;
  error?: string;
}

function readQueue(): PhotoUploadItem[] {
  const stored: unknown = wx.getStorageSync(QUEUE_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.filter((item): item is PhotoUploadItem => Boolean(
    item && typeof item.photoId === "string" && typeof item.localPath === "string" &&
    (item.source === "book" || item.source === "import" || item.source === "backfill"),
  )).map(item => ({ ...item, status: item.status === "uploading" ? "waiting" : item.status }));
}

function writeQueue(queue: PhotoUploadItem[]) {
  wx.setStorageSync(QUEUE_KEY, queue);
}

export function enqueuePhotoUpload(photoId: string, localPath: string, source: PhotoSource = "book") {
  const queue = readQueue();
  const existing = queue.find(item => item.photoId === photoId);
  if (existing) {
    existing.localPath = localPath;
    existing.source = source;
    existing.status = "waiting";
    existing.error = undefined;
  } else {
    queue.push({ photoId, localPath, source, status: "waiting", attempts: 0 });
  }
  writeQueue(queue);
}

export function pendingPhotoUploads(): PhotoUploadItem[] {
  return readQueue();
}

export function beginPhotoUploadSession() {
  const queue = readQueue().map(item => ({ ...item, status: "waiting" as const, attempts: 0 }));
  writeQueue(queue);
}

export function retryPhotoUpload(photoId: string) {
  const queue = readQueue();
  const item = queue.find(entry => entry.photoId === photoId);
  if (!item) return;
  item.status = "waiting";
  item.attempts = 0;
  item.error = undefined;
  writeQueue(queue);
}

export interface CloudPhotoSummary {
  count: number;
  bytes: number;
  checking: number;
}

async function callPhotoAccess<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const response = await wx.cloud.callFunction({ name: "photoAccess", data: {
    action,
    familyId: await currentFamilyId(),
    ...data,
  } });
  const result = response.result as (T & { error?: { code?: string; message?: string } }) | undefined;
  if (!result || result.error) throw new Error(result?.error?.message || result?.error?.code || "照片服务暂时不可用");
  return result;
}

export async function loadCloudPhotoSummary(): Promise<CloudPhotoSummary> {
  const result = await callPhotoAccess<Partial<CloudPhotoSummary>>("listMine");
  return {
    count: Number(result.count || 0),
    bytes: Number(result.bytes || 0),
    checking: Number(result.checking || 0),
  };
}

export async function deleteMyCloudPhotos(): Promise<void> {
  await callPhotoAccess("deleteMine", { confirm: "DELETE_MY_CLOUD_PHOTOS" });
}

export function clearPhotoUploadQueue() {
  writeQueue([]);
}

function compress(src: string, dimensions: { width: number; height: number }, quality: number): Promise<string> {
  return new Promise((resolve, reject) => wx.compressImage({
    src,
    compressedWidth: dimensions.width,
    compressedHeight: dimensions.height,
    quality,
    success: result => resolve(result.tempFilePath),
    fail: reject,
  }));
}

function fitWithin(width: number, height: number, maxLongEdge: number) {
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function imageInfo(src: string): Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult> {
  return new Promise((resolve, reject) => wx.getImageInfo({ src, success: resolve, fail: reject }));
}

function fileBytes(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({
    filePath,
    success: result => resolve(result.size),
    fail: reject,
  }));
}

async function smallPhoto(src: string, width: number, height: number): Promise<{ path: string; bytes: number }> {
  let last = { path: "", bytes: Number.POSITIVE_INFINITY };
  const attempts = [
    ...[70, 55, 40, 30].map(quality => ({ edge: 768, quality })),
    { edge: 640, quality: 30 },
    { edge: 512, quality: 30 },
  ];
  for (const attempt of attempts) {
    const path = await compress(src, fitWithin(width, height, attempt.edge), attempt.quality);
    const bytes = await fileBytes(path);
    last = { path, bytes };
    if (bytes <= SMALL_MAX_BYTES) break;
  }
  if (last.bytes > SMALL_MAX_BYTES) throw new Error("照片小图压缩后仍超过 100KB，请换一张试试");
  return last;
}

async function upload(cloudPath: string, filePath: string): Promise<string> {
  const response = await wx.cloud.uploadFile({ cloudPath, filePath });
  if (!response.fileID) throw new Error("UPLOAD_NO_FILE_ID");
  return response.fileID;
}

async function uploadOne(item: PhotoUploadItem) {
  const familyId = await currentFamilyId();
  const info = await imageInfo(item.localPath);
  const displayPath = await compress(item.localPath, fitWithin(info.width, info.height, 1600), 80);
  const small = await smallPhoto(item.localPath, info.width, info.height);
  const displayBytes = await fileBytes(displayPath);
  const base = `user-photos/${familyId}/${item.photoId}`;
  const [displayFileID, smallFileID] = await Promise.all([
    upload(`${base}/display.jpg`, displayPath),
    upload(`${base}/small.jpg`, small.path),
  ]);
  const response = await wx.cloud.callFunction({ name: "photoAccess", data: {
    action: "register",
    familyId,
    photoId: item.photoId,
    source: item.source,
    displayFileID,
    smallFileID,
    width: info.width,
    height: info.height,
    displayBytes,
    smallBytes: small.bytes,
  } });
  const result = response.result as { ok?: boolean; error?: { code?: string; message?: string } } | undefined;
  if (!result?.ok) throw new Error(result?.error?.message || result?.error?.code || "PHOTO_REGISTER_FAILED");
}

let processing: Promise<void> | undefined;

export function resumePhotoUploads(): Promise<void> {
  if (processing) return processing;
  processing = (async () => {
    if (!wx.cloud) return;
    const queue = readQueue();
    for (const item of queue) {
      if (item.attempts >= MAX_ATTEMPTS_PER_SESSION) continue;
      item.status = "uploading";
      item.attempts += 1;
      writeQueue(queue);
      try {
        await uploadOne(item);
        const index = queue.findIndex(entry => entry.photoId === item.photoId);
        if (index >= 0) queue.splice(index, 1);
      } catch (error) {
        item.status = "failed";
        item.error = String((error as { errMsg?: string; message?: string })?.errMsg || (error as Error)?.message || error).slice(0, 120);
      }
      writeQueue(queue);
    }
  })().finally(() => { processing = undefined; });
  return processing;
}
