import { contributionStoryTitle, memoryAiLabel, MemoryContribution, memoryPool } from "../../domain/biography";
import { memoryDisplayTitle } from "../../domain/memoryTitle";
import { loadRoomStateRemoteFirst } from "../../services/roomRepository";
import { logLoadError } from "../../services/loadErrorLog";
import { loadCurrentStoryId } from "../../services/storySelection";

interface RecallRow {
  id: string;
  title: string;
  excerpt: string;
  dateLabel: string;
  storyLabel: string;
  storyTitle: string;
  storyId: string;
  needsStoryChoice: boolean;
  storyChoices: Array<{ id: string; title: string }>;
  aiLabel: string;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function recallRows(contributions: MemoryContribution[], stories: Array<{ id: string; title: string; bookTitle?: string; memoryIds: string[]; deletedAt?: string }>, currentStoryId: string): RecallRow[] {
  return memoryPool(contributions)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((memory) => {
      const candidates = stories.filter(story => !story.deletedAt && story.memoryIds.includes(memory.id));
      const selected = candidates.find(story => story.id === currentStoryId) ?? (candidates.length === 1 ? candidates[0] : undefined);
      return {
        id: memory.id,
        title: memoryDisplayTitle(memory),
        excerpt: memory.text.slice(0, 64),
        dateLabel: formatDate(memory.createdAt),
        storyLabel: selected?.bookTitle || selected?.title || (candidates.length > 1 ? `用于 ${candidates.length} 本书` : contributionStoryTitle(memory) || "还没放进故事"),
        storyTitle: contributionStoryTitle(memory),
        storyId: selected?.id || "",
        needsStoryChoice: candidates.length > 1 && !selected,
        storyChoices: candidates.map(story => ({ id: story.id, title: story.bookTitle || story.title })),
        aiLabel: memoryAiLabel(memory),
      };
    });
}

/** 全部回忆：先打开已保存正文，在同一页面继续阅读、修改或展开对话。 */
Page({
  data: {
    items: [] as RecallRow[],
    hasItems: false,
    loadError: "",
  },

  onShow() {
    void this.refresh().catch((error) => { logLoadError("recall", error); this.setData({ loadError: "回忆暂时没加载出来，请重试。" }); });
  },

  async refresh() {
    const state = await loadRoomStateRemoteFirst();
    const items = recallRows(state.contributions, state.storyMigration?.status === "active" ? state.stories ?? [] : [], loadCurrentStoryId());
    this.setData({ items, hasItems: items.length > 0, loadError: "" });
  },

  retryLoad() {
    this.onShow();
  },

  continueMemory(event: { currentTarget: { dataset: { id: string; title: string; story: string; choice: boolean } } }) {
    const { id } = event.currentTarget.dataset;
    wx.navigateTo({ url: "/pages/archive/archive?id=" + encodeURIComponent(id) });
  },

  startQuickNote() {
    wx.navigateTo({ url: "/pages/interview/interview?memoryType=note" });
  },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
