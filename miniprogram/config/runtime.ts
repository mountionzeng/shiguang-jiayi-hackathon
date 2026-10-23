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
// Keep online AI closed in release builds until the target environment's
// functions, credentials, entitlements, quotas, billing, and safety routes
// have all been verified. This is a release gate, not an account identifier.
export const CLOUD_AI_RELEASE_READY = false;
// Keep approved preview text AI in source rather than patched temporary copies.
export function textAiReadyForVersion(envVersion?: string): boolean {
  return CLOUD_AI_ENABLED && (CLOUD_AI_RELEASE_READY || envVersion === "develop" || envVersion === "trial");
}
// Image generation has its own release gate so it can be enabled after its
// provider, billing, moderation, and metadata path have been verified without
// also exposing text or audio AI.
export const CLOUD_IMAGE_AI_RELEASE_READY = true;
// 章节包（导出、导入、发回）的客户端开关，默认关闭；云函数另有同名开关 CHAPTER_PACKAGE_ENABLED。
// 与 STORY_ACCESS_ENABLED 等四个故事开关无关，不要为了测试顺手打开它们。
export const CHAPTER_PACKAGE_ENABLED = false;
export const BACKEND_API_ENABLED = false;
export const BACKEND_API_BASE_URL = "http://127.0.0.1:8000/api/v1";
// Bump when the AI-consent disclosure text materially changes; existing users
// must re-confirm before online AI runs again.
export const AI_CONSENT_VERSION = 1;
