import { resetDemoRoom } from "../../services/roomStorage";

Page({
  data: {
    steps: [
      { number: "01", label: "家人讲述" },
      { number: "02", label: "老人确认" },
      { number: "03", label: "写成一章" },
    ],
  },

  enterRoom() {
    wx.navigateTo({ url: "/pages/room/room" });
  },

  resetDemo() {
    resetDemoRoom();
    wx.showToast({ title: "演示家庭已重置", icon: "none" });
  },
});
