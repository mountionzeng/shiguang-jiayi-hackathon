import {
  biographySourceContributions,
  biographySourceFingerprint,
  BiographyDraft,
  MemoryContribution,
} from "../../domain/biography";
import { generateBiography } from "../../services/biographyService";
import {
  loadRoomState,
  saveDraftIfSourcesUnchanged,
} from "../../services/roomStorage";

Page({
  data: {
    protagonistName: "",
    confirmed: [] as MemoryContribution[],
    draft: undefined as BiographyDraft | undefined,
    generating: false,
    modeLabel: "",
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const state = loadRoomState();
    this.setData({
      protagonistName: state.protagonistName,
      confirmed: biographySourceContributions(state.contributions),
      draft: state.draft,
      modeLabel:
        state.draft?.generationMode === "cloud-ai"
          ? "AI 云生成草稿 · 输入来自确认材料，请家人复核"
          : state.draft
            ? "本地演示草稿 · 未冒充 AI"
            : "",
    });
  },

  async generateChapter() {
    if (this.data.generating) return;

    const state = loadRoomState();
    if (biographySourceContributions(state.contributions).length === 0) {
      wx.showToast({ title: "请先确认至少一段回忆", icon: "none" });
      return;
    }

    const sourceFingerprint = biographySourceFingerprint(state);
    this.setData({ generating: true });
    try {
      const draft = await generateBiography(state);
      const latestState = loadRoomState();
      if (!saveDraftIfSourcesUnchanged(draft, sourceFingerprint, latestState)) {
        this.refresh();
        wx.showToast({ title: "确认材料已变化，请重新生成", icon: "none" });
        return;
      }
      this.refresh();
      wx.showToast({
        title: draft.generationMode === "cloud-ai" ? "第一章已生成" : "演示草稿已整理",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: error instanceof Error ? error.message : "暂时无法生成",
        icon: "none",
      });
    } finally {
      this.setData({ generating: false });
    }
  },

  backToRoom() {
    wx.navigateBack({ delta: 2 });
  },
});
