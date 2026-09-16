import { ManuscriptContent } from "../domain/biography";
import { enqueuePhotoUpload, PhotoSource } from "./photoCloud";
import { currentFamilyId } from "./cloudRoomStorage";

const PHOTO_ID = /^photo-[a-z0-9-]{1,80}$/;
const MARKER = /【本机照片：(photo-[a-z0-9-]{1,80})】/g;
export interface EditorDelta { ops: Array<{ insert: string | { image: string }; attributes?: Record<string, unknown> }> }

export function contentFromDelta(delta: unknown, imageIds: Record<string, string>): ManuscriptContent[] {
  const ops = (delta as EditorDelta)?.ops;
  if (!Array.isArray(ops)) throw new Error("正文读取失败，请重试");
  const content: ManuscriptContent[] = [];
  for (const op of ops) {
    if (typeof op.insert === "string") {
      const parts = op.insert.split(MARKER);
      parts.forEach((part, index) => { if (part) content.push(index % 2 ? { photoId: part } : { text: part }); });
    } else {
      const id = imageIds[op.insert?.image];
      if (!id || !PHOTO_ID.test(id)) throw new Error("请通过顶部照片按钮插入图片，再保存");
      content.push({ photoId: id });
    }
  }
  return content;
}

export function contentToDelta(content: ManuscriptContent[], paths: Record<string, string>): EditorDelta {
  const ops: EditorDelta["ops"] = content.map(item => typeof item.text === "string"
    ? { insert: item.text }
    : paths[item.photoId] ? { insert: { image: paths[item.photoId] }, attributes: { width: "100%" } }
      : { insert: "【本机照片：" + item.photoId + "】" });
  const last = ops[ops.length - 1]?.insert;
  if (typeof last !== "string" || !last.endsWith("\n")) ops.push({ insert: "\n" });
  return { ops };
}

export function validateContent(content: ManuscriptContent[] | undefined) {
  if (!content) return;
  if (!Array.isArray(content) || content.length > 3000 || JSON.stringify(content).length > 100000) throw new Error("图文内容过长，请分成多个故事");
  let photos = 0;
  for (const item of content) {
    if (!item || Object.keys(item).length !== 1) throw new Error("图文内容格式无效");
    if (typeof item.text === "string") continue;
    if (typeof item.photoId !== "string" || !PHOTO_ID.test(item.photoId)) throw new Error("照片引用无效");
    photos++;
  }
  if (photos > 9) throw new Error("一篇书稿最多放 9 张照片");
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

export async function readLocalPhoto(id: string): Promise<string> {
  if (!PHOTO_ID.test(id)) return "";
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
