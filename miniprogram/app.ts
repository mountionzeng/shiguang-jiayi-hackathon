import {
  CLOUD_AI_ENABLED,
  CLOUD_AI_RELEASE_READY,
  CLOUD_DATABASE_ENABLED,
  cloudEnvForAppId,
} from "./config/runtime";
import { clearAiConsent } from "./services/aiConsent";
import { beginPhotoUploadSession, resumePhotoUploads } from "./services/photoCloud";

export interface ShiguangAppOptions {
  globalData: {
    cloudReady: boolean;
    aiReady: boolean;
  };
}

App<ShiguangAppOptions>({
  globalData: {
    cloudReady: false,
    aiReady: false,
  },

  onLaunch() {
    this.globalData.cloudReady = false;
    this.globalData.aiReady = false;
    clearAiConsent();
    beginPhotoUploadSession();
    if (!CLOUD_DATABASE_ENABLED && !CLOUD_AI_ENABLED) {
      console.info("云开发开关未启用，将使用本地演示数据");
      return;
    }

    if (!wx.cloud) {
      console.info("当前环境未启用微信云开发，将使用本地演示数据");
      return;
    }

    try {
      const appId = wx.getAccountInfoSync().miniProgram.appId;
      const cloudEnvId = cloudEnvForAppId(appId);
      if (!cloudEnvId) {
        console.warn(`当前 AppID 尚未配置云开发环境：${appId || "unknown"}`);
        return;
      }
      wx.cloud.init({ env: cloudEnvId, traceUser: false });
      this.globalData.cloudReady = true;
      this.globalData.aiReady = CLOUD_AI_ENABLED && CLOUD_AI_RELEASE_READY;
      void resumePhotoUploads();
      wx.onNetworkStatusChange(result => { if (result.isConnected) void resumePhotoUploads(); });
    } catch (error) {
      console.warn("微信云开发初始化失败，暂停云端数据读写，请重试", error);
    }
  },

  onShow() {
    if (this.globalData.cloudReady) void resumePhotoUploads();
  },
});
