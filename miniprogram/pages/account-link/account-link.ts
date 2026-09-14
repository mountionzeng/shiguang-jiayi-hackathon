import {
  createDesktopStoryCode,
  desktopStoryOptions,
  DesktopStoryOption,
} from "../../services/drinkingTimeAccount";
import { loadRoomStateRemoteFirst } from "../../services/roomRepository";

Page({
  data: {
    busy: false,
    stories: [] as DesktopStoryOption[],
    code: "",
    expiresLabel: "",
    selectedTitle: "",
    loadError: "",
  },
  onShow() { void this.refresh(); },
  async refresh() {
    if (this.data.busy) return;
    this.setData({ busy: true, loadError: "" });
    try {
      const state = await loadRoomStateRemoteFirst();
      this.setData({ stories: desktopStoryOptions(state) });
    } catch {
      this.setData({ loadError: "故事暂时没有加载成功，请重试。" });
    } finally {
      this.setData({ busy: false });
    }
  },
  choose(event: { currentTarget: { dataset: { key: string; title: string } } }) {
    if (this.data.busy) return;
    const { key, title } = event.currentTarget.dataset;
    wx.showModal({
      title: `把「${title}」放到电脑？`,
      content: "会生成一个五分钟有效的一次性登录码。电脑登录后，这个故事的记忆和章节就能继续制作视频。",
      confirmText: "生成登录码",
      success: result => { if (result.confirm) void this.createCode(key, title); },
    });
  },
  async createCode(key: string, title: string) {
    this.setData({ busy: true, code: "", selectedTitle: title });
    try {
      const state = await loadRoomStateRemoteFirst();
      const result = await createDesktopStoryCode(state, key);
      const expires = new Date(result.expiresAt);
      this.setData({
        code: result.code,
        expiresLabel: `${expires.getHours().toString().padStart(2, "0")}:${expires.getMinutes().toString().padStart(2, "0")} 前有效`,
      });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "生成失败", icon: "none" });
    } finally {
      this.setData({ busy: false });
    }
  },
  copyCode() {
    if (this.data.code) wx.setClipboardData({ data: this.data.code });
  },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
});
