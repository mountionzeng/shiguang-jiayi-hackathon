import { currentFamilyId } from "./cloudRoomStorage";
import { readLocalPhoto } from "./bookImages";
import { enqueuePhotoUpload, ensurePhotoUploads } from "./photoCloud";

interface ReferencePhoto { photoId: string; status: string; url?: string }

/** Call only after photo AI consent. The server still checks ownership and story membership. */
export async function prepareReferencePhotos(photoIds: string[], variant: "small" | "display" = "display") {
  if (!photoIds.length) return;
  const ids = [...new Set(photoIds)];
  await ensurePhotoUploads(ids);
  const read = async (): Promise<ReferencePhoto[]> => {
    const response = await wx.cloud.callFunction({ name: "photoAccess", data: {
      action: "read", familyId: await currentFamilyId(), photoIds: ids, variant, purpose: "ai-reference",
    } });
    const result = response.result as { photos?: ReferencePhoto[]; error?: {message?: string} } | undefined;
    if (result?.error || !Array.isArray(result?.photos)) throw new Error(result?.error?.message || "暂时无法读取参考照片，请检查网络后重试");
    return result.photos;
  };
  let photos = await read();
  let repaired = false;
  for (const id of ids) {
    const photo = photos.find(item => item.photoId === id);
    if (!photo || !["not_found", "not_uploaded"].includes(photo.status)) continue;
    // Older local photos may predate the queue or have lost their queue entry.
    // Never re-upload deleted, risky, forbidden, or remotely-only photos.
    const path = await readLocalPhoto(id);
    if (!path || /^https?:\/\//i.test(path)) continue;
    enqueuePhotoUpload(id, path, "backfill");
    repaired = true;
  }
  if (repaired) { await ensurePhotoUploads(ids); photos = await read(); }
  for (const id of ids) {
    const photo = photos.find(item => item.photoId === id);
    if (photo?.status === "ok" && photo.url) continue;
    const reasons: Record<string, string> = {
      risky: "参考照片未通过内容检测，请更换照片后再生成",
      forbidden: "这张照片暂不允许用于 AI，请换成本人上传的照片",
      deleted: "参考照片已删除，请在正文中更换照片后再生成",
      too_large: "参考照片过大，请换用压缩后的照片",
    };
    throw new Error(reasons[photo?.status || ""] || "找不到可用的参考照片，请在正文中重新添加原照片，再生成配图");
  }
}
