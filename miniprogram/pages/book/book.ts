import {
  biographySourceContributions,
  biographySourceFingerprint,
  BiographyDraft,
} from "../../domain/biography";
import { generateBiography } from "../../services/biographyService";
import { loadRoomState, saveDraftIfSourcesUnchanged } from "../../services/roomStorage";

interface SourceView {
  id: string;
  text: string;
  byline: string;
}

Page({
  data: {
    protagonistName: "",
    sources: [] as SourceView[],
    sourceCount: 0,
    draft: undefined as BiographyDraft | undefined,
    generating: false,

    isCloudDraft: false,
    modeLabel: "",
    modeNote: "",

    /** 章节所依据的来源在生成后又变了，正文与当前事实不一致。 */
    stale: false,
    showSources: false,
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const state = loadRoomState();
    const qualified = biographySourceContributions(state.contributions);
    const draft = state.draft;
    const isCloudDraft = draft?.generationMode === "cloud-ai";

    this.setData({
      protagonistName: state.protagonistName,
      sources: qualified.map((item) => ({
        id: item.id,
        text: item.text,
        byline: `${item.authorName} · ${item.relation}`,
      })),
      sourceCount: qualified.length,
      draft,
      isCloudDraft,
      modeLabel: draft ? (isCloudDraft ? "AI 云生成草稿" : "本地演示整理") : "",
      modeNote: draft
        ? isCloudDraft
          ? "由云端模型依据下方来源写成，家人需要复核之后才算数。"
          : "云 AI 未启用，这段文字是按规则拼接来源得到的，不是模型创作。"
        : "",
      stale: Boolean(draft) && draft!.sourceCount !== qualified.length,
    });
  },

  toggleSources() {
    this.setData({ showSources: !this.data.showSources });
  },

  async generateChapter() {
    if (this.data.generating) return;

    const state = loadRoomState();
    if (biographySourceContributions(state.contributions).length === 0) {
      wx.showToast({ title: "还没有可用的来源", icon: "none" });
      return;
    }

    // 记录生成时的来源指纹：生成期间来源若发生变化，旧结果必须丢弃。
    const sourceFingerprint = biographySourceFingerprint(state);
    this.setData({ generating: true });
    try {
      const draft = await generateBiography(state);
      if (!saveDraftIfSourcesUnchanged(draft, sourceFingerprint, loadRoomState())) {
        this.refresh();
        wx.showToast({ title: "来源刚刚变了，请重新整理", icon: "none", duration: 2400 });
        return;
      }
      this.refresh();
      wx.showToast({
        title: draft.generationMode === "cloud-ai" ? "章节草稿已生成" : "演示草稿已整理",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: error instanceof Error ? error.message : "暂时无法整理",
        icon: "none",
      });
    } finally {
      this.setData({ generating: false });
    }
  },

  goBack() {
    wx.navigateBack();
  },
});
