import { storyCoverApi } from "../../services/storyCoverService";
import { renderBookCover } from "../../services/bookFrameColor";
import { bookCoverExists, cachedBookCover } from "../../services/bookCoverCache";
import {
  accountOwner,
  contributionRelatedMemberIds,
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
  pickInterviewQuestion,
  sharedQuestionSeed,
} from "../../domain/interview";
import {
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  saveCurrentMemberIdLocal,
} from "../../services/roomRepository";
import { ShelfStory, shelfStoryLabel, storyShelf } from "../../services/storyShelf";
import { bookmarkDateParts } from "../../services/memoryDates";
import { loadCurrentStoryId, loadCurrentStoryTitle, saveCurrentStoryId, saveCurrentStoryTitle } from "../../services/storySelection";
import { logLoadError } from "../../services/loadErrorLog";

interface RecentStoryView {
  id: string;
  title: string;
  excerpt: string;
  dateLabel: string;
  dateParts: string[];
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

interface BookSlideView {
  key: string;
  title: string;
  subtitle: string;
  storyTitle: string;
  storyKey: string;
  storyId: string;
  manuscriptMemberId: string;
  coverImageId: string;
  coverUrl: string;
  bookArtUrl?: string;
  memoryCount: number;
  chapterCount: number;
  peopleCount: number;
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
        dateParts: bookmarkDateParts(contribution.createdAt),
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

function peopleCountFor(memories: MemoryContribution[], activeMemberIds: Set<string>): number {
  const people = new Set<string>();
  memories.forEach((memory) => {
    contributionRelatedMemberIds(memory).forEach((memberId) => {
      if (activeMemberIds.has(memberId)) people.add(memberId);
    });
  });
  return people.size;
}

function bookSlidesFor(input: {
  shelf: ShelfStory[];
  pool: MemoryContribution[];
  currentTitle: string;
  activeMemberIds: Set<string>;
  stories: FamilyRoomState["stories"];
  looseMemories: MemoryContribution[];
}): BookSlideView[] {
  const memoriesById = new Map(input.pool.map((memory) => [memory.id, memory]));
  const storyRecords = new Map((input.stories ?? []).filter((story) => !story.deletedAt).map((story) => [story.id, story]));
  const slides = input.shelf.map((story): BookSlideView => {
    const memories = story.memoryIds.map((id) => memoriesById.get(id)).filter((memory): memory is MemoryContribution => Boolean(memory));
    const coverStory = story.storyId ? storyRecords.get(story.storyId) : undefined;
    return {
      key: story.key,
      title: story.bookTitle || story.title,
      subtitle: story.chapterCount ? `已整理 ${story.chapterCount} 章` : (story.memoryIds.length ? "还没整理成章节" : "还没开始聊"),
      storyTitle: story.title,
      storyKey: story.key,
      storyId: story.storyId ?? "",
      manuscriptMemberId: story.manuscriptMemberId ?? "",
      coverImageId: coverStory?.coverImageId ?? "",
      coverUrl: "",
      memoryCount: story.memoryIds.length,
      chapterCount: story.chapterCount,
      peopleCount: peopleCountFor(memories, input.activeMemberIds),
    };
  });

  if (input.currentTitle && !slides.some((slide) => slide.storyTitle === input.currentTitle)) {
    slides.unshift({
      key: `new:${input.currentTitle}`,
      title: input.currentTitle,
      subtitle: "还没开始聊",
      storyTitle: input.currentTitle,
      storyKey: "",
      storyId: "",
      manuscriptMemberId: "",
      coverImageId: "",
      coverUrl: "",
      memoryCount: 0,
      chapterCount: 0,
      peopleCount: 0,
    });
  }

  if (!slides.length || !input.currentTitle) {
    slides.unshift({
      key: "loose",
      title: "先随便聊聊",
      subtitle: input.looseMemories.length ? "还没放进故事的记忆" : "先说一句，聊完再放进故事",
      storyTitle: "",
      storyKey: "",
      storyId: "",
      manuscriptMemberId: "",
      coverImageId: "",
      coverUrl: "",
      memoryCount: input.looseMemories.length,
      chapterCount: 0,
      peopleCount: peopleCountFor(input.looseMemories, input.activeMemberIds),
    });
  }

  return slides;
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

/** 当天的共用题目；点「换一个问题」时换种子，挑一道和上一题不同的。 */
function dailyQuestionFor(offset: number): string {
  const seed = sharedQuestionSeed();
  return pickInterviewQuestion(offset ? `${seed}#${offset}` : seed, "personal").text;
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
  coverRefreshId: 0,
  roomSnapshot: undefined as FamilyRoomState | undefined,
  coverRequests: {} as Record<string, boolean>,

  data: {
    hasProfile: false,
    ownerAvatarText: "",
    // 书封就是正在聊的那个故事；所有故事的目录在底部的「人生之书」。
    coverTitle: "",
    coverUrl: "",
    coverImageId: "",
    coverSubtitle: "",
    storyKey: "",
    storyId: "",
    storyMemoryCount: 0,
    storyChapterCount: 0,
    storyPeopleCount: 0,
    storyManuscriptMemberId: "",
    bookOpening: false,
    activeBookIndex: 0,
    bookSlides: [] as BookSlideView[],
    storyChooserOpen: false,
    storyOptions: [] as StoryOptionView[],
    currentStoryTitle: "",
    currentStoryLabel: "",
    dailyQuestion: "",
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
    void this.refresh().catch((error) => { logLoadError("index", error); wx.showToast({ title: "数据加载失败，请重新打开本页重试", icon: "none" }); });
  },

  async refresh(state?: FamilyRoomState) {
    const coverRefreshId = ++this.coverRefreshId;
    const currentState = state ?? await loadRoomStateRemoteFirst();
    const current = await loadCurrentMemberRemoteFirst(currentState);
    const owner = accountOwner(currentState.members) ?? (current.id ? current : undefined);
    const pool = memoryPool(currentState.contributions);
    const shelf = storyShelf(currentState);
    const deletedStoryTitles = new Set((currentState.deletedStories ?? []).map((story) => story.title));
    const visiblePool = pool.filter((memory) => {
      const title = contributionStoryTitle(memory);
      return !title || !deletedStoryTitles.has(title);
    });
    const stored = loadCurrentStoryTitle();
    const storedId = loadCurrentStoryId();
    const latest = latestContribution(visiblePool);
    const storedStory = currentState.storyMigration?.status === "active" ? shelf.find(story => story.key === storedId) : undefined;
    const currentStoryTitle = storedStory?.title ?? (stored === "" || (stored && !deletedStoryTitles.has(stored))
      ? stored
      : (latest ? contributionStoryTitle(latest) : ""));
    // 「先随便聊聊」只接着还没放进故事的片段问，免得标题写着随便聊，问的却是别的故事。
    const inCurrentStory = storedStory
      ? pool.filter(memory => storedStory.memoryIds.includes(memory.id))
      : pool.filter((memory) => contributionStoryTitle(memory) === currentStoryTitle);
    const recommendedQuestion = recommendedQuestionFor(
      latestContribution(inCurrentStory),
      this.recommendationOffset,
    );
    const recentStories = recentStoriesFor(visiblePool);
    const currentStory = shelf.find((story) => story.title === currentStoryTitle);
    // 这个故事里出现的人：只算名单上还在的人。
    const activeMemberIds = new Set(
      currentState.members.filter(isActiveMember).map((member) => member.id),
    );
    const bookSlides = bookSlidesFor({
      shelf,
      pool,
      currentTitle: currentStoryTitle,
      activeMemberIds,
      stories: currentState.stories,
      looseMemories: inCurrentStory,
    });
    const currentKey = currentStory?.key ?? (currentStoryTitle ? `new:${currentStoryTitle}` : "loose");
    const activeBookIndex = Math.max(0, bookSlides.findIndex((slide) => slide.key === currentKey));
    const activeBook = bookSlides[activeBookIndex] ?? bookSlides[0];

    if (coverRefreshId !== this.coverRefreshId) return;
    this.roomSnapshot = currentState;
    this.coverRequests = {};
    const previousSlides = new Map((this.data.bookSlides as BookSlideView[]).map(slide => [slide.key, slide]));
    bookSlides.forEach(slide => {
      const previous = previousSlides.get(slide.key);
      if (slide.coverImageId && previous?.coverImageId === slide.coverImageId) {
        slide.coverUrl = previous.coverUrl;
        slide.bookArtUrl = previous.bookArtUrl;
      }
      const cached = slide.storyId && slide.coverImageId
        ? cachedBookCover(`${slide.storyId}:${slide.coverImageId}`) : '';
      if (cached) { slide.bookArtUrl = cached; slide.coverUrl = cached; }
    });
    const coverStory = (currentState.stories || []).find(story => story.id === activeBook?.storyId && !story.deletedAt);
    this.setData({
      coverUrl: activeBook?.coverUrl || "", coverImageId: coverStory?.coverImageId || "",
      hasProfile: Boolean(owner),
      ownerAvatarText: owner?.avatarText ?? "",
      coverTitle: activeBook?.title || "先随便聊聊",
      coverSubtitle: activeBook?.subtitle || "先说一句，聊完再放进故事",
      storyKey: activeBook?.storyKey ?? "",
      storyId: activeBook?.storyId ?? "",
      storyMemoryCount: activeBook?.memoryCount ?? inCurrentStory.length,
      storyChapterCount: activeBook?.chapterCount ?? 0,
      storyPeopleCount: activeBook?.peopleCount ?? 0,
      storyManuscriptMemberId: activeBook?.manuscriptMemberId ?? "",
      activeBookIndex,
      bookSlides,
      storyOptions: storyOptionsFor(shelf, currentStoryTitle),
      currentStoryTitle,
      currentStoryLabel: activeBook?.storyTitle || "先随便聊聊",
      // 这个故事还没有记忆可接着问时，用当天的共用题目；聊天页开场用同一个种子，问的是同一题。
      dailyQuestion: dailyQuestionFor(this.recommendationOffset),
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

    this.preloadBookCovers(activeBookIndex);
    // 称呼由用户在“我的”中主动修改，首页浏览不要求完善账号资料。
  },

  preloadBookCovers(index: number) {
    const slides = this.data.bookSlides as BookSlideView[];
    if (!slides.length) return;
    for (const offset of [0, -1, 1]) {
      const slideIndex = (index + offset + slides.length) % slides.length;
      const slide = slides[slideIndex];
      if (!slide?.storyId || !slide.coverImageId) continue;
      if (slide.bookArtUrl && bookCoverExists(slide.bookArtUrl)) continue;
      const key = `${slide.storyId}:${slide.coverImageId}`;
      if (slide.bookArtUrl) {
        // A bounded cache or the OS may evict a previously displayed derivative.
        delete this.coverRequests[key];
        this.setData({ [`bookSlides[${slideIndex}].bookArtUrl`]: '',
          ...(slide.coverUrl === slide.bookArtUrl ? { [`bookSlides[${slideIndex}].coverUrl`]: '' } : {}) });
      }
      if (this.coverRequests[key]) continue;
      this.coverRequests[key] = true;
      this.resolveActiveBookCover(this.coverRefreshId, slide.storyId, slide.coverImageId);
    }
  },

  resolveActiveBookCover(coverRefreshId: number, storyId: string, coverImageId: string, attempt = 0) {
    if (coverRefreshId !== this.coverRefreshId) return;
    const cachedCover = (this.data.bookSlides as BookSlideView[]).find(slide =>
      slide.storyId === storyId && slide.coverImageId === coverImageId)?.coverUrl;
    void (cachedCover ? Promise.resolve(cachedCover) : storyCoverApi.resolveUrl(storyId, coverImageId)).then(url => {
      if (coverRefreshId !== this.coverRefreshId) return;
      if (!url && attempt < 2) {
        setTimeout(() => this.resolveActiveBookCover(coverRefreshId, storyId, coverImageId, attempt + 1), 700 * (attempt + 1));
        return;
      }
      if (!url) { delete this.coverRequests[`${storyId}:${coverImageId}`]; return; }
      const index = (this.data.bookSlides as BookSlideView[]).findIndex(slide =>
        slide.storyId === storyId && slide.coverImageId === coverImageId);
      if (index < 0) return;
      this.setData({
        [`bookSlides[${index}].coverUrl`]: url,
        ...(this.data.storyId === storyId ? { coverUrl: url } : {}),
      });
      void renderBookCover(this, url, `${storyId}:${coverImageId}`).then(bookArtUrl => {
        if (coverRefreshId !== this.coverRefreshId) return;
        this.setData({ [`bookSlides[${index}].bookArtUrl`]: bookArtUrl });
      }).catch(error => {
        if (coverRefreshId === this.coverRefreshId) delete this.coverRequests[`${storyId}:${coverImageId}`];
        logLoadError("index-book-frame", error);
      });
    }).catch(() => {
      if (coverRefreshId !== this.coverRefreshId) return;
      if (attempt >= 2) { delete this.coverRequests[`${storyId}:${coverImageId}`]; return; }
      setTimeout(() => this.resolveActiveBookCover(coverRefreshId, storyId, coverImageId, attempt + 1), 700 * (attempt + 1));
    });
  },

  async onBookSlideChange(event: { detail: { current: number; source?: string } }) {
    // Controlled-current updates are not another user swipe.
    if (event.detail.source === "") return;
    const index = event.detail.current;
    const slide = (this.data.bookSlides as BookSlideView[])[index];
    if (!slide || index === this.data.activeBookIndex) return;
    saveCurrentStoryTitle(slide.storyTitle);
    saveCurrentStoryId(slide.storyId || "");
    this.recommendationOffset = 0;
    const state = this.roomSnapshot;
    const pool = state ? memoryPool(state.contributions) : [];
    const selectedStory = state?.storyMigration?.status === "active"
      ? storyShelf(state).find(story => story.key === slide.key) : undefined;
    const memories = selectedStory ? pool.filter(memory => selectedStory.memoryIds.includes(memory.id))
      : pool.filter(memory => contributionStoryTitle(memory) === slide.storyTitle);
    const recommended = recommendedQuestionFor(latestContribution(memories), this.recommendationOffset);
    this.setData({
      activeBookIndex: index,
      storyChooserOpen: false,
      coverTitle: slide.title,
      coverSubtitle: slide.subtitle,
      coverUrl: slide.coverUrl,
      coverImageId: slide.coverImageId,
      storyKey: slide.storyKey,
      storyId: slide.storyId,
      storyMemoryCount: slide.memoryCount,
      storyChapterCount: slide.chapterCount,
      storyPeopleCount: slide.peopleCount,
      storyManuscriptMemberId: slide.manuscriptMemberId,
      currentStoryTitle: slide.storyTitle,
      currentStoryLabel: slide.storyTitle || "先随便聊聊",
      storyOptions: this.data.storyOptions.map(option => ({ ...option, selected: option.key === slide.key })),
      dailyQuestion: dailyQuestionFor(this.recommendationOffset),
      recommendedQuestionLabel: recommended?.label ?? "",
      recommendedQuestionContext: recommended?.context ?? "",
      recommendedQuestion: recommended?.text ?? "",
      recommendedSourceId: recommended?.sourceId ?? "",
      recommendedStoryTitle: recommended?.storyTitle ?? "",
      recommendedDimension: recommended?.dimension ?? "",
      hasRecommendedQuestion: Boolean(recommended),
    });
    this.preloadBookCovers(index);
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
    currentTarget: { dataset: { title: string; key?: string } };
  }) {
    saveCurrentStoryTitle(event.currentTarget.dataset.title || "");
    if (event.currentTarget.dataset.key?.startsWith("story-")) saveCurrentStoryId(event.currentTarget.dataset.key);
    this.recommendationOffset = 0;
    this.setData({ storyChooserOpen: false });
    await this.refresh(this.roomSnapshot);
  },

  async chooseNoStory() {
    saveCurrentStoryTitle("");
    saveCurrentStoryId("");
    this.recommendationOffset = 0;
    this.setData({ storyChooserOpen: false });
    await this.refresh(this.roomSnapshot);
  },

  startNewStory() {
    this.setData({ storyChooserOpen: false });
    wx.navigateTo({ url: "/pages/stories/stories?create=1" });
  },

  /** 当前故事还没有可以追问的记忆时，直接开始聊它。 */
  startCurrentStory() {
    const title = this.data.currentStoryTitle;
    const storyParam = this.data.storyId ? `storyId=${encodeURIComponent(this.data.storyId)}` : `storyTitle=${encodeURIComponent(title)}`;
    wx.navigateTo({
      // 把首页这道每日一问带过去，聊天页第一句就问它。
      url: title
        ? `/pages/interview/interview?${storyParam}&question=${encodeURIComponent(this.data.dailyQuestion)}`
        : `/pages/interview/interview?memoryType=memoir&question=${encodeURIComponent(this.data.dailyQuestion)}`,
    });
  },

  openMyHome() {
    wx.navigateTo({ url: "/pages/me/me" });
  },

  /** 书封就是正在聊的那个故事；还没选故事时，打开还没归类的记忆。 */
  storyUrl(): string {
    return this.data.storyKey
      ? `/pages/stories/stories?key=${encodeURIComponent(this.data.storyKey)}`
      : "/pages/archive/archive";
  },

  openMemoryArchive() {
    if (this.data.bookOpening) return;
    this.setData({ bookOpening: true });
    setTimeout(() => {
      this.setData({ bookOpening: false });
      wx.navigateTo({ url: this.storyUrl() });
    }, 620);
  },

  openStoryMemories() {
    wx.navigateTo({ url: this.storyUrl() });
  },

  /** 这个故事整理好的章节；还没整理过就先打开这个故事。 */
  openStoryChapters() {
    if (this.data.storyId) {
      saveCurrentStoryId(this.data.storyId);
      wx.navigateTo({ url: "/pages/book/book?storyId=" + encodeURIComponent(this.data.storyId) });
      return;
    }
    const memberId = this.data.storyManuscriptMemberId;
    if (!memberId) {
      wx.navigateTo({ url: this.storyUrl() });
      return;
    }
    saveCurrentMemberIdLocal(memberId);
    wx.navigateTo({ url: "/pages/book/book" });
  },

  /** 人都在记忆之家：先看人，再看和这个人有关的记忆。 */
  openPeople() {
    wx.navigateTo({ url: "/pages/room/room" });
  },

  openMemoryHome() {
    wx.navigateTo({ url: "/pages/room/room" });
  },

  changeRecommendedQuestion() {
    const previous = this.data.dailyQuestion;
    this.recommendationOffset += 1;
    // 题库不大，换种子可能又挑到同一题；这个故事还没有记忆可追问时，多换几次直到换出新题。
    for (let tries = 0; !this.data.hasRecommendedQuestion && tries < 12 && dailyQuestionFor(this.recommendationOffset) === previous; tries += 1) {
      this.recommendationOffset += 1;
    }
    void this.refresh(this.roomSnapshot).catch((error) => { logLoadError("index", error); wx.showToast({ title: "数据加载失败，请重新打开本页重试", icon: "none" }); });
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
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
