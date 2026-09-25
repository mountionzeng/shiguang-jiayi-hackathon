export type PhotoAiConsentPurpose = "caption" | "illustration-reference";

const decisions: Partial<Record<PhotoAiConsentPurpose, boolean>> = {};
const pending = new Map<PhotoAiConsentPurpose, Promise<boolean>>();

export function clearPhotoAiConsent() {
  for (const key of Object.keys(decisions) as PhotoAiConsentPurpose[]) delete decisions[key];
  pending.clear();
}

/**
 * 把照片发给看图模型，要和文字 AI 的授权分开单独问（个人信息保护法第 23 条）。
 * 用户定：每次打开小程序问一次，同一次打开里不重复问；每次只发这次选中的照片。
 */
export async function requestPhotoAiConsent(photoCount: number, purpose: PhotoAiConsentPurpose = "caption"): Promise<boolean> {
  if (decisions[purpose] !== undefined) return decisions[purpose] === true;
  const existing = pending.get(purpose);
  if (existing) return existing;
  const usage = purpose === "illustration-reference"
    ? "用来提取主体外观、画风、配色和关键物件，并作为本章插图的参考图生成新插画"
    : "只用来帮你起草一句话";
  const cancelText = purpose === "illustration-reference" ? "不用照片" : "自己写";
  const request = new Promise<boolean>(resolve => wx.showModal({
    title: "让 AI 看看这几张照片？",
    content: `会把这 ${photoCount} 张照片的压缩图发给腾讯云 TokenHub 上的 AI 服务，${usage}，不识别照片里的人是谁。服务商的日志留存政策仍适用。不同意就不会发送照片。`,
    confirmText: "允许",
    cancelText,
    success: result => { decisions[purpose] = result.confirm; resolve(result.confirm); },
    fail: () => resolve(false),
  }));
  pending.set(purpose, request);
  try { return await request; } finally { pending.delete(purpose); }
}
