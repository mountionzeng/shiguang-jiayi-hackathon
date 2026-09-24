import { ManuscriptContent } from "../domain/biography";
import { enqueuePhotoUpload, PhotoSource, removeQueuedPhotoUploads } from "./photoCloud";
import { currentFamilyId } from "./cloudRoomStorage";

const LOCAL_PHOTO_ID = /^photo-(?!ai-)[a-z0-9-]{1,80}$/;
const STORY_IMAGE_ID = /^family_[0-9A-Za-z_-]{1,120}_img_req-[0-9a-z-]{8,60}$/;
const STORY_IMAGE_REFERENCE = /^photo-ai-(req-[0-9a-z-]{8,60})$/;
const MARKER = /【本机照片：(photo-[a-z0-9-]{1,80})】/g;
export interface EditorDelta { ops: Array<{ insert: string | { image: string }; attributes?: Record<string, unknown> }> }

export const isStoryImageId = (value: string) => STORY_IMAGE_ID.test(value);
export const isStoryImageReference = (value: string) => STORY_IMAGE_REFERENCE.test(value);
export function storyImageReferenceId(imageId: string) {
  if (!isStoryImageId(imageId)) return "";
  return "photo-ai-" + imageId.slice(imageId.lastIndexOf("_img_") + 5);
}
export const storyImageMatchesReference = (imageId: string, referenceId: string) =>
  storyImageReferenceId(imageId) === referenceId;

function referenceFromId(id: string): ManuscriptContent {
  if (LOCAL_PHOTO_ID.test(id) || STORY_IMAGE_REFERENCE.test(id)) return { photoId: id };
  throw new Error("图片引用无效");
}

export function contentFromDelta(delta: unknown, imageIds: Record<string, string>): ManuscriptContent[] {
  const ops = (delta as EditorDelta)?.ops;
  if (!Array.isArray(ops)) throw new Error("正文读取失败，请重试");
  const content: ManuscriptContent[] = [];
  for (const op of ops) {
    if (typeof op.insert === "string") {
      let start = 0;
      for (const match of op.insert.matchAll(MARKER)) {
        if (match.index! > start) content.push({ text: op.insert.slice(start, match.index) });
        content.push(referenceFromId(match[1]));
        start = match.index! + match[0].length;
      }
      if (start < op.insert.length) content.push({ text: op.insert.slice(start) });
    } else {
      const id = imageIds[op.insert?.image];
      if (!id) throw new Error("请通过顶部照片按钮或配图按钮插入图片，再保存");
      content.push(referenceFromId(id));
    }
  }
  return content;
}

export function contentToDelta(content: ManuscriptContent[], paths: Record<string, string>): EditorDelta {
  const ops: EditorDelta["ops"] = content.map(item => {
    if (typeof item.text === "string") return { insert: item.text };
    const id = item.photoId;
    if (!id) throw new Error("图片引用无效");
    if (paths[id]) return { insert: { image: paths[id] }, attributes: { width: "100%" } };
    return { insert: `【本机照片：${item.photoId}】` };
  });
  const last = ops[ops.length - 1]?.insert;
  if (typeof last !== "string" || !last.endsWith("\n")) ops.push({ insert: "\n" });
  return { ops };
}

export function validateContent(content: ManuscriptContent[] | undefined) {
  if (!content) return;
  if (!Array.isArray(content) || content.length > 3000 || JSON.stringify(content).length > 100000) throw new Error("图文内容过长，请分成多个故事");
  let images = 0;
  for (const item of content) {
    if (!item || Object.keys(item).length !== 1) throw new Error("图文内容格式无效");
    if (typeof item.text === "string") continue;
    if (typeof item.photoId === "string" && (LOCAL_PHOTO_ID.test(item.photoId) || STORY_IMAGE_REFERENCE.test(item.photoId))) { images++; continue; }
    throw new Error("图片引用无效");
  }
  if (images > 9) throw new Error("一篇书稿最多放 9 张照片（含 AI 插图）");
}

export async function saveLocalPhoto(tempFilePath: string, source: PhotoSource = "book"): Promise<{ id: string; path: string }> {
  const id = "photo-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  const extension = tempFilePath.match(/\.(jpe?g|png|webp|gif|heic)$/i)?.[1].toLowerCase() ?? "jpg";
  const path = await new Promise<string>((resolve, reject) => wx.getFileSystemManager().saveFile({
    tempFilePath, filePath: `${wx.env.USER_DATA_PATH}/${id}.${extension}`,
    success: result => resolve(result.savedFilePath), fail: reject,
  }));
  wx.getFileSystemManager().accessSync(path);
  // Use one record per file; do not overwrite or garbage-collect photos referenced by older versions.
  wx.setStorageSync("shiguang-local-" + id, path);
  enqueuePhotoUpload(id, path, source);
  return { id, path };
}

/** Cancel a just-started import without uploading or retaining our private copy. The source photo is untouched. */
export async function discardLocalPhotos(photos: Array<{ id: string; path: string }>): Promise<void> {
  const safe = photos.filter(photo => LOCAL_PHOTO_ID.test(photo.id) && photo.path.startsWith(`${wx.env.USER_DATA_PATH}/`));
  removeQueuedPhotoUploads(safe.map(photo => photo.id));
  await Promise.all(safe.map(photo => new Promise<void>(resolve => {
    wx.removeStorageSync("shiguang-local-" + photo.id);
    wx.getFileSystemManager().unlink({ filePath: photo.path, complete: () => resolve() });
  })));
}

/** Resolve each photo once, cap I/O concurrency, then build mappings in document order. */
export async function readLocalPhotos(ids: string[]): Promise<{
  photoPaths: Record<string, string>; imageIds: Record<string, string>;
}> {
  const uniqueIds = [...new Set(ids)];
  const paths = new Map<string, string>();
  for (let offset = 0; offset < uniqueIds.length; offset += 4) {
    const batch = await Promise.all(uniqueIds.slice(offset, offset + 4).map(async id =>
      [id, await readLocalPhoto(id)] as const));
    for (const [id, path] of batch) paths.set(id, path);
  }
  const photoPaths: Record<string, string> = {};
  const imageIds: Record<string, string> = {};
  for (const id of ids) {
    const path = paths.get(id);
    if (path) { photoPaths[id] = path; imageIds[path] = id; }
  }
  return { photoPaths, imageIds };
}

export async function readLocalPhoto(id: string): Promise<string> {
  if (!LOCAL_PHOTO_ID.test(id)) return "";
  try {
    const path: unknown = wx.getStorageSync("shiguang-local-" + id);
    if (typeof path !== "string" || /(?:^|\/)\.\.(?:\/|$)|%|[\\?#]/.test(path)) throw new Error("LOCAL_PHOTO_UNAVAILABLE");
    const fs = wx.getFileSystemManager();
    if (!path.startsWith(wx.env.USER_DATA_PATH + "/")) {
      // saveFile without filePath returns a managed cache file, not a USER_DATA_PATH file.
      // Ask WeChat for its allowlist instead of guessing iOS/Android/devtools path prefixes.
      const saved = await new Promise<WechatMiniprogram.GetSavedFileListSuccessCallbackResult>((resolve, reject) =>
        fs.getSavedFileList({ success: resolve, fail: reject }));
      if (!saved.fileList.some(file => file.filePath === path)) throw new Error("LOCAL_PHOTO_UNAVAILABLE");
    }
    fs.accessSync(path);
    return path;
  } catch {
    if (!wx.cloud) return "";
    try {
      const response = await wx.cloud.callFunction({ name: "photoAccess", data: {
        action: "read",
        familyId: await currentFamilyId(),
        photoIds: [id],
        variant: "display",
        purpose: "view",
      } });
      const result = response.result as { photos?: Array<{ status?: string; url?: string }> } | undefined;
      const photo = result?.photos?.[0];
      return photo?.status === "ok" && typeof photo.url === "string" ? photo.url : "";
    } catch { return ""; }
  }
}
