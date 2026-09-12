import { accountOwner, contributionStoryTitle, MemoryContribution, memoryPool } from "../../domain/biography";
import { loadRoomStateRemoteFirst, saveCurrentMemberIdLocal } from "../../services/roomRepository";
import { shelfStoryLabel, storyShelf } from "../../services/storyShelf";

interface StoryRow {
  key: string;
  title: string;
  label: string;
  excerpt: string;
  memoryCount: number;
  manuscriptMemberId: string;
}

/**
 * 人生之书：你所有的故事。书就是故事——同名的记忆是一个故事，以前每个档案整理好的
 * 书稿也是一个故事。点开一个故事看它的记忆，接着讲，或者打开整理好的章节。
 */
Page({
  data: {
    stories: [] as StoryRow[],
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
  onShareAppMessage() { return { title: "拾光Ai｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光Ai｜把重要的故事慢慢写下来" }; },
});
