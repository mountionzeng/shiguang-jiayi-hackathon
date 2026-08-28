const TAB_PAGES = ["/pages/index/index", "/pages/room/room"];

Component({
  data: {
    selected: 0,
  },

  methods: {
    switchTab(event: { currentTarget: { dataset: { index: number } } }) {
      const index = Number(event.currentTarget.dataset.index);
      if (index === this.data.selected) return;
      wx.switchTab({ url: TAB_PAGES[index] });
    },

    startInterview() {
      const mode = this.data.selected === 0 ? "personal" : "family";
      wx.navigateTo({ url: `/pages/interview/interview?mode=${mode}` });
    },
  },
});
