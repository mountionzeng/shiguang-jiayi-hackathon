import {
  CLOUD_AI_ENABLED,
  CLOUD_DATABASE_ENABLED,
  CLOUD_ENV_ID,
} from "./config/runtime";

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
    if (!CLOUD_DATABASE_ENABLED && !CLOUD_AI_ENABLED) {
      console.info("云开发开关未启用，将使用本地演示数据");
      return;
    }

    if (!wx.cloud) {
      console.info("当前环境未启用微信云开发，将使用本地演示数据");
      return;
    }

    try {
      wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true });
      this.globalData.cloudReady = true;
    } catch (error) {
      console.warn("微信云开发初始化失败，将使用本地演示草稿", error);
    }
  },
});
