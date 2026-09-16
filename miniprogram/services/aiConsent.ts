let decision: boolean | undefined;
let pending: Promise<boolean> | undefined;

export function clearAiConsent() { decision = undefined; pending = undefined; }

/** Consent only lasts for this app session. Denial always keeps processing local. */
export async function requestAiConsent(): Promise<boolean> {
  if (decision !== undefined) return decision;
  if (pending) return pending;
  pending = new Promise<boolean>(resolve => wx.showModal({
    title: "允许本次使用在线 AI？",
    content: "会把本次对话或选中的故事文字发送给 AI 服务处理；这项授权不包含照片。档案和文字使用微信云开发数据库，压缩后的照片使用微信云开发云存储，原图仍留在手机。需要 AI 看照片时会另外询问，只发送当次选中的压缩图。服务商和平台的日志留存政策仍适用。不同意仍可记录，保存位置不变。",
    confirmText: "允许处理", cancelText: "暂不使用",
    success: result => { decision = result.confirm; resolve(decision); },
    fail: () => resolve(false),
  }));
  try { return await pending; } finally { pending = undefined; }
}
