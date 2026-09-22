import { AI_CONSENT_VERSION, CLOUD_AI_ENABLED } from "../config/runtime";

const STORAGE_KEY = "aiConsentDecision";

interface StoredConsent {
  granted: boolean;
  version: number;
  decidedAt: string;
}

let decision: boolean | undefined;
let pending: Promise<boolean> | undefined;

function loadStored(): StoredConsent | undefined {
  if (typeof wx === "undefined" || typeof wx.getStorageSync !== "function") return undefined;
  const stored = wx.getStorageSync<StoredConsent>(STORAGE_KEY);
  return stored && typeof stored.granted === "boolean" ? stored : undefined;
}

export function hasAiConsent(): boolean {
  const stored = loadStored();
  return stored?.granted === true && stored.version === AI_CONSENT_VERSION;
}

/** Version the user last confirmed, or undefined if never confirmed. */
export function currentConsentVersion(): number | undefined {
  return loadStored()?.version;
}

export function clearAiConsent() {
  decision = undefined;
  pending = undefined;
  if (typeof wx !== "undefined" && typeof wx.removeStorageSync === "function") wx.removeStorageSync(STORAGE_KEY);
}

/**
 * Consent persists across sessions but is scoped to AI_CONSENT_VERSION: a prior
 * decision made under an older version no longer counts and re-prompts.
 * Denial always keeps processing local.
 */
export async function requestAiConsent(): Promise<boolean> {
  if (decision === undefined) {
    const stored = loadStored();
    if (stored && stored.version === AI_CONSENT_VERSION) decision = stored.granted;
  }
  if (decision !== undefined) return decision;
  if (pending) return pending;
  pending = new Promise<boolean>(resolve => wx.showModal({
    title: "允许本次使用在线 AI？",
    content: "会把本次对话或选中的故事文字发送给 AI 服务处理；这项授权不包含照片。档案和文字使用微信云开发数据库，压缩后的照片使用微信云开发云存储，原图仍留在手机。需要 AI 看照片时会另外询问，只发送当次选中的压缩图。服务商和平台的日志留存政策仍适用。不同意仍可记录，保存位置不变。",
    confirmText: "允许处理", cancelText: "暂不使用",
    success: result => {
      decision = result.confirm;
      const stored: StoredConsent = { granted: decision, version: AI_CONSENT_VERSION, decidedAt: new Date().toISOString() };
      if (typeof wx.setStorageSync === "function") wx.setStorageSync(STORAGE_KEY, stored);
      if (decision && CLOUD_AI_ENABLED && typeof wx !== "undefined" && wx.cloud && typeof wx.cloud.callFunction === "function") {
        wx.cloud.callFunction({ name: "recordAiConsent", data: { version: AI_CONSENT_VERSION } }).catch(() => {
          /* best-effort: local decision still applies even if the server write fails */
        });
      }
      resolve(decision);
    },
    fail: () => resolve(false),
  }));
  try { return await pending; } finally { pending = undefined; }
}
