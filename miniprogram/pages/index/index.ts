import {
  contributionStoryTitle,
  FamilyMember,
  FamilyRoomState,
  isActiveMember,
  isRecordingProfile,
  MemoryContribution,
  memoryPool,
  personalBookContributions,
} from "../../domain/biography";
import {
  FOLLOW_UP_LABEL,
  InterviewDimension,
  nextInterviewPrompt,
} from "../../domain/interview";
import {
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  saveCurrentMemberIdLocal,
} from "../../services/roomRepository";
import { currentManuscript } from "../../services/manuscript";
import { deleteMemberWithConfirm } from "../../services/memberActions";

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
  /** Legacy record not yet sorted into a recording profile or a person. */
  pending: boolean;
}

interface RecommendedQuestionView {
  dimension: InterviewDimension;
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
  return members.filter(isRecordingProfile).map((member) => ({
    id: member.id,
    name: member.name,
    relation: member.relation,
    avatarText: member.avatarText,
    selected: member.id === currentMemberId,
    pending: !member.kind,
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
    label: FOLLOW_UP_LABEL,
    context: compactContext(contribution),
    text: prompt.text,
    dimension: prompt.dimension,
    sourceId: contribution.id,
    storyTitle: contributionStoryTitle(contribution),
  };
}

function interviewUrl(
  sourceId: string,
  storyTitle: string,
  question?: { text: string; dimension: string },
): string {
  const query = [
    `sourceId=${encodeURIComponent(sourceId)}`,
    `storyTitle=${encodeURIComponent(storyTitle)}`,
  ];
  if (question?.text) {
    query.push(
      `question=${encodeURIComponent(question.text)}`,
      `dimension=${encodeURIComponent(question.dimension)}`,
    );
  }
  return `/pages/interview/interview?${query.join("&")}`;
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
    recommendedDimension: "",
    hasRecommendedQuestion: false,
    recentStories: [] as RecentStoryView[],
    hasRecentStories: false,
  },

  onShow() {
    this.setData({ bookOpening: false });
    void this.refresh().catch(() => wx.showToast({ title: "数据加载失败，请重新打开本页重试", icon: "none" }));
  },

  async refresh(state?: FamilyRoomState) {
    const currentState = state ?? await loadRoomStateRemoteFirst();
    const member = await loadCurrentMemberRemoteFirst(currentState);
    const hasProfile = Boolean(member.id);
    const personal = hasProfile
      ? personalBookContributions(currentState.contributions, member.id)
      : [];
    const draft = hasProfile ? currentManuscript(currentState, member.id).draft : undefined;
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
      // The counts open the memory and story lists, which show the shared pool.
      memoryCount: memoryPool(currentState.contributions).length,
      memoirCount: new Set(memoryPool(currentState.contributions).map(contributionStoryTitle).filter(Boolean)).size,
      // Everyone in the group except the author (the account owner's own "自己" books).
      familyMemberCount: currentState.members.filter(item => isActiveMember(item) && item.relation !== "自己").length,
      profileOptions: profileOptionsFor(currentState.members, member.id),
      recommendedQuestionLabel: recommendedQuestion?.label ?? "",
      recommendedQuestionContext: recommendedQuestion?.context ?? "",
      recommendedQuestion: recommendedQuestion?.text ?? "",
      recommendedSourceId: recommendedQuestion?.sourceId ?? "",
      recommendedStoryTitle: recommendedQuestion?.storyTitle ?? "",
      recommendedDimension: recommendedQuestion?.dimension ?? "",
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

  createRecordingProfile() {
    this.setData({ profileChooserOpen: false });
    wx.navigateTo({ url: "/pages/profiles/profiles?mode=new-book" });
  },

  async chooseProfile(event: {
    currentTarget: { dataset: { id: string } };
  }) {
    const memberId = event.currentTarget.dataset.id;
    const state = await loadRoomStateRemoteFirst();
    const member = state.members.find((item) => item.id === memberId && isRecordingProfile(item));

    if (!member) {
      wx.showToast({ title: "没有找到这个档案", icon: "none" });
      return;
    }

    saveCurrentMemberIdLocal(member.id);
    this.setData({ profileChooserOpen: false });
    await this.refresh(state);
    // Each profile has its own book; say whose book is open now.
    wx.showToast({ title: `现在是${member.name}的人生之书`, icon: "none" });
  },

  async deleteProfile(event: {
    currentTarget: { dataset: { id: string } };
  }) {
    try {
      const state = await loadRoomStateRemoteFirst();
      const member = state.members.find((item) => item.id === event.currentTarget.dataset.id && isRecordingProfile(item));
      if (!member) {
        wx.showToast({ title: "没有找到这个档案", icon: "none" });
        return;
      }
      const next = await deleteMemberWithConfirm(member, state);
      if (next) await this.refresh(next);
    } catch {
      wx.showToast({ title: "数据加载失败，请重试", icon: "none" });
    }
  },

  openMyHome() {
    wx.navigateTo({ url: "/pages/me/me" });
  },

  openMemoryArchive() {
    if (this.data.bookOpening) return;
    this.setData({ bookOpening: true });
    setTimeout(() => {
      this.setData({ bookOpening: false });
      wx.navigateTo({ url: "/pages/book/book" });
    }, 620);
  },

  openArchiveTab(event: {
    currentTarget: { dataset: { tab: "note" | "memoir" } };
  }) {
    const tab = event.currentTarget.dataset.tab === "memoir" ? "memoir" : "note";
    wx.navigateTo({ url: tab === "memoir" ? "/pages/stories/stories" : "/pages/archive/archive" });
  },

  openPeople() {
    wx.navigateTo({ url: "/pages/profiles/profiles?mode=people" });
  },

  openMemoryHome() {
    wx.navigateTo({ url: "/pages/room/room" });
  },

  changeRecommendedQuestion() {
    this.recommendationOffset += 1;
    void this.refresh().catch(() => wx.showToast({ title: "数据加载失败，请重新打开本页重试", icon: "none" }));
  },

  continueRecommendedQuestion() {
    const sourceId = this.data.recommendedSourceId || "";
    if (!sourceId) {
      wx.showToast({ title: "还没有可追问的记忆", icon: "none" });
      return;
    }

    // 把用户点的这个问题一起带过去，采访页第一句就问它。
    wx.navigateTo({
      url: interviewUrl(sourceId, this.data.recommendedStoryTitle || "", {
        text: this.data.recommendedQuestion || "",
        dimension: this.data.recommendedDimension || "",
      }),
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
