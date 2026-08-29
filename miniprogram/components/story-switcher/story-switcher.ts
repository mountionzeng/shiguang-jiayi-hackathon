Component({
  properties: {
    current: {
      type: String,
      value: "home",
    },
  },

  methods: {
    openPersonal() {
      if (this.data.current === "personal") return;
      wx.reLaunch({ url: "/pages/book/book" });
    },

    openFamily() {
      if (this.data.current === "family") return;
      wx.reLaunch({ url: "/pages/room/room" });
    },

    startInterview() {
      wx.navigateTo({ url: "/pages/interview/interview" });
    },
  },
});
