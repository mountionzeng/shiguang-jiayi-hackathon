import { contributionStoryTitle, MemoryContribution, memoryPool } from "../../domain/biography";
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
      };
    });
}

/** 全部回忆：从讲过的任何一段接着聊。挑完就进聊天，不改动原来的记忆。 */
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
    const { id, title, story, choice } = event.currentTarget.dataset;
    if (choice) {
      const item = this.data.items.find(row => row.id === id);
      if (!item?.storyChoices.length) return;
      wx.showActionSheet({
        itemList: item.storyChoices.map(candidate => `《${candidate.title}》`),
        success: result => {
          const selected = item.storyChoices[result.tapIndex];
          if (selected) wx.navigateTo({ url: `/pages/interview/interview?memoryType=memoir&sourceId=${encodeURIComponent(id)}&storyId=${encodeURIComponent(selected.id)}` });
        },
      });
      return;
    }
    const storyQuery = story ? `&storyId=${encodeURIComponent(story)}` : `&storyTitle=${encodeURIComponent(title || "")}`;
    wx.navigateTo({
      url: `/pages/interview/interview?memoryType=memoir&sourceId=${encodeURIComponent(id)}${storyQuery}`,
    });
  },

  startQuickNote() {
    wx.navigateTo({ url: "/pages/interview/interview?memoryType=note" });
  },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
