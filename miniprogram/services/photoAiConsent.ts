let decision: boolean | undefined;
let pending: Promise<boolean> | undefined;

export function clearPhotoAiConsent() { decision = undefined; pending = undefined; }

/**
 * 把照片发给看图模型，要和文字 AI 的授权分开单独问（个人信息保护法第 23 条）。
 * 用户定：每次打开小程序问一次，同一次打开里不重复问；每次只发这次选中的照片。
 */
export async function requestPhotoAiConsent(photoCount: number): Promise<boolean> {
  if (decision !== undefined) return decision;
  if (pending) return pending;
  pending = new Promise<boolean>(resolve => wx.showModal({
    title: "让 AI 看看这几张照片？",
    content: `会把这 ${photoCount} 张照片的压缩小图发给腾讯云 TokenHub 上的看图模型，只用来帮你起草一句话，不识别照片里的人是谁。拾光家忆只保存你最后确认的文字。服务商的日志留存政策仍适用。不同意也可以自己写。`,
    confirmText: "允许",
    cancelText: "自己写",
    success: result => { decision = result.confirm; resolve(decision); },
    fail: () => resolve(false),
  }));
  try { return await pending; } finally { pending = undefined; }
}
