// Account-bound values live here, not in pages or services. When switching to a
// different mini-program account, add its AppID/environment pair here first.
// Unknown AppIDs deliberately do not fall back to the old environment: that
// prevents a new account from writing into the previous account's cloud data.
const CLOUD_ENV_BY_APP_ID = require("./wechat-accounts.js") as Record<string, string>;

export function cloudEnvForAppId(appId: string): string | undefined {
  return CLOUD_ENV_BY_APP_ID[String(appId || "").trim()];
}
// Restore the existing cloud dataset. Do not switch storage without a continuity plan.
export const CLOUD_DATABASE_ENABLED = true;
export const CLOUD_AI_ENABLED = true;
export const BACKEND_API_ENABLED = false;
export const BACKEND_API_BASE_URL = "http://127.0.0.1:8000/api/v1";
