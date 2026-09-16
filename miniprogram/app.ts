import {
  CLOUD_AI_ENABLED,
  CLOUD_DATABASE_ENABLED,
  CLOUD_ENV_ID,
} from "./config/runtime";
import { clearAiConsent } from "./services/aiConsent";
import { beginPhotoUploadSession, resumePhotoUploads } from "./services/photoCloud";

export interface ShiguangAppOptions {
  globalData: {
    cloudReady: boolean;
  };
}

App<ShiguangAppOptions>({
  globalData: {
    cloudReady: false,
  },

  onLaunch() {
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
      wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: false });
      this.globalData.cloudReady = true;
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
