import {
  contributionStoryTitle,
  FamilyMember,
  FamilyRoomState,
  MemoryContribution,
  personalBookContributions,
} from "../../domain/biography";
import {
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  saveCurrentMemberIdLocal,
} from "../../services/roomRepository";

interface RecentStoryView {
  id: string;
  title: string;
  excerpt: string;
  dateLabel: string;
  countLabel: string;
  storyTitle: string;
}

interface ProfileOptionView {
  id: string;
  name: string;
  relation: string;
  avatarText: string;
  selected: boolean;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 首页只展示最近聊过的故事，不承担书稿、权限或成员管理。
 * 同名故事聚合成一项；未命名片段聚合成一个可以继续聊的入口。
 */
function recentStoriesFor(
  contributions: MemoryContribution[],
): RecentStoryView[] {
  const groups = new Map<string, RecentStoryView & { count: number }>();

  contributions
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .forEach((contribution) => {
      const storyTitle = contributionStoryTitle(contribution);
      const key = storyTitle ? `story:${storyTitle}` : "unorganized";
      const existing = groups.get(key);

      if (existing) {
        existing.count += 1;
        existing.countLabel = `已聊 ${existing.count} 段`;
        return;
      }

      groups.set(key, {
        id: contribution.id,
        title: storyTitle || "还没取名的片段",
        excerpt: contribution.text,
        dateLabel: formatDate(contribution.createdAt),
        countLabel: "已聊 1 段",
        storyTitle,
        count: 1,
      });
    });

  return Array.from(groups.values())
    .slice(0, 3)
    .map(({ count: _count, ...story }) => story);
}

function profileOptionsFor(
  members: FamilyMember[],
  currentMemberId: string,
): ProfileOptionView[] {
  return members.map((member) => ({
    id: member.id,
    name: member.name,
    relation: member.relation,
    avatarText: member.avatarText,
    selected: member.id === currentMemberId,
  }));
}

Page({
  data: {
    memberName: "",
    memberAvatarText: "",
    bookTitle: "",
    coverSubtitle: "",
    memoryCount: 0,
    memoirCount: 0,
    familyMemberCount: 0,
    bookOpening: false,
    profileChooserOpen: false,
    profileOptions: [] as ProfileOptionView[],
    recentStories: [] as RecentStoryView[],
    hasRecentStories: false,
  },

  onShow() {
    this.setData({ bookOpening: false });
    void this.refresh();
  },

  async refresh(state?: FamilyRoomState) {
    const currentState = state ?? await loadRoomStateRemoteFirst();
    const member = await loadCurrentMemberRemoteFirst(currentState);
    const personal = personalBookContributions(currentState.contributions, member.id);
    const draft = currentState.personalDrafts?.[member.id];
    const recentStories = recentStoriesFor(personal);

    this.setData({
      memberName: member.name,
      memberAvatarText: member.avatarText,
      bookTitle: `${member.name}的人生之书`,
      coverSubtitle: draft?.title ?? "还没有整理成章节",
      memoryCount: personal.filter((memory) => (memory.memoryType ?? "note") === "note").length,
      memoirCount: personal.filter((memory) => memory.memoryType === "memoir").length,
      familyMemberCount: currentState.members.length,
      profileOptions: profileOptionsFor(currentState.members, member.id),
      recentStories,
      hasRecentStories: recentStories.length > 0,
    });
  },

  startInterview() {
    wx.navigateTo({ url: "/pages/interview/interview" });
  },

  openProfiles() {
    this.setData({ profileChooserOpen: !this.data.profileChooserOpen });
  },

  async chooseProfile(event: {
    currentTarget: { dataset: { id: string } };
  }) {
    const memberId = event.currentTarget.dataset.id;
    const state = await loadRoomStateRemoteFirst();
    const member = state.members.find((item) => item.id === memberId);

    if (!member) {
      wx.showToast({ title: "没有找到这个档案", icon: "none" });
      return;
    }

    saveCurrentMemberIdLocal(member.id);
    this.setData({ profileChooserOpen: false });
    await this.refresh(state);
  },

  openMyHome() {
    wx.navigateTo({ url: "/pages/me/me" });
  },

  openMemoryArchive() {
    if (this.data.bookOpening) return;
    this.setData({ bookOpening: true });
    setTimeout(() => {
      this.setData({ bookOpening: false });
      wx.navigateTo({ url: "/pages/archive/archive" });
    }, 620);
  },

  openArchiveTab(event: {
    currentTarget: { dataset: { tab: "note" | "memoir" } };
  }) {
    const tab = event.currentTarget.dataset.tab === "memoir" ? "memoir" : "note";
    wx.navigateTo({ url: `/pages/archive/archive?tab=${tab}` });
  },

  openMemoryHome() {
    wx.navigateTo({ url: "/pages/room/room" });
  },

  continueStory(event: {
    currentTarget: { dataset: { id: string; title: string } };
  }) {
    const storyTitle = event.currentTarget.dataset.title || "";
    const sourceId = event.currentTarget.dataset.id || "";
    const query = [
      `sourceId=${encodeURIComponent(sourceId)}`,
      `storyTitle=${encodeURIComponent(storyTitle)}`,
    ].join("&");
    wx.navigateTo({ url: `/pages/interview/interview?${query}` });
  },
});
