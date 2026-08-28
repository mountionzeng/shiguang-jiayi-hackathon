import { CLOUD_AI_ENABLED } from "./config/runtime";

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
    if (!CLOUD_AI_ENABLED) {
      console.info("云 AI 开关未启用，将使用本地演示草稿");
      return;
    }

    if (!wx.cloud) {
      console.info("当前环境未启用微信云开发，将使用本地演示草稿");
      return;
    }

    try {
      wx.cloud.init({ traceUser: true });
      this.globalData.cloudReady = true;
    } catch (error) {
      console.warn("微信云开发初始化失败，将使用本地演示草稿", error);
    }
  },
});
