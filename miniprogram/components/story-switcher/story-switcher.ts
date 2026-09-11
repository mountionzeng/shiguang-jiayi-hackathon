Component({
  data: {
    chooserOpen: false,
  },

  properties: {
    current: {
      type: String,
      value: "home",
    },
  },

  methods: {
    /** 人生之书是你所有的故事，不是某一本书稿。 */
    openPersonal() {
      if (this.data.current === "personal") return;
      wx.reLaunch({ url: "/pages/stories/stories" });
    },

    openFamily() {
      if (this.data.current === "family") return;
      wx.reLaunch({ url: "/pages/room/room" });
    },

    startInterview() {
      this.setData({ chooserOpen: true });
    },

    closeChooser() {
      this.setData({ chooserOpen: false });
    },

    keepChooserOpen() {
      // 阻止点击古籍按钮区域时触发遮罩关闭。
    },

    chooseCaptureMode(event: {
      currentTarget: { dataset: { type: "note" | "memoir" } };
    }) {
      const memoryType = event.currentTarget.dataset.type;
      this.setData({ chooserOpen: false });
      wx.navigateTo({
        url: `/pages/interview/interview?memoryType=${memoryType}`,
      });
    },
  },
});
