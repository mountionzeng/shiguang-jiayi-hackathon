import {
  contributionStoryTitle,
  FamilyRoomState,
  MemoryContribution,
  personalBookContributions,
} from "../../domain/biography";
import {
  loadCurrentMember,
  loadRoomState,
} from "../../services/roomStorage";

interface RecentStoryView {
  id: string;
  title: string;
  excerpt: string;
  dateLabel: string;
  countLabel: string;
  storyTitle: string;
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

Page({
  data: {
    memberName: "",
    memberInitial: "",
    bookTitle: "",
    coverSubtitle: "",
    fragmentCount: 0,
    storyCount: 0,
    chapterCount: 0,
    recentStories: [] as RecentStoryView[],
    hasRecentStories: false,
  },

  onShow() {
    this.refresh();
  },

  refresh(state: FamilyRoomState = loadRoomState()) {
    const member = loadCurrentMember(state);
    const personal = personalBookContributions(state.contributions, member.id);
    const storyTitles = new Set(
      personal.map(contributionStoryTitle).filter(Boolean),
    );
    const draft = state.personalDrafts?.[member.id];
    const recentStories = recentStoriesFor(personal);

    this.setData({
      memberName: member.name,
      memberInitial: member.name.slice(0, 1),
      bookTitle: `${member.name}的人生之书`,
      coverSubtitle: draft?.title ?? "还没有整理成章节",
      fragmentCount: personal.filter((memory) => !contributionStoryTitle(memory)).length,
      storyCount: storyTitles.size,
      chapterCount: draft ? 1 : 0,
      recentStories,
      hasRecentStories: recentStories.length > 0,
    });
  },

  startInterview() {
    wx.navigateTo({ url: "/pages/interview/interview" });
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
