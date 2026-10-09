import type { ShiguangAppOptions } from "../app";
import { CLOUD_AI_ENABLED } from "../config/runtime";
import { requestAiConsent } from "./aiConsent";
import { requestPhotoAiConsent } from "./photoAiConsent";
import { prepareReferencePhotos } from "./referencePhotos";
import { storyImageApi } from "./storyImageService";

export interface ConfirmedPhotoReference { photoIds: string[]; description: string }

/** AI illustrations are output, never evidence for a person's remembered experience. */
export function writingReferencePhotoIds(photoIds: string[]): string[] {
  return [...new Set(photoIds.filter(id => /^photo-(?!ai-)[a-z0-9-]{1,80}$/.test(id)))].slice(0, 3);
}

/** Keep visual observations separate from the user's own words until explicitly confirmed. */
export async function confirmPhotoWritingReference(photoIds: string[], isActive: () => boolean): Promise<ConfirmedPhotoReference | undefined> {
  const ids = writingReferencePhotoIds(photoIds);
  if (!ids.length) return undefined;
  const app = getApp<ShiguangAppOptions>();
  if (!CLOUD_AI_ENABLED || !app?.globalData?.aiReady || !app.globalData.cloudReady || !wx.cloud) return undefined;
  if (!isActive() || !await requestAiConsent() || !isActive()) return undefined;
  if (!await requestPhotoAiConsent(ids.length) || !isActive()) return undefined;
  let result: Awaited<ReturnType<typeof storyImageApi.captionPhotos>>;
  try {
    await prepareReferencePhotos(ids, "small");
    if (!isActive()) return undefined;
    result = await storyImageApi.captionPhotos({photoIds: ids});
    if (!isActive()) return undefined;
    if (result.status !== "ok" || !result.aiGenerated || !result.caption.trim()) {
      throw new Error(result.message || "照片暂时没看清");
    }
  } catch (error) {
    if (!isActive()) return undefined;
    const useTextOnly = await new Promise<boolean>(resolve => wx.showModal({
      title: "照片暂未用于成文",
      content: (error instanceof Error ? error.message : "照片暂时无法读取") + "。可以先用原稿和文字补充成文，照片仍保留。",
      confirmText: "只用原文", cancelText: "稍后再试",
      success: result => resolve(result.confirm), fail: () => resolve(false),
    }));
    if (useTextOnly || !isActive()) return undefined;
    throw new Error("本次未生成预览，原稿和照片均保留，可以稍后再试。");
  }
  const confirmed = await new Promise<boolean>(resolve => wx.showModal({
    title: "照片里的描述准确吗？",
    content: `参考这段记忆的前 ${ids.length} 张照片，小忆看到：\n${result.caption}\n\n确认后结合原稿成文，不会据此猜测人物关系或过去发生的事。`,
    confirmText: "描述准确", cancelText: "只用原文",
    success: result => resolve(result.confirm), fail: () => resolve(false),
  }));
  return confirmed && isActive() ? {photoIds: ids, description: result.caption.trim()} : undefined;
}
