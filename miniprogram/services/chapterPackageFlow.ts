import type { ManuscriptChapter } from "../domain/biography";
import type { ChapterPackage } from "../domain/chapterPackage";
import { isStoryImageReference, readLocalPhoto, storyImageReferenceId } from "./bookImages";
import { storyImageApi } from "./storyImageService";
import { newStoryId } from "./storyRecords";
import {
  assertPackageImageTotal, chapterPackageEnabled, chapterPackageImportAttempt, chapterPackageRequestId, chapterPackages,
  exportChapterPackage, exportChapterReturnPackage, exportChapterForwardPackage, packageImageInfo, prepareImport, ImportTarget,
} from "./chapterPackageService";

const LAST_PACKAGE_KEY = "chapterPackage.lastExport";

const randomSuffix = () => Math.random().toString(36).slice(2, 12).padEnd(10, "0");
export const newPackageId = () => `cp_${Date.now().toString(36)}${randomSuffix()}`;

export interface ExportedChapter { package: ChapterPackage; packageId: string; cloudPath: string; fileID: string; assetFiles: Record<string, string>; assetPhotos: Record<string, string> }

function imageInfo(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => wx.getImageInfo({ src, success: result => resolve({ width: result.width, height: result.height }), fail: reject }));
}
function readImageBytes(path: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath: path, success: result => resolve(typeof result.data === "string" ? new Uint8Array() : new Uint8Array(result.data)), fail: reject,
  }));
}
async function persistentImagePath(photoId: string, authorizedUrl?: string): Promise<{ path: string; staged: boolean }> {
  const source = authorizedUrl || await readLocalPhoto(photoId);
  if (!source) throw new Error("有图片仅保存在原设备或暂时不可读取，请重新添加图片后再打包");
  if (!/^https:\/\//.test(source)) return { path: source, staged: false };
  const downloaded = await new Promise<{ statusCode: number; tempFilePath: string }>((resolve, reject) => wx.downloadFile({ url: source, success: resolve, fail: reject }));
  if (downloaded.statusCode !== 200 || !downloaded.tempFilePath) throw new Error("云端图片暂时下载失败，请重试");
  const path = await new Promise<string>((resolve, reject) => wx.getFileSystemManager().saveFile({
    tempFilePath: downloaded.tempFilePath, success: result => resolve(result.savedFilePath), fail: reject,
  }));
  return { path, staged: true };
}
function removeStaged(paths: string[]) {
  const fs = wx.getFileSystemManager();
  paths.forEach(filePath => fs.unlink({ filePath, complete: () => undefined }));
}
type SavedPackage = {
  packageId: string; fileID: string; chapterId: string; storyId?: string;
  importAttempt?: { target: ImportTarget; requestId: string };
  importResult?: { storyId: string; revisionId: string; chapterId: string };
};

/** Export one chapter. Source lineage is preserved locally when this chapter was imported from a package. */
export async function exportChapterToCloud(chapter: ManuscriptChapter, displayName: string, storyTitle: string, storyId?: string, purpose: "copy" | "return" | "forward" = "copy"): Promise<ExportedChapter> {
  if (!chapterPackageEnabled()) throw new Error("章节包功能暂未开放");
  const packageId = newPackageId();
  const photoIds = [...new Set([
    ...chapter.content.flatMap(item => item.photoId ? [item.photoId] : []),
    ...Object.values(chapter.packageAssets ?? {}).map(asset => asset.photoId),
    ...(chapter.backdropImageId ? [storyImageReferenceId(chapter.backdropImageId)] : []),
  ])];
  const imageFiles: Record<string, string> = {}, images: Record<string, ReturnType<typeof packageImageInfo>> = {};
  const staged = new Set<string>();
  try {
    const storyImages = storyId && photoIds.some(isStoryImageReference)
      ? (await storyImageApi.listStoryImages(storyId)).images : [];
    const availableImages = new Map(storyImages.filter(image => image.moderation === 'pass' && image.url?.startsWith('https://'))
      .map(image => [storyImageReferenceId(image.imageId), image]));
    for (let offset = 0; offset < photoIds.length; offset += 2) {
      await Promise.all(photoIds.slice(offset, offset + 2).map(async photoId => {
        const storyImage = availableImages.get(photoId);
        const resolved = await persistentImagePath(photoId, storyImage?.url);
        if (resolved.staged) staged.add(resolved.path);
        const dimensions = await imageInfo(resolved.path), bytes = await readImageBytes(resolved.path);
        images[photoId] = packageImageInfo(bytes, dimensions.width, dimensions.height);
        if (isStoryImageReference(photoId)) images[photoId].aiGenerated = true;
        imageFiles[photoId] = resolved.path;
      }));
    }
    assertPackageImageTotal(images);
    const exporter = purpose === "return" ? exportChapterReturnPackage : purpose === "forward" ? exportChapterForwardPackage : exportChapterPackage;
    const { package: pkg, assetPhotos } = exporter({
      chapter, images, packageId, displayName: displayName || "我", createdAt: new Date().toISOString(), storyTitle,
      layout: chapter.layout ?? null,
    });
    const filePath = `${wx.env.USER_DATA_PATH}/${packageId}.json`;
    await new Promise<void>((resolve, reject) => wx.getFileSystemManager().writeFile({
      filePath, data: JSON.stringify(pkg), encoding: "utf8", success: () => resolve(), fail: reject,
    }));
    const cloudPath = `chapter-packages/${packageId}.json`;
    const uploaded = await wx.cloud.uploadFile({ cloudPath, filePath });
    if (!uploaded.fileID) throw new Error("章节包没有保存成功，请重试");
    const record: SavedPackage = { packageId, fileID: uploaded.fileID, chapterId: chapter.id, ...(storyId ? { storyId } : {}) };
    wx.setStorageSync(LAST_PACKAGE_KEY, record);
    const assetFiles = Object.fromEntries(Object.entries(assetPhotos).map(([assetId, photoId]) => [assetId, imageFiles[photoId]]));
    return { package: pkg, packageId, cloudPath, fileID: uploaded.fileID, assetFiles, assetPhotos };
  } catch (error) {
    removeStaged([...staged]);
    throw error;
  }
}

/**
 * Import the last package. Persist the chosen target and requestId before the cloud call,
 * so an unknown timeout retries the same idempotent operation instead of creating a new story.
 */
export async function importLastExport(options: { target?: ImportTarget; title?: string; origin?: { storyId: string; chapterId: string }; requestId?: string } = {}) {
  if (!chapterPackageEnabled()) throw new Error("章节包功能暂未开放");
  const record = wx.getStorageSync(LAST_PACKAGE_KEY) as SavedPackage | undefined;
  if (!record?.fileID) throw new Error("还没有导出过章节包");
  const { tempFilePath } = await wx.cloud.downloadFile({ fileID: record.fileID });
  const text = await new Promise<string>((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath: tempFilePath, encoding: "utf8", success: result => resolve(String(result.data)), fail: reject,
  }));
  const payload = prepareImport(JSON.parse(text));
  const attempt = chapterPackageImportAttempt(record.importAttempt, options.target, options.requestId,
    { mode: "new", storyId: newStoryId(), title: options.title || payload.chapter.title || "导入的章节" }, chapterPackageRequestId());
  const { target, requestId } = attempt;
  wx.setStorageSync(LAST_PACKAGE_KEY, { ...record, importAttempt: attempt });
  const origin = options.origin ?? (record.storyId ? { storyId: record.storyId, chapterId: record.chapterId } : undefined);
  const result = await chapterPackages.import(payload, target, requestId, origin);
  if (!result || result.ok !== true || result.storyId !== target.storyId || typeof result.revisionId !== "string" || !result.revisionId ||
      typeof result.chapterId !== "string" || !/^chapter-[a-z0-9-]{1,60}$/.test(result.chapterId) || typeof result.alreadyReceived !== "boolean") {
    throw new Error("章节包导入回执不完整，请刷新书稿后确认结果");
  }
  wx.setStorageSync(LAST_PACKAGE_KEY, { ...record, importAttempt: attempt,
    importResult: { storyId: result.storyId, revisionId: result.revisionId, chapterId: result.chapterId } });
  return result;
}
