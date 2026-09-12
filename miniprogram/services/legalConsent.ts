import type { ShiguangAppOptions } from "../app";
import { CLOUD_DATABASE_ENABLED } from "../config/runtime";

export const LEGAL_NOTICE_VERSION = "2026-09-05";
export const LEGAL_NOTICE_TITLE = "拾光Ai 用户须知与隐私提示";
export const LEGAL_NOTICE_STORAGE_KEY = `shiguang-legal-consent-${LEGAL_NOTICE_VERSION}`;
export const LEGAL_NOTICE_PAGE = "/pages/register/register";

export interface LegalNoticeSection {
  title: string;
  items: string[];
}

export const LEGAL_NOTICE_SECTIONS: LegalNoticeSection[] = [
  {
    title: "我们会处理哪些内容",
    items: [
      "你主动输入或上传的文字、语音转写、图片说明、家庭成员档案、记忆片段、回忆录草稿与生成结果。",
      "为识别当前账号和隔离数据，我们会使用微信提供的 OpenID，并记录你同意本须知的版本和时间。",
      "你可以选择把某段记忆分享给家庭成员；未选择分享的内容默认只进入你自己的档案。",
    ],
  },
  {
    title: "这些内容会被如何使用",
    items: [
      "用于保存、展示、检索和整理你的家庭记忆，并在你主动点击相关功能时调用 AI 进行追问、整理或生成。",
      "AI 处理可能由我们配置的第三方模型服务完成；我们只发送完成该次功能所必需的文本或上下文。",
      "我们不会出售你的家庭记忆，不会向无关第三方提供，也不会在未另行取得明确同意前用于广告画像或商业模型训练。",
    ],
  },
  {
    title: "你需要确认的事项",
    items: [
      "你应确保上传内容来自你本人，或你已获得相关权利人、家庭成员的必要授权；请谨慎上传他人的隐私、肖像、声音或敏感信息。",
      "请不要上传违法、侵权、诽谤、泄露他人秘密、危害国家安全或违反公序良俗的内容。",
      "AI 生成内容可能存在不准确或表达偏差，正式保存、分享或公开前请你自行确认和编辑。",
    ],
  },
  {
    title: "数据安全与删除",
    items: [
      "我们会按账号和家庭空间隔离数据，并尽量只保存提供服务所需的最少信息。",
      "你可以在“我的/切换档案”中清空当前账号数据；删除后，相关家庭成员、记忆、草稿和生成内容将无法恢复。",
      "因网络、云服务、第三方 AI 或设备环境导致的临时失败，我们会尽量保留原始输入或返回可编辑草稿，避免内容丢失。",
    ],
  },
];

type WxPrivacyApi = typeof wx & {
  requirePrivacyAuthorize?: (options: {
    success?: () => void;
    fail?: (error: unknown) => void;
  }) => void;
  openPrivacyContract?: (options: {
    success?: () => void;
    fail?: (error: unknown) => void;
  }) => void;
};

function canUseCloudDatabase(): boolean {
  if (!CLOUD_DATABASE_ENABLED || !wx.cloud || typeof getApp !== "function") return false;
  const app = getApp<ShiguangAppOptions>();
  return Boolean(app.globalData.cloudReady);
}

export function hasAcceptedLegalNoticeLocal(): boolean {
  try {
    return wx.getStorageSync<string>(LEGAL_NOTICE_STORAGE_KEY) === LEGAL_NOTICE_VERSION;
  } catch (error) {
    console.warn("无法读取用户须知确认状态", error);
    return false;
  }
}

function saveLegalNoticeLocal(): void {
  wx.setStorageSync(LEGAL_NOTICE_STORAGE_KEY, LEGAL_NOTICE_VERSION);
}

async function requireWechatPrivacyAuthorization(): Promise<void> {
  const privacyWx = wx as WxPrivacyApi;
  if (!privacyWx.requirePrivacyAuthorize) return;

  await new Promise<void>((resolve, reject) => {
    privacyWx.requirePrivacyAuthorize?.({
      success: () => resolve(),
      fail: (error) => reject(error),
    });
  });
}

export async function openWechatPrivacyContract(): Promise<void> {
  const privacyWx = wx as WxPrivacyApi;
  if (!privacyWx.openPrivacyContract) {
    wx.showToast({ title: "当前微信版本暂不支持查看", icon: "none" });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    privacyWx.openPrivacyContract?.({
      success: () => resolve(),
      fail: (error) => reject(error),
    });
  });
}

export async function loadLegalConsentStatus(): Promise<boolean> {
  if (hasAcceptedLegalNoticeLocal()) return true;
  if (!canUseCloudDatabase()) return false;

  try {
    const response = await wx.cloud.callFunction({
      name: "userConsent",
      data: {
        action: "status",
        requiredVersion: LEGAL_NOTICE_VERSION,
      },
    });
    const result = response.result as { acceptedRequiredVersion?: unknown } | undefined;
    if (result?.acceptedRequiredVersion === true) {
      saveLegalNoticeLocal();
      return true;
    }
  } catch (error) {
    console.warn("云端用户须知确认状态不可用", error);
  }

  return false;
}

export async function acceptLegalNotice(): Promise<void> {
  await requireWechatPrivacyAuthorization();

  if (canUseCloudDatabase()) {
    try {
      await wx.cloud.callFunction({
        name: "userConsent",
        data: {
          action: "accept",
          termsVersion: LEGAL_NOTICE_VERSION,
          termsTitle: LEGAL_NOTICE_TITLE,
          consentScopes: [
            "account_openid",
            "family_profiles",
            "memory_content_storage",
            "ai_assisted_processing",
            "family_sharing_controls",
          ],
        },
      });
    } catch (error) {
      console.warn("云端用户须知确认记录失败，将先保留本地确认", error);
    }
  }

  saveLegalNoticeLocal();
}

export function redirectToLegalNoticeIfNeeded(): boolean {
  if (hasAcceptedLegalNoticeLocal()) return false;
  if (typeof getCurrentPages !== "function") return false;
  const pages = getCurrentPages();
  const current = pages[pages.length - 1]?.route || "";
  if (current === "pages/register/register") return false;
  wx.redirectTo({ url: LEGAL_NOTICE_PAGE });
  return true;
}
