const approved = new Set<string>();
const pending = new Map<string, Promise<boolean>>();

export function clearIllustrationReferenceConsent() { approved.clear(); pending.clear(); }

/** Generated illustrations are not user photos, but sending one back to a vision model is still disclosed separately. */
export async function requestIllustrationReferenceConsent(referenceImageId: string): Promise<boolean> {
  if (approved.has(referenceImageId)) return true;
  const existing = pending.get(referenceImageId);
  if (existing) return existing;
  const request = new Promise<boolean>(resolve => wx.showModal({
    title: "允许 AI 参考这张插图？",
    content: "会把你选中的 AI 插图临时发送给视觉模型，只提取人物外观、画风、配色和关键物件，再结合本章文字制作新图。不会发送本机照片，也不会把参考图加入其他故事。",
    confirmText: "允许参考", cancelText: "不用参考",
    success: result => { if (result.confirm) approved.add(referenceImageId); resolve(result.confirm); },
    fail: () => resolve(false),
  }));
  pending.set(referenceImageId, request);
  try { return await request; } finally { pending.delete(referenceImageId); }
}
