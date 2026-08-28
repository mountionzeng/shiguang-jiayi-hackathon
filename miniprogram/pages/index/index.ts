import {
  resetDemoRoomRemoteFirst,
  roomDataModeLabel,
} from "../../services/roomRepository";

Page({
  data: {
    steps: [
      { number: "01", label: "家人讲述" },
      { number: "02", label: "老人确认" },
      { number: "03", label: "写成一章" },
    ],
    dataModeLabel: "",
  },

  onShow() {
    this.setData({ dataModeLabel: roomDataModeLabel() });
  },

  enterRoom() {
    wx.navigateTo({ url: "/pages/room/room" });
  },

  async resetDemo() {
    try {
      await resetDemoRoomRemoteFirst();
      wx.showToast({ title: "演示家庭已重置", icon: "none" });
    } catch (error) {
      wx.showToast({
        title: error instanceof Error ? error.message : "暂时无法重置",
        icon: "none",
      });
    }
  },
});
