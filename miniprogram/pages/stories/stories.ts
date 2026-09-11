import { contributionStoryTitle, MemoryContribution, personalBookContributions } from "../../domain/biography";
import { loadCurrentMemberRemoteFirst, loadRoomStateRemoteFirst } from "../../services/roomRepository";
Page({
  data: {
    stories: [] as Array<{ title: string; count: number; excerpt: string }>,
    selectedTitle: "", memories: [] as MemoryContribution[], ungroupedCount: 0, loadError: "",
  },
  onShow() { void this.refresh().catch(() => this.setData({ loadError: "故事暂时未加载成功，请重试。" })); },
  async refresh() {
    const state = await loadRoomStateRemoteFirst();
    const member = await loadCurrentMemberRemoteFirst(state);
    const personal = personalBookContributions(state.contributions, member.id);
    const groups = new Map<string, MemoryContribution[]>();
    personal.forEach(memory => {
      const title = contributionStoryTitle(memory);
      if (title) groups.set(title, [...(groups.get(title) ?? []), memory]);
    });
    this.setData({
      stories: Array.from(groups, ([title, memories]) => ({ title, count: memories.length, excerpt: memories[0].text.slice(0, 64) })),
      memories: groups.get(this.data.selectedTitle) ?? [],
      ungroupedCount: personal.filter(memory => !contributionStoryTitle(memory)).length, loadError: "",
    });
  },
  async openStory(event: { currentTarget: { dataset: { title: string } } }) {
    this.setData({ selectedTitle: event.currentTarget.dataset.title });
    await this.refresh().catch(() => this.setData({ loadError: "故事暂时未加载成功，请重试。" }));
  },
  backToStories() { this.setData({ selectedTitle: "", memories: [] }); },
  retryLoad() { this.onShow(); },
  editMemory(event: { currentTarget: { dataset: { id: string } } }) {
    wx.navigateTo({ url: "/pages/archive/archive?id=" + encodeURIComponent(event.currentTarget.dataset.id) });
  },
  continueStory() { wx.navigateTo({ url: "/pages/interview/interview?memoryType=memoir&storyTitle=" + encodeURIComponent(this.data.selectedTitle) }); },
  openMemories() { wx.navigateTo({ url: "/pages/archive/archive" }); },
  openBook() { wx.navigateTo({ url: "/pages/book/book" }); },
});
