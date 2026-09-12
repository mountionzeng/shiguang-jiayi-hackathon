import {
  accountOwner,
  contributionStoryTitle,
  FamilyRoomState,
  isActiveMember,
  MemoryContribution,
  memoryPool,
} from "../../domain/biography";
import {
  FOLLOW_UP_LABEL,
  InterviewDimension,
  nextInterviewPrompt,
} from "../../domain/interview";
import {
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
} from "../../services/roomRepository";
import { ShelfStory, shelfStoryLabel, storyShelf } from "../../services/storyShelf";

interface RecentStoryView {
  id: string;
  title: string;
  excerpt: string;
  dateLabel: string;
  countLabel: string;
  storyTitle: string;
}

interface StoryOptionView {
  key: string;
  title: string;
  label: string;
  avatarText: string;
  selected: boolean;
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

/** 首页正在聊的故事名，只存在本机：它只决定首页先显示哪个故事。 */
const CURRENT_STORY_KEY = "shiguang-current-story-v1";
const MAX_STORY_TITLE_LENGTH = 20;

/** "" 表示「先随便聊聊」；undefined 表示还没选过，按最近聊的那段来。 */
function loadCurrentStoryTitle(): string | undefined {
  try {
    const stored = wx.getStorageSync<{ title?: unknown }>(CURRENT_STORY_KEY);
    return stored && typeof stored.title === "string" ? stored.title : undefined;
  } catch {
    return undefined;
  }
}

function saveCurrentStoryTitle(title: string): void {
  try {
    wx.setStorageSync(CURRENT_STORY_KEY, { title });
  } catch {
    // 存不下只影响下次首页先显示哪个故事。
  }
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

/** 「换一个故事聊」的列表；刚起好名字、还没聊出记忆的故事也要能选回来。 */
function storyOptionsFor(shelf: ShelfStory[], currentTitle: string): StoryOptionView[] {
  const options = shelf.map((story) => ({
    key: story.key,
    title: story.title,
    label: shelfStoryLabel(story),
    avatarText: Array.from(story.title)[0] ?? "故",
    selected: story.title === currentTitle,
  }));
  if (currentTitle && !options.some((option) => option.selected)) {
    options.unshift({
      key: `new:${currentTitle}`,
      title: currentTitle,
      label: "还没开始聊",
      avatarText: Array.from(currentTitle)[0] ?? "故",
      selected: true,
    });
  }
  return options;
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

/**
 * 首页围绕「故事」：人生之书是你所有的故事，顶部换的是正在聊的故事，
 * 左上角头像只代表本账号的主人。人（家人和朋友）在记忆之家管理。
 */
Page({
  recommendationOffset: 0,

  data: {
    hasProfile: false,
    ownerAvatarText: "",
    bookTitle: "人生之书",
    coverSubtitle: "",
    memoryCount: 0,
    storyCount: 0,
    peopleCount: 0,
    bookOpening: false,
    storyChooserOpen: false,
    storyOptions: [] as StoryOptionView[],
    currentStoryTitle: "",
    currentStoryLabel: "",
    startPrompt: "",
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
    const current = await loadCurrentMemberRemoteFirst(currentState);
    const owner = accountOwner(currentState.members) ?? (current.id ? current : undefined);
    const pool = memoryPool(currentState.contributions);
    const shelf = storyShelf(currentState);
    const stored = loadCurrentStoryTitle();
    const latest = latestContribution(pool);
    const currentStoryTitle = stored ?? (latest ? contributionStoryTitle(latest) : "");
    // 「先随便聊聊」只接着还没放进故事的片段问，免得标题写着随便聊，问的却是别的故事。
    const inCurrentStory = pool.filter(
      (memory) => contributionStoryTitle(memory) === currentStoryTitle,
    );
    const recommendedQuestion = recommendedQuestionFor(
      latestContribution(inCurrentStory),
      this.recommendationOffset,
    );
    const recentStories = recentStoriesFor(pool);

    this.setData({
      hasProfile: Boolean(owner),
      ownerAvatarText: owner?.avatarText ?? "",
      bookTitle: "人生之书",
      coverSubtitle: shelf.length > 0 ? `${shelf.length} 个故事` : "还没有故事",
      memoryCount: pool.length,
      storyCount: shelf.length,
      peopleCount: currentState.members.filter(
        (member) => isActiveMember(member) && member.id !== owner?.id && member.relation !== "自己",
      ).length,
      storyOptions: storyOptionsFor(shelf, currentStoryTitle),
      currentStoryTitle,
      currentStoryLabel: currentStoryTitle || "先随便聊聊",
      startPrompt: currentStoryTitle
        ? `说说「${currentStoryTitle}」吧，从哪一段开始都行。`
        : "想到什么就说什么，聊完再决定放进哪个故事。",
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
    if (!this.data.hasProfile) {
      wx.showToast({ title: "先写下你的名字", icon: "none" });
      wx.navigateTo({ url: "/pages/profiles/profiles" });
      return;
    }
    wx.navigateTo({ url: "/pages/interview/interview" });
  },

  createFirstProfile() {
    wx.navigateTo({ url: "/pages/profiles/profiles" });
  },

  toggleStoryChooser() {
    this.setData({ storyChooserOpen: !this.data.storyChooserOpen });
  },

  async chooseStory(event: {
    currentTarget: { dataset: { title: string } };
  }) {
    saveCurrentStoryTitle(event.currentTarget.dataset.title || "");
    this.recommendationOffset = 0;
    this.setData({ storyChooserOpen: false });
    await this.refresh();
  },

  async chooseNoStory() {
    saveCurrentStoryTitle("");
    this.recommendationOffset = 0;
    this.setData({ storyChooserOpen: false });
    await this.refresh();
  },

  startNewStory() {
    wx.showModal({
      title: "开一个新故事",
      editable: true,
      placeholderText: "起个名字，比如：我的大学四年",
      confirmText: "开始聊",
      success: (result) => {
        if (!result.confirm) return;
        const title = (result.content ?? "").trim().replace(/\s+/g, " ");
        if (!title) {
          wx.showToast({ title: "先给故事起个名字", icon: "none" });
          return;
        }
        if (title.length > MAX_STORY_TITLE_LENGTH) {
          wx.showToast({ title: `故事名最多 ${MAX_STORY_TITLE_LENGTH} 个字`, icon: "none" });
          return;
        }
        saveCurrentStoryTitle(title);
        this.setData({ storyChooserOpen: false });
        wx.navigateTo({ url: `/pages/interview/interview?storyTitle=${encodeURIComponent(title)}` });
      },
    });
  },

  /** 当前故事还没有可以追问的记忆时，直接开始聊它。 */
  startCurrentStory() {
    const title = this.data.currentStoryTitle;
    wx.navigateTo({
      url: title
        ? `/pages/interview/interview?storyTitle=${encodeURIComponent(title)}`
        : "/pages/interview/interview?memoryType=note",
    });
  },

  openMyHome() {
    wx.navigateTo({ url: "/pages/me/me" });
  },

  /** 书封就是人生之书：你所有的故事。 */
  openMemoryArchive() {
    if (this.data.bookOpening) return;
    this.setData({ bookOpening: true });
    setTimeout(() => {
      this.setData({ bookOpening: false });
      wx.navigateTo({ url: "/pages/stories/stories" });
    }, 620);
  },

  openArchiveTab(event: {
    currentTarget: { dataset: { tab: "note" | "memoir" } };
  }) {
    const tab = event.currentTarget.dataset.tab === "memoir" ? "memoir" : "note";
    wx.navigateTo({ url: tab === "memoir" ? "/pages/stories/stories" : "/pages/archive/archive" });
  },

  /** 人都在记忆之家：先看人，再看和这个人有关的记忆。 */
  openPeople() {
    wx.navigateTo({ url: "/pages/room/room" });
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
    // 接着聊哪个故事，首页回来时就停在哪个故事。
    saveCurrentStoryTitle(storyTitle);
    wx.navigateTo({ url: interviewUrl(sourceId, storyTitle) });
  },
});
