import { contributionStoryTitle, MemoryContribution, memoryPool } from "../../domain/biography";
import { memoryDisplayTitle } from "../../domain/memoryTitle";
import { loadRoomStateRemoteFirst } from "../../services/roomRepository";

interface RecallRow {
  id: string;
  title: string;
  excerpt: string;
  dateLabel: string;
  storyLabel: string;
  storyTitle: string;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function recallRows(contributions: MemoryContribution[]): RecallRow[] {
  return memoryPool(contributions)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((memory) => ({
      id: memory.id,
      title: memoryDisplayTitle(memory),
      excerpt: memory.text.slice(0, 64),
      dateLabel: formatDate(memory.createdAt),
      storyLabel: contributionStoryTitle(memory) || "还没放进故事",
      storyTitle: contributionStoryTitle(memory),
    }));
}

/** 全部回忆：从讲过的任何一段接着聊。挑完就进聊天，不改动原来的记忆。 */
Page({
  data: {
    items: [] as RecallRow[],
    hasItems: false,
    loadError: "",
  },

  onShow() {
    void this.refresh().catch(() => this.setData({ loadError: "回忆暂时没加载出来，请重试。" }));
  },

  async refresh() {
    const state = await loadRoomStateRemoteFirst();
    const items = recallRows(state.contributions);
    this.setData({ items, hasItems: items.length > 0, loadError: "" });
  },

  retryLoad() {
    this.onShow();
  },

  continueMemory(event: { currentTarget: { dataset: { id: string; title: string } } }) {
    const { id, title } = event.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/interview/interview?memoryType=memoir&sourceId=${encodeURIComponent(id)}&storyTitle=${encodeURIComponent(title || "")}`,
    });
  },

  startQuickNote() {
    wx.navigateTo({ url: "/pages/interview/interview?memoryType=note" });
  },
  onShareAppMessage() { return { title: "拾光Ai｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光Ai｜把重要的故事慢慢写下来" }; },
});
