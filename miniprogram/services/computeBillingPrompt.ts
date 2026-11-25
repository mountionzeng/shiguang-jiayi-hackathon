export const INSUFFICIENT_COMPUTE_MESSAGE = "算力不足，请先充值";
export const UNPRICED_MODEL_MESSAGE = "该模型计费暂未配置";

export function computeBillingFailure(error: unknown): string | null {
  const record = error && typeof error === "object" ? error as { message?: unknown; errMsg?: unknown; code?: unknown } : {};
  const text = [record.message, record.errMsg, record.code].map(item => typeof item === "string" ? item : "").join(" ");
  if (text.includes("INSUFFICIENT_COMPUTE") || text.includes(INSUFFICIENT_COMPUTE_MESSAGE)) return INSUFFICIENT_COMPUTE_MESSAGE;
  if (text.includes("COMPUTE_REGISTRATION_REQUIRED") || text.includes("开通共享算力")) return "已有网页账号请在网页发起微信绑定。首次开户请从网页登录入口扫码确认。";
  if (text.includes("PRICE_NOT_CONFIGURED") || text.includes(UNPRICED_MODEL_MESSAGE)) return UNPRICED_MODEL_MESSAGE;
  return null;
}

/** Shows the billing prompt and reports whether this error is a billing stop. */
export function promptComputeBillingFailure(error: unknown): boolean {
  const message = computeBillingFailure(error);
  if (!message || typeof wx === "undefined" || typeof wx.showModal !== "function") return Boolean(message);
  wx.showModal({
    title: message === INSUFFICIENT_COMPUTE_MESSAGE ? "算力不足" : message === UNPRICED_MODEL_MESSAGE ? "暂未计价" : "待绑定或开户",
    content: message,
    showCancel: false,
  });
  return true;
}
