import {
  contributionStoryTitle,
  FamilyMember,
  FamilyRoomState,
  MemoryContribution,
  personalBookContributions,
} from "../../domain/biography";
import {
  DIMENSION_LABELS,
  InterviewDimension,
  nextInterviewPrompt,
} from "../../domain/interview";
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

interface RecommendedQuestionView {
  label: string;
  context: string;
  text: string;
  sourceId: string;
  storyTitle: string;
}

const RECOMMENDATION_DIMENSIONS: InterviewDimension[] = [
  "person",
  "time",
  "place",
  "event",
  "feeling",
];

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

function latestContribution(
  contributions: MemoryContribution[],
): MemoryContribution | undefined {
  return contributions
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function compactContext(contribution: MemoryContribution): string {
  const storyTitle = contributionStoryTitle(contribution);
  const seed = storyTitle || contribution.summary || contribution.title || contribution.text;
  const cleaned = seed.replace(/\s+/g, "");
  const clipped = cleaned.length > 16 ? `${cleaned.slice(0, 16)}...` : cleaned;
  return clipped ? `关于${clipped}` : "关于刚刚那段记忆";
}

function recommendedQuestionFor(
  contribution: MemoryContribution | undefined,
  offset: number,
): RecommendedQuestionView | undefined {
  if (!contribution) return undefined;

  const askedDimensions = RECOMMENDATION_DIMENSIONS.slice(
    0,
    offset % RECOMMENDATION_DIMENSIONS.length,
  );
  const prompt = nextInterviewPrompt({
    answer: contribution.text,
    askedDimensions,
    mode: "personal",
  });

  return {
    label: DIMENSION_LABELS[prompt.dimension],
    context: compactContext(contribution),
    text: prompt.text,
    sourceId: contribution.id,
    storyTitle: contributionStoryTitle(contribution),
  };
}

function interviewUrl(sourceId: string, storyTitle: string): string {
  const query = [
    `sourceId=${encodeURIComponent(sourceId)}`,
    `storyTitle=${encodeURIComponent(storyTitle)}`,
  ].join("&");
  return `/pages/interview/interview?${query}`;
}

Page({
  recommendationOffset: 0,

  data: {
    hasProfile: false,
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
    recommendedQuestionLabel: "",
    recommendedQuestionContext: "",
    recommendedQuestion: "",
    recommendedSourceId: "",
    recommendedStoryTitle: "",
    hasRecommendedQuestion: false,
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
    const hasProfile = Boolean(member.id);
    const personal = hasProfile
      ? personalBookContributions(currentState.contributions, member.id)
      : [];
    const draft = hasProfile ? currentState.personalDrafts?.[member.id] : undefined;
    const recentStories = recentStoriesFor(personal);
    const recommendedQuestion = recommendedQuestionFor(
      latestContribution(personal),
      this.recommendationOffset,
    );

    this.setData({
      hasProfile,
      memberName: member.name,
      memberAvatarText: member.avatarText,
      bookTitle: hasProfile ? `${member.name}的人生之书` : "人生之书",
      coverSubtitle: hasProfile ? (draft?.title ?? "还没有整理成章节") : "先建立一个档案",
      memoryCount: personal.filter((memory) => (memory.memoryType ?? "note") === "note").length,
      memoirCount: personal.filter((memory) => memory.memoryType === "memoir").length,
      familyMemberCount: currentState.members.length,
      profileOptions: profileOptionsFor(currentState.members, member.id),
      recommendedQuestionLabel: recommendedQuestion?.label ?? "",
      recommendedQuestionContext: recommendedQuestion?.context ?? "",
      recommendedQuestion: recommendedQuestion?.text ?? "",
      recommendedSourceId: recommendedQuestion?.sourceId ?? "",
      recommendedStoryTitle: recommendedQuestion?.storyTitle ?? "",
      hasRecommendedQuestion: Boolean(recommendedQuestion),
      recentStories,
      hasRecentStories: recentStories.length > 0,
    });
  },

  startInterview() {
    if (!this.data.memberName) {
      wx.showToast({ title: "请先创建一个档案", icon: "none" });
      wx.navigateTo({ url: "/pages/profiles/profiles" });
      return;
    }
    wx.navigateTo({ url: "/pages/interview/interview" });
  },

  openProfiles() {
    this.setData({ profileChooserOpen: !this.data.profileChooserOpen });
  },

  createFirstProfile() {
    wx.navigateTo({ url: "/pages/profiles/profiles" });
  },

  addFamilyMember() {
    this.setData({ profileChooserOpen: false });
    wx.navigateTo({ url: "/pages/profiles/profiles" });
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

  changeRecommendedQuestion() {
    this.recommendationOffset += 1;
    void this.refresh();
  },

  continueRecommendedQuestion() {
    const sourceId = this.data.recommendedSourceId || "";
    if (!sourceId) {
      wx.showToast({ title: "还没有可追问的记忆", icon: "none" });
      return;
    }

    wx.navigateTo({
      url: interviewUrl(sourceId, this.data.recommendedStoryTitle || ""),
    });
  },

  continueStory(event: {
    currentTarget: { dataset: { id: string; title: string } };
  }) {
    const storyTitle = event.currentTarget.dataset.title || "";
    const sourceId = event.currentTarget.dataset.id || "";
    wx.navigateTo({ url: interviewUrl(sourceId, storyTitle) });
  },
});
