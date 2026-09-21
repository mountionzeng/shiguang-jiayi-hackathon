import {
  CLOUD_AI_ENABLED,
  CLOUD_DATABASE_ENABLED,
  CLOUD_ENV_ID,
} from "./config/runtime";
import { clearAiConsent } from "./services/aiConsent";

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
    if (!CLOUD_DATABASE_ENABLED && !CLOUD_AI_ENABLED) {
      console.info("云开发开关未启用，将使用本地演示数据");
      return;
    }

    const cloudEnvId = CLOUD_ENV_ID.trim();
    if (!cloudEnvId) {
      console.info("企业小程序云环境尚未配置，将使用本地演示数据");
      return;
    }

    if (!wx.cloud) {
      console.info("当前环境未启用微信云开发，将使用本地演示数据");
      return;
    }

    try {
      wx.cloud.init({ env: cloudEnvId, traceUser: false });
      this.globalData.cloudReady = true;
    } catch (error) {
      console.warn("微信云开发初始化失败，暂停云端数据读写，请重试", error);
    }
  },
});
