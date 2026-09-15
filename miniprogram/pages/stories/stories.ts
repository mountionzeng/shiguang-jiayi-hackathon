import { accountOwner, contributionStoryTitle, MemoryContribution, memoryPool } from "../../domain/biography";
import {
  deleteStoryRemoteFirst,
  loadRoomStateRemoteFirst,
  purgeAllDeletedMemoriesRemoteFirst,
  purgeMemoryRemoteFirst,
  restoreMemoryRemoteFirst,
  restoreStoryRemoteFirst,
  saveCurrentMemberIdLocal,
} from "../../services/roomRepository";
import { recentlyDeletedItems } from "../../services/recentlyDeleted";
import { shelfStoryLabel, storyShelf } from "../../services/storyShelf";
import { loadCurrentStoryTitle, saveCurrentStoryTitle } from "../../services/storySelection";

interface StoryRow {
  key: string;
  title: string;
  label: string;
  excerpt: string;
  memoryCount: number;
  manuscriptMemberId: string;
}

interface DeletedStoryRow { key: string; title: string; deletedLabel: string; }
interface DeletedItemRow { type: "story" | "memory"; id: string; title: string; deletedLabel: string; }

function deletedLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "已删除" : `${date.getMonth() + 1}月${date.getDate()}日删除`;
}

/**
 * 人生之书：你所有的故事。书就是故事——同名的记忆是一个故事，以前每个档案整理好的
 * 书稿也是一个故事。点开一个故事看它的记忆，接着讲，或者打开整理好的章节。
 */
Page({
  data: {
    stories: [] as StoryRow[],
    deletedStories: [] as DeletedStoryRow[],
    trashOpen: false,
    deletedItems: [] as DeletedItemRow[],
    deletedMemoryCount: 0,
    selectedKey: "", selectedTitle: "", selectedManuscriptMemberId: "",
    memories: [] as MemoryContribution[], ungroupedCount: 0, hasManuscript: false, ownerId: "", loadError: "",
  },
  /** 从首页书封点进来时，直接停在那个故事上。 */
  onLoad(options: { key?: string } = {}) {
    if (!options.key) return;
    try {
      this.setData({ selectedKey: decodeURIComponent(options.key) });
    } catch {
      // 参数坏了就还是显示全部故事。
    }
  },

  onShow() { void this.refresh().catch(() => this.setData({ loadError: "故事暂时未加载成功，请重试。" })); },
  async refresh() {
    const state = await loadRoomStateRemoteFirst();
    const pool = memoryPool(state.contributions);
    const byId = new Map(pool.map(memory => [memory.id, memory]));
    const shelf = storyShelf(state);
    const selected = shelf.find(story => story.key === this.data.selectedKey);
    this.setData({
      stories: shelf.map(story => ({
        key: story.key, title: story.title, label: shelfStoryLabel(story), excerpt: story.excerpt,
        memoryCount: story.memoryIds.length, manuscriptMemberId: story.manuscriptMemberId ?? "",
      })),
      deletedStories: (state.deletedStories ?? []).map((story) => ({
        key: story.key, title: story.title, deletedLabel: deletedLabel(story.deletedAt),
      })),
      deletedItems: recentlyDeletedItems(state).map((item) => ({
        type: item.type, id: item.id, title: item.title,
        deletedLabel: `${item.type === "story" ? "故事" : "记忆"} · ${deletedLabel(item.deletedAt)}`,
      })),
      deletedMemoryCount: state.contributions.filter((memory) => memory.deletedAt).length,
      // 故事在别处被改名或删掉时，回到故事列表。
      selectedKey: selected?.key ?? "",
      selectedTitle: selected?.title ?? "",
      selectedManuscriptMemberId: selected?.manuscriptMemberId ?? "",
      memories: selected ? selected.memoryIds.map(id => byId.get(id)).filter((memory): memory is MemoryContribution => Boolean(memory)) : [],
      ungroupedCount: pool.filter(memory => !contributionStoryTitle(memory)).length,
      hasManuscript: shelf.some(story => story.manuscriptMemberId),
      ownerId: accountOwner(state.members)?.id ?? "",
      loadError: "",
    });
  },
  async openStory(event: { currentTarget: { dataset: { key: string } } }) {
    const row = this.data.stories.find(story => story.key === event.currentTarget.dataset.key);
    if (!row) return;
    // 只有整理好的章节、还没有记忆的故事，直接打开章节。
    if (!row.memoryCount && row.manuscriptMemberId) { this.openManuscript(row.manuscriptMemberId); return; }
    this.setData({ selectedKey: row.key });
    await this.refresh().catch(() => this.setData({ loadError: "故事暂时未加载成功，请重试。" }));
  },
  /** 书稿页仍按档案读取；打开哪个故事的章节，就先切到它所在的档案。 */
  openManuscript(memberId: string) {
    saveCurrentMemberIdLocal(memberId);
    wx.navigateTo({ url: "/pages/book/book" });
  },
  openSelectedManuscript() { this.openManuscript(this.data.selectedManuscriptMemberId); },
  backToStories() { this.setData({ selectedKey: "", selectedTitle: "", selectedManuscriptMemberId: "", memories: [] }); },
  deleteSelectedStory() {
    const key = this.data.selectedKey;
    const title = this.data.selectedTitle;
    if (!key || !title) return Promise.resolve();
    return new Promise<void>((resolve) => wx.showModal({
      title: `删除「${title}」？`,
      content: "故事会进入最近删除；原始记忆和书稿版本都会保留，恢复后原样回来。",
      confirmText: "删除",
      confirmColor: "#c75245",
      success: async (result) => {
        if (!result.confirm) { resolve(); return; }
        try {
          await deleteStoryRemoteFirst(key, title);
          if (loadCurrentStoryTitle() === title) saveCurrentStoryTitle("");
          this.backToStories();
          await this.refresh();
          wx.showToast({ title: "已放进最近删除", icon: "none" });
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "删除没有完成，请重试", icon: "none" });
        }
        resolve();
      },
      fail: () => resolve(),
    }));
  },
  async restoreStory(event: { currentTarget: { dataset: { key: string } } }) {
    try {
      await restoreStoryRemoteFirst(event.currentTarget.dataset.key);
      await this.refresh();
      wx.showToast({ title: "已恢复", icon: "none" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "恢复没有完成，请重试", icon: "none" });
    }
  },
  openTrash() { this.setData({ trashOpen: true }); },
  /** 最近删除里的一行：故事按 key 恢复，记忆按 id 恢复。 */
  async restoreItem(event: { currentTarget: { dataset: { type: "story" | "memory"; id: string } } }) {
    const { type, id } = event.currentTarget.dataset;
    try {
      if (type === "story") await restoreStoryRemoteFirst(id);
      else await restoreMemoryRemoteFirst(id);
      await this.refresh();
      wx.showToast({ title: "已恢复", icon: "none" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "恢复没有完成，请重试", icon: "none" });
    }
  },
  /** 永久删除一段记忆：真删，不能恢复，所以先问一句。故事没有永久删除。 */
  purgeItem(event: { currentTarget: { dataset: { id: string; title: string } } }) {
    const { id, title } = event.currentTarget.dataset;
    wx.showModal({
      title: "永久删除",
      content: `「${title}」会被永久删掉，不能再恢复。确定吗？`,
      confirmText: "永久删除",
      confirmColor: "#b4503c",
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await purgeMemoryRemoteFirst(id);
          await this.refresh();
          wx.showToast({ title: "已永久删除", icon: "none" });
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "删除没有完成，请重试", icon: "none" });
        }
      },
    });
  },
  /** 一键清空：最近删除里的记忆全部永久删掉；删掉的故事留着，仍可恢复。 */
  purgeAll() {
    const count = this.data.deletedMemoryCount;
    if (!count) return;
    wx.showModal({
      title: "清空已删除的记忆",
      content: `最近删除里的 ${count} 段记忆会被永久删掉，不能再恢复。删掉的故事不受影响。`,
      confirmText: "全部清空",
      confirmColor: "#b4503c",
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await purgeAllDeletedMemoriesRemoteFirst();
          await this.refresh();
          wx.showToast({ title: "已清空", icon: "none" });
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "清空没有完成，请重试", icon: "none" });
        }
      },
    });
  },
  closeTrash() { this.setData({ trashOpen: false }); },
  /** 点弹层里的内容不关，点弹层外的空白才关。 */
  keepTrashOpen() {},
  retryLoad() { this.onShow(); },
  editMemory(event: { currentTarget: { dataset: { id: string } } }) {
    wx.navigateTo({ url: "/pages/archive/archive?id=" + encodeURIComponent(event.currentTarget.dataset.id) });
  },
  continueStory() { wx.navigateTo({ url: "/pages/interview/interview?memoryType=memoir&storyTitle=" + encodeURIComponent(this.data.selectedTitle) }); },
  openMemories() { wx.navigateTo({ url: "/pages/archive/archive" }); },
  /** 还没有整理过任何章节时，从你自己的档案开始整理。 */
  openBook() {
    if (this.data.ownerId) saveCurrentMemberIdLocal(this.data.ownerId);
    wx.navigateTo({ url: "/pages/book/book" });
  },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
