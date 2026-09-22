import { contributionStoryTitle, memoryAiLabel, MemoryContribution, memoryPool } from "../../domain/biography";
import {
  deleteStoryRemoteFirst,
  loadRoomStateRemoteFirst,
  purgeAllDeletedMemoriesRemoteFirst,
  purgeMemoryRemoteFirst,
  restoreMemoryRemoteFirst,
  restoreStoryRemoteFirst,
  saveCurrentMemberIdLocal,
  usesCloudStorage,
} from "../../services/roomRepository";
import { recentlyDeletedItems } from "../../services/recentlyDeleted";
import { shelfStoryLabel, storyShelf } from "../../services/storyShelf";
import { loadCurrentStoryId, loadCurrentStoryTitle, saveCurrentStoryId, saveCurrentStoryTitle } from "../../services/storySelection";
import { logLoadError } from "../../services/loadErrorLog";
import { createStoryBook, ensureStoryBooks } from "../../services/storyBooks";

interface StoryRow {
  key: string;
  title: string;
  label: string;
  excerpt: string;
  memoryCount: number;
  bookTitle: string;
  writingMode: "objective" | "creative";
  chapterCount: number;
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
    selectedKey: "", selectedTitle: "", selectedBookTitle: "", selectedWritingMode: "objective" as "objective" | "creative",
    memories: [] as Array<MemoryContribution & { aiLabel: string }>, ungroupedCount: 0, loadError: "",
    createOpen: false, createTitle: "", createMode: "objective" as "objective" | "creative",
    createMemories: [] as Array<MemoryContribution & { checked: boolean }>, creating: false, pendingMigrationCount: 0,
  },
  openCreateOnShow: false,
  /** 从首页书封点进来时，直接停在那个故事上。 */
  onLoad(options: { key?: string; create?: string } = {}) {
    this.openCreateOnShow = options.create === "1";
    if (options.key) try { this.setData({ selectedKey: decodeURIComponent(options.key) }); } catch { /* 显示全部故事 */ }
  },

  onShow() { void this.refresh().then(() => { if (this.openCreateOnShow) { this.openCreateOnShow = false; this.openCreate(); } }).catch((error) => { logLoadError("stories", error); this.setData({ loadError: "故事暂时未加载成功，请重试。" }); }); },
  async refresh() {
    const state = usesCloudStorage() ? await ensureStoryBooks() : await loadRoomStateRemoteFirst();
    const pool = memoryPool(state.contributions);
    const byId = new Map(pool.map(memory => [memory.id, memory]));
    const shelf = storyShelf(state);
    const selected = shelf.find(story => story.key === this.data.selectedKey);
    this.setData({
      stories: shelf.map(story => ({
        key: story.key, title: story.title, label: shelfStoryLabel(story), excerpt: story.excerpt,
        memoryCount: story.memoryIds.length, bookTitle: story.bookTitle || story.title,
        writingMode: story.writingMode || "objective", chapterCount: story.chapterCount,
        manuscriptMemberId: story.manuscriptMemberId ?? "",
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
      selectedBookTitle: selected?.bookTitle ?? "",
      selectedWritingMode: selected?.writingMode ?? "objective",
      memories: selected
        ? selected.memoryIds.map(id => byId.get(id)).filter((memory): memory is MemoryContribution => Boolean(memory))
          .map(memory => ({ ...memory, aiLabel: memoryAiLabel(memory) }))
        : [],
      ungroupedCount: pool.filter(memory => !contributionStoryTitle(memory)).length,
      pendingMigrationCount: (state.storyMigration?.pending ?? []).filter(item => !item.resolvedStoryId).length,
      loadError: "",
    });
  },
  async openStory(event: { currentTarget: { dataset: { key: string } } }) {
    const row = this.data.stories.find(story => story.key === event.currentTarget.dataset.key);
    if (!row) return;
    if (row.key.startsWith("manuscript:") && row.manuscriptMemberId) { this.openLegacyManuscript(row.manuscriptMemberId); return; }
    this.setData({ selectedKey: row.key });
    await this.refresh().catch((error) => { logLoadError("stories", error); this.setData({ loadError: "故事暂时未加载成功，请重试。" }); });
  },
  openManuscript(storyId: string) {
    saveCurrentStoryId(storyId);
    wx.navigateTo({ url: "/pages/book/book?storyId=" + encodeURIComponent(storyId) });
  },
  openLegacyManuscript(memberId: string) {
    saveCurrentMemberIdLocal(memberId);
    wx.navigateTo({ url: "/pages/book/book" });
  },
  openSelectedManuscript() { this.openManuscript(this.data.selectedKey); },
  backToStories() { this.setData({ selectedKey: "", selectedTitle: "", selectedBookTitle: "", memories: [] }); },
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
          if (loadCurrentStoryId() === key) saveCurrentStoryId("");
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
  continueStory() {
    const query = this.data.selectedKey.startsWith("story-")
      ? "storyId=" + encodeURIComponent(this.data.selectedKey)
      : "storyTitle=" + encodeURIComponent(this.data.selectedTitle);
    wx.navigateTo({ url: "/pages/interview/interview?memoryType=memoir&" + query });
  },
  openMemories() { wx.navigateTo({ url: "/pages/archive/archive" }); },
  openMigration() { wx.navigateTo({ url: "/pages/story-migration/story-migration" }); },
  openCreate() {
    const pool = this.data.createMemories.length ? this.data.createMemories : [];
    if (pool.length) { this.setData({ createOpen: true }); return; }
    void loadRoomStateRemoteFirst().then(state => this.setData({
      createOpen: true,
      createMemories: memoryPool(state.contributions).map(memory => ({ ...memory, checked: false })),
    }));
  },
  closeCreate() { if (!this.data.creating) this.setData({ createOpen: false }); },
  keepCreateOpen() {},
  onCreateTitle(event: WechatMiniprogram.Input) { this.setData({ createTitle: event.detail.value }); },
  onCreateMode(event: { detail: { value: "objective" | "creative" } }) { this.setData({ createMode: event.detail.value }); },
  onCreateMemories(event: { detail: { value: string[] } }) {
    const selected = new Set(event.detail.value);
    this.setData({ createMemories: this.data.createMemories.map(memory => ({ ...memory, checked: selected.has(memory.id) })) });
  },
  async createBook() {
    const title = this.data.createTitle.trim();
    if (!title || this.data.creating) { if (!title) wx.showToast({ title: "请先给故事起个名字", icon: "none" }); return; }
    this.setData({ creating: true });
    try {
      const memoryIds = this.data.createMemories.filter(memory => memory.checked).map(memory => memory.id);
      const { story } = await createStoryBook({
        title, writingMode: this.data.createMode,
        memoryIds,
      });
      saveCurrentStoryId(story.id);
      this.setData({ createOpen: false, createTitle: "", createMode: "objective", createMemories: [] });
      const organizeQuery = memoryIds.length ? "&memoryIds=" + memoryIds.map(encodeURIComponent).join(",") : "";
      wx.navigateTo({ url: "/pages/book/book?storyId=" + encodeURIComponent(story.id) + organizeQuery });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "创建失败，请重试", icon: "none" });
    } finally { this.setData({ creating: false }); }
  },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
