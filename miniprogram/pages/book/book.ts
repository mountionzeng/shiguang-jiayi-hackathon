import {
  accountOwner, BiographyDraft, buildLocalChapterDraft, contributionStoryTitle, createContribution, isActiveMember, isRecordingProfile, ManuscriptChapter, ManuscriptContent, ManuscriptRevision, MemoryContribution, Story,
  memoryPool, personalBookSourceFingerprint,
} from "../../domain/biography";
import { BiographyFallbackReason, generateBiographyWithStatus } from "../../services/biographyService";
import { appendContributionRemoteFirst, loadCurrentMemberRemoteFirst, loadRoomStateRemoteFirst, roomDataModeLabel, usesCloudStorage } from "../../services/roomRepository";
import { currentManuscript, makeRevision, manuscriptHistory, saveManuscriptRevision } from "../../services/manuscript";
import {
  contentFromDelta, contentToDelta, isStoryImageId, isStoryImageReference, readLocalPhoto, saveLocalPhoto,
  storyImageReferenceId, validateContent,
} from "../../services/bookImages";
import { StoryImage, storyImageApi } from "../../services/storyImageService";
import { shelfStoryLabel, storyShelf } from "../../services/storyShelf";
import {
  addChapter, applyOrganized, assignMemory, chapterAiLabel, chapterLabel, chaptersOf, draftWithChapters, moveChapter, placeMemoryInChapter, removeChapter, unassignedMemoryIds, updateChapter,
} from "../../services/chapters";
import { logLoadError } from "../../services/loadErrorLog";
import { activeStory, storyAiContext, storySourceFingerprint, updateStoryBook } from "../../services/storyBooks";
import { loadCurrentStoryId, saveCurrentStoryId } from "../../services/storySelection";
import { audioCreatePath } from "../../services/storyAudioService";
import { storySharing } from "../../services/storySharing";
import { copyRequestId, storyCopies } from "../../services/storyCopies";

const FALLBACK_REASONS: Record<BiographyFallbackReason, string> = {
  "cloud-disabled": "这个版本关闭了在线 AI",
  "cloud-not-ready": "微信云开发还没连上",
  "consent-declined": "本次打开小程序时选了「暂不使用」在线 AI，重新打开小程序会再询问",
  "ai-not-configured": "整理书稿的云函数还没配置模型",
  "function-missing": "整理书稿的云函数还没部署",
  timeout: "在线 AI 响应超时",
  "cloud-failed": "在线 AI 暂时出错",
  malformed: "在线 AI 返回的内容不完整",
};

type MemoryRow = { id: string; text: string; title: string; excerpt: string; dateLabel: string; createdAt: string };
const imageCount = (content: ManuscriptContent[]) => content.filter(item => item.photoId).length;
const plainText = (content: ManuscriptContent[]) => content.map(item => item.text ?? "").join("");
const memoryDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}月${date.getDate()}日`;
};
const memoryRow = (memory: MemoryContribution): MemoryRow => ({
  id: memory.id,
  text: (memory.title ? memory.title + "：" : "") + memory.text.slice(0, 60),
  title: memory.title?.trim() || memory.text.slice(0, 16),
  excerpt: memory.text.slice(0, 60),
  dateLabel: memoryDate(memory.createdAt),
  createdAt: memory.createdAt,
});

Page({
  data: {
    organizeBooks: [] as Array<{ id: string; title: string; memberId: string; detail: string; memoryIds: string[] }>, organizeBookKey: "", previewText: "", previewTitle: "", previewAiLabel: "",
    protagonistName: "", memberId: "", storyId: "", savedRevisionId: "", writingMode: "objective" as "objective" | "creative", sources: [] as Array<{ id: string; text: string; byline: string }>,
    sourceCount: 0, draft: null as BiographyDraft | null,
    generating: false, saving: false, isCloudDraft: false, modeLabel: "", modeNote: "",
    stale: false, showSources: false, editing: false, editTitle: "", editBody: "",
    history: [] as ManuscriptRevision[], showHistory: false,
    previewVersion: null as ManuscriptRevision | null,
    loadError: "", storageLabel: "", versionName: "", saveNotice: "",
    keyboardHeight: 0, viewportHeight: 0, panel: "", moreOpen: false, editorKeys: [0], pickingPhoto: false, editorReady: false,
    storyImageSelected: false, refreshingStoryImage: false,
    previewBlocks: [] as Array<{ text?: string; path?: string }>,
    // "contents" lists the chapters; "chapter" edits one of them. Empty until the first load.
    view: "" as "" | "contents" | "chapter",
    chapterRows: [] as Array<{ id: string; label: string; title: string; memoryCount: number; photoCount: number }>,
    chapterLabelText: "", chapterAiLabelText: "", editChapterTitle: "",
    unassigned: [] as MemoryRow[], chapterMemories: [] as MemoryRow[],
    storyOptions: [] as Array<{ title: string; count: number }>, assignMemoryId: "",
    // AI organizing: choose memories, choose a chapter, write it in directly; undo restores the version before.
    organizeRows: [] as Array<{ id: string; text: string; where: string; checked: boolean }>, organizeTarget: "", canUndo: false,
    // The active chapter's backdrop picture, when it has one and the cloud can serve it.
    backdropUrl: "",
    shareText: "", shareRecipientIds: [] as string[], sharingExcerpt: false,
    shareRecipients: [] as Array<{ id: string; name: string; relation: string; checked: boolean }>,
    protectedCopy: false, appendOwnText: "", appendingOwn: false, returningOwn: false,
  },
  // Native inputs own their live value/cursor. Do not echo the document on each keystroke.
  titleBuffer: "",
  chapterTitleBuffer: "",
  bodyBuffer: "",
  contentBuffer: [] as ManuscriptContent[],
  chapters: [] as ManuscriptChapter[],
  activeChapterId: "",
  excerptRequestId: "",
  appendOwnRequestId: "",
  returnOwnRequestId: "",
  memories: [] as MemoryContribution[],
  photoPaths: {} as Record<string, string>,
  imageIds: {} as Record<string, string>,
  backdropUrls: {} as Record<string, string>,
  editorContext: undefined as WechatMiniprogram.EditorContext | undefined,
  editorLoading: false,
  collecting: false,
  unloaded: false,
  fullWindowHeight: 0,
  windowWidth: 0,
  refreshId: 0,
  keyboardListener: undefined as ((event: { height: number }) => void) | undefined,
  revisionId: "",
  sourceFingerprint: "",
  story: undefined as Story | undefined,
  pendingSave: undefined as ManuscriptRevision | undefined,
  organizeSelection: [] as string[],
  undoState: undefined as { draft: BiographyDraft; fingerprint: string } | undefined,
  pendingStoryImage: undefined as { imageId: string; chapterId: string; url: string } | undefined,

  openOrganizeOnLoad: false,
  requestedMemberId: "",
  requestedStoryKey: "",
  requestedStoryTitle: "",
  requestedMemoryIds: [] as string[],
  storyScopeMemoryIds: undefined as Set<string> | undefined,
  organizeCandidate: undefined as { draft: BiographyDraft; fingerprint: string; chapterId: string; label: string; notice: string; revisionId: string } | undefined,
  onLoad(options: { storyId?: string; memberId?: string; chapterId?: string; memoryIds?: string } = {}) {
    this.openOrganizeOnLoad = options.memoryIds !== undefined;
    this.requestedMemberId = options.memberId || "";
    this.requestedStoryKey = options.storyId || loadCurrentStoryId();
    this.requestedMemoryIds = (options.memoryIds || "").split(",").filter(Boolean);
    if (options.chapterId) { this.activeChapterId = options.chapterId; this.setData({ view: "chapter" }); }
    this.unloaded = false;
    const window = wx.getWindowInfo();
    this.fullWindowHeight = window.windowHeight;
    this.windowWidth = window.windowWidth;
    this.setData({ viewportHeight: window.windowHeight });
    this.keyboardListener = event => this.onKeyboardHeight({ detail: event });
    wx.onKeyboardHeightChange(this.keyboardListener);
  },
  onResize(event: { size: { windowHeight: number; windowWidth: number } }) {
    const size = event.size;
    // Keyboard resize events may arrive before the height event. Never adopt the
    // shrunken same-width viewport as the next baseline, or subtract the IME twice.
    if (size.windowWidth !== this.windowWidth || size.windowHeight > this.fullWindowHeight) {
      this.windowWidth = size.windowWidth;
      this.fullWindowHeight = size.windowHeight + this.data.keyboardHeight;
      this.updateViewport();
    }
  },
  updateViewport() {
    if (!this.fullWindowHeight) return;
    const viewportHeight = Math.max(180, this.fullWindowHeight - this.data.keyboardHeight);
    if (viewportHeight !== this.data.viewportHeight) this.setData({ viewportHeight });
  },
  onUnload() {
    this.unloaded = true;
    if (this.keyboardListener) wx.offKeyboardHeightChange(this.keyboardListener);
    this.editorContext = undefined;
  },
  onShow() {
    if (this.pendingStoryImage) {
      this.setData({ storyImageSelected: true, refreshingStoryImage: true, saveNotice: "插图已选好。请点正文中的位置，再点顶部「插入插图」。" });
      void this.refreshSelectedStoryImageUrl();
      return;
    }
    if (!this.organizeCandidate && !this.data.editing && !this.data.generating && !this.data.saving && !this.data.pickingPhoto) {
      void this.refresh().catch((error) => { logLoadError("book", error); this.setData({ loadError: "书稿暂时加载失败，请重试。已有内容不会被清空。" }); });
    }
  },
  async refresh(nextState?: Awaited<ReturnType<typeof loadRoomStateRemoteFirst>>) {
    const refreshId = ++this.refreshId;
    const storyId = this.requestedStoryKey || loadCurrentStoryId();
    const state = nextState ?? await loadRoomStateRemoteFirst();
    if (storyId.startsWith("story-") && !(state.stories ?? []).some(item => item.id === storyId && !item.deletedAt)) {
      throw new Error("这本故事书已不可用，请返回书架");
    }
    const story = storyId && (state.stories ?? []).some(item => item.id === storyId)
      ? activeStory(state, storyId)
      : undefined;
    if (story) saveCurrentStoryId(story.id);
    const member = (story?.legacy?.memberId
      ? state.members.find(item => item.id === story.legacy!.memberId && isRecordingProfile(item))
      : this.requestedMemberId ? state.members.find(item => item.id === this.requestedMemberId && isRecordingProfile(item)) : undefined)
      ?? accountOwner(state.members) ?? await loadCurrentMemberRemoteFirst(state);
    if (!member) throw new Error("这本书已不可用，请重新选择");
    const shelf = storyShelf(state);
    const selectedStory = shelf.find(item => item.key === (story?.id || this.requestedStoryKey));
    this.storyScopeMemoryIds = story
      ? new Set(story.memoryIds)
      : selectedStory?.key.startsWith("story:") ? new Set(selectedStory.memoryIds) : undefined;
    const deletedStoryTitles = new Set((state.deletedStories ?? []).map(item => item.title));
    const qualified = memoryPool(state.contributions)
      .filter(memory => !deletedStoryTitles.has(contributionStoryTitle(memory)))
      .filter(memory => !this.storyScopeMemoryIds || this.storyScopeMemoryIds.has(memory.id));
    const bookId = story?.id || member.id;
    const current = currentManuscript(state, bookId);
    if ((this.data.editing && !this.data.saving) || this.data.pickingPhoto || this.unloaded) return;
    const chapters = current.draft ? chaptersOf(current.draft, current.sourceFingerprint) : [];
    const photoPaths: Record<string, string> = {};
    const imageIds: Record<string, string> = {};
    for (const item of chapters.flatMap(chapter => chapter.content)) {
      if (item.photoId) {
        if (isStoryImageReference(item.photoId)) continue;
        const path = await readLocalPhoto(item.photoId);
        if (path) { photoPaths[item.photoId] = path; imageIds[path] = item.photoId; }
      }
    }
    const storyImageReferences = new Set(chapters.flatMap(chapter => chapter.content)
      .flatMap(item => item.photoId && isStoryImageReference(item.photoId) ? [item.photoId] : []));
    const backdropImageIds = new Set(chapters.flatMap(chapter => chapter.backdropImageId ? [chapter.backdropImageId] : []));
    let cloudImages: StoryImage[] = [];
    if (storyImageReferences.size || backdropImageIds.size) {
      try {
        const list = await storyImageApi.listStoryImages(bookId);
        cloudImages = list.images;
      } catch {
        // Keep an opaque recoverable marker in the editor when a temporary URL is unavailable.
      }
    }
    cloudImages.forEach(image => {
      const referenceId = storyImageReferenceId(image.imageId);
      if (storyImageReferences.has(referenceId) && image.url) {
        photoPaths[referenceId] = image.url;
        imageIds[image.url] = referenceId;
      }
    });
    const backdropUrls = Object.fromEntries(cloudImages
      .filter(image => backdropImageIds.has(image.imageId) && image.url)
      .map(image => [image.imageId, image.url]));
    if (this.unloaded || refreshId !== this.refreshId || (this.data.editing && !this.data.saving) || this.data.pickingPhoto) return;
    const visibleChapters = this.visibleChapters(chapters);
    let view = this.data.view;
    if (!visibleChapters.length) view = "contents";
    else if (!view) {
      // A single-chapter book (every older book) opens straight into its text, as before.
      view = visibleChapters.length === 1 ? "chapter" : "contents";
      if (visibleChapters.length === 1) this.activeChapterId = visibleChapters[0].id;
    }
    if (view === "chapter" && !visibleChapters.some(chapter => chapter.id === this.activeChapterId)) view = "contents";
    this.revisionId = current.revisionId;
    this.sourceFingerprint = current.sourceFingerprint;
    this.story = story;
    this.chapters = chapters;
    this.memories = qualified;
    this.titleBuffer = current.draft?.title ?? "";
    this.photoPaths = photoPaths;
    this.imageIds = imageIds;
    this.backdropUrls = backdropUrls;
    this.loadActiveChapter();
    const organizeBooks = shelf.map(story => ({
      id: story.key,
      title: story.title,
      // A named memory story without a manuscript still belongs in the current
      // life book: choosing it creates (or reuses) a chapter in that book.
      memberId: this.story ? (story.storyId ?? story.key) : (story.manuscriptMemberId ?? member.id),
      detail: shelfStoryLabel(story) || "可整理为新章节",
      memoryIds: [...story.memoryIds],
    }));
    let organizeBookKey = shelf.some(story => story.key === this.requestedStoryKey)
      ? this.requestedStoryKey
      : shelf.find(story => story.manuscriptMemberId === member.id)?.key ?? "";
    if (!organizeBookKey) {
      organizeBookKey = `profile:${member.id}`;
      organizeBooks.unshift({
        id: organizeBookKey,
        title: current.draft?.title || member.name + "的人生之书",
        memberId: member.id,
        detail: "还没开始整理",
        memoryIds: [],
      });
    }
    this.setData({
      editTitle: this.titleBuffer, editBody: this.bodyBuffer, editChapterTitle: this.chapterTitleBuffer, view,
      organizeBooks, organizeBookKey,
      protagonistName: member.name, memberId: member.id, storyId: story?.id || "", savedRevisionId: current.revisionId || "", writingMode: story?.writingMode || "creative",
      sources: qualified.map(item => ({ id: item.id, text: item.text, byline: item.authorName + " · 讲述" })),
      sourceCount: qualified.length, draft: current.draft ?? null,
      protectedCopy: story?.sourcePolicyRequired === true,
      isCloudDraft: current.draft?.generationMode === "cloud-ai",
      modeLabel: story?.sourcePolicyRequired ? "亲友故事副本" : story ? (story.writingMode === "creative" ? "AI 共创" : "客观记录") : "当前书稿",
      modeNote: story?.sourcePolicyRequired ? "亲友原文保持不变；你可以在章节末尾补充自己的经历。" : story ? "模式只影响以后的整理，不会改写旧章节。" : "可以直接编辑。",
      stale: !!current.draft && current.sourceFingerprint !== (story ? storySourceFingerprint(state, story.id) : personalBookSourceFingerprint(state, member.id)),
      history: manuscriptHistory(state, bookId), storageLabel: roomDataModeLabel(), loadError: "",
      ...this.chapterData(),
    });
    this.seedEditor();
    if (this.openOrganizeOnLoad || this.requestedMemoryIds.length) {
      this.openOrganizeOnLoad = false;
      this.showOrganize();
      this.organizeSelection = this.requestedMemoryIds.filter(id => qualified.some(item => item.id === id));
      this.requestedMemoryIds = [];
      const matchingChapter = this.requestedStoryTitle
        ? this.chapters.find(chapter => chapter.title.trim() === this.requestedStoryTitle)
        : undefined;
      const requestedStoryHasManuscript = shelf.some(story =>
        story.key === this.requestedStoryKey && Boolean(story.manuscriptMemberId));
      this.requestedStoryTitle = "";
      this.setData({
        organizeTarget: matchingChapter?.id
          ?? (this.requestedStoryKey && !requestedStoryHasManuscript ? "new" : this.data.organizeTarget),
        organizeRows: this.data.organizeRows.map(row => ({ ...row, checked: this.organizeSelection.includes(row.id) })),
      });
    }
  },
  /** Point the editing buffers at the active chapter's saved text and name. */
  loadActiveChapter() {
    const active = this.chapters.find(chapter => chapter.id === this.activeChapterId);
    this.contentBuffer = active ? active.content.map(item => ({ ...item })) : [];
    this.chapterTitleBuffer = active?.title ?? "";
    this.bodyBuffer = plainText(this.contentBuffer).replace(/\n+$/, "");
  },
  /** Story selection narrows the view without removing other chapters from the saved manuscript. */
  visibleChapters(chapters?: ManuscriptChapter[]): ManuscriptChapter[] {
    const source = chapters ?? this.chapters;
    const scope = this.storyScopeMemoryIds;
    if (!scope) return source;
    return source.filter((chapter: ManuscriptChapter) => (
      chapter.title.trim() === this.requestedStoryTitle
      || chapter.memoryIds.some(memoryId => scope.has(memoryId))
    ));
  },
  chapterData() {
    const known = new Map(this.memories.map(memory => [memory.id, memory]));
    const visibleChapters = this.visibleChapters();
    const active = visibleChapters.find(chapter => chapter.id === this.activeChapterId);
    const stories = new Map<string, number>();
    this.memories.forEach(memory => {
      const title = contributionStoryTitle(memory);
      if (title) stories.set(title, (stories.get(title) ?? 0) + 1);
    });
    return {
      chapterRows: visibleChapters.map((chapter, index) => ({
        id: chapter.id, label: chapterLabel(index + 1), title: chapter.title,
        memoryCount: chapter.memoryIds.filter(id => known.has(id)).length, photoCount: imageCount(chapter.content),
      })),
      // 最近讲的记忆排在最前面。
      unassigned: unassignedMemoryIds(visibleChapters, this.memories.map(memory => memory.id)).map(id => memoryRow(known.get(id)!))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      chapterMemories: active ? active.memoryIds.flatMap(id => known.has(id) ? [memoryRow(known.get(id)!)] : []) : [],
      chapterLabelText: active ? chapterLabel(visibleChapters.indexOf(active) + 1) : "",
      chapterAiLabelText: active ? chapterAiLabel(active) : "",
      storyOptions: Array.from(stories, ([title, count]) => ({ title, count })),
      backdropUrl: this.activeBackdropUrl(),
    };
  },
  /** Chapter backdrops are cloud pictures; a book without them never calls the cloud. */
  async loadBackdrops(memberId: string, refreshId: number) {
    const wanted = new Set(this.chapters.map(chapter => chapter.backdropImageId).filter((id): id is string => Boolean(id)));
    if (!wanted.size) {
      this.backdropUrls = {};
      if (this.data.backdropUrl) this.setData({ backdropUrl: "" });
      return;
    }
    try {
      const list = await storyImageApi.listStoryImages(memberId);
      if (this.unloaded || refreshId !== this.refreshId) return;
      this.backdropUrls = Object.fromEntries(list.images
        .filter(image => wanted.has(image.imageId) && image.url)
        .map(image => [image.imageId, image.url]));
      this.setData({ backdropUrl: this.activeBackdropUrl() });
    } catch {
      // Without the cloud the chapter simply shows no backdrop; its text is unaffected.
    }
  },
  activeBackdropUrl() {
    const active = this.chapters.find(chapter => chapter.id === this.activeChapterId);
    return active?.backdropImageId ? this.backdropUrls[active.backdropImageId] ?? "" : "";
  },
  onEditorReady() {
    wx.createSelectorQuery().in(this).select("#manuscript-editor").context(result => {
      this.editorContext = result.context as WechatMiniprogram.EditorContext;
      this.seedEditor();
    }).exec();
  },
  seedEditor() {
    if (!this.editorContext || !this.data.draft) return;
    this.editorLoading = true;
    const delta = contentToDelta(this.contentBuffer, this.photoPaths);
    this.contentBuffer = contentFromDelta(delta, this.imageIds);
    this.editorContext.setContents({
      delta,
      success: () => { this.editorLoading = false; this.setData({ editorReady: true }); },
      fail: () => { this.editorLoading = false; this.setData({ editorReady: false, saveNotice: "图文编辑器加载失败，请重新打开书稿" }); },
    });
  },
  onEditorInput(event: { detail: { delta: unknown; text: string } }) {
    if (this.editorLoading || this.data.protectedCopy) return;
    try {
      const next = contentFromDelta(event.detail.delta, this.imageIds);
      if (JSON.stringify(next) === JSON.stringify(this.contentBuffer)) return;
      this.contentBuffer = next;
      this.bodyBuffer = this.contentBuffer.map(item => item.text ?? "").join("");
      this.editManuscript();
    } catch (error) {
      // Mark dirty even when pasted content is unsupported; do not silently save the old buffer.
      this.editManuscript();
      this.setData({ saveNotice: error instanceof Error ? error.message : "正文读取失败" });
    }
  },
  async collectEditor() {
    if (!this.editorContext) return;
    const result = await new Promise<WechatMiniprogram.GetContentsSuccessCallbackResult>((resolve, reject) =>
      this.editorContext!.getContents({ success: resolve, fail: reject }));
    this.contentBuffer = contentFromDelta(result.delta, this.imageIds);
    this.bodyBuffer = this.contentBuffer.map(item => item.text ?? "").join("");
  },
  async addPhoto() {
    if (this.data.protectedCopy || !this.data.draft || this.data.view !== "chapter" || this.data.panel || this.data.saving || this.data.generating || this.data.pickingPhoto) return;
    if (!this.editorContext || !this.data.editorReady) { wx.showToast({ title: "编辑器还没准备好，请稍候", icon: "none" }); return; }
    this.setData({ pickingPhoto: true, saveNotice: "" });
    try {
      await this.collectEditor();
      const otherPhotos = this.chapters.filter(chapter => chapter.id !== this.activeChapterId).reduce((total, chapter) => total + imageCount(chapter.content), 0);
      if (otherPhotos + imageCount(this.contentBuffer) >= 9) throw new Error("一本书稿最多放 9 张照片（含 AI 插图）");
      const picked = await new Promise<WechatMiniprogram.ChooseMediaSuccessCallbackResult>((resolve, reject) =>
        wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["compressed"], success: resolve, fail: reject }));
      if (this.unloaded) return;
      const file = picked.tempFiles[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) throw new Error("照片超过 10MB，请选小一些的照片");
      const photo = await saveLocalPhoto(file.tempFilePath);
      if (this.unloaded) return;
      this.photoPaths[photo.id] = photo.path;
      this.imageIds[photo.path] = photo.id;
      await new Promise<void>((resolve, reject) => this.editorContext!.insertImage({
        src: photo.path, alt: "本机照片", width: "100%", success: () => resolve(), fail: reject,
      }));
      await this.collectEditor();
      this.editManuscript();
      this.setData({ saveNotice: "照片已放进书稿，会自动存到云端；请点保存。" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String((error as { errMsg?: string })?.errMsg ?? "");
      if (!/cancel/i.test(message)) this.setData({ saveNotice: error instanceof Error ? error.message : "无法添加照片，请检查相册权限或本机存储空间后重试" });
    } finally { if (!this.unloaded) this.setData({ pickingPhoto: false }); }
  },
  /** Insert a generated illustration at the native editor's current caret. */
  async insertStoryImage(input: { imageId: string; chapterId: string; url: string }): Promise<boolean> {
    if (!this.data.draft || this.data.view !== "chapter" || input.chapterId !== this.activeChapterId) {
      wx.showToast({ title: "请回到对应章节再插入", icon: "none" });
      return false;
    }
    if (!isStoryImageId(input.imageId) || !/^https:\/\//.test(input.url)) {
      wx.showToast({ title: "这张插图暂时不可用", icon: "none" });
      return false;
    }
    if (!this.editorContext || !this.data.editorReady) {
      wx.showToast({ title: "编辑器还没准备好，请稍候", icon: "none" });
      return false;
    }
    try {
      await this.collectEditor();
      const referenceId = storyImageReferenceId(input.imageId);
      if (this.contentBuffer.some(item => item.photoId === referenceId)) throw new Error("这张插图已经在本章正文里了");
      const otherImages = this.chapters.filter(chapter => chapter.id !== this.activeChapterId)
        .reduce((total, chapter) => total + imageCount(chapter.content), 0);
      if (otherImages + imageCount(this.contentBuffer) >= 9) throw new Error("一本书稿最多放 9 张照片（含 AI 插图）");
      this.photoPaths[referenceId] = input.url;
      this.imageIds[input.url] = referenceId;
      await new Promise<void>((resolve, reject) => this.editorContext!.insertImage({
        src: input.url, alt: "AI 插图", width: "100%", success: () => resolve(), fail: reject,
      }));
      await this.collectEditor();
      this.editManuscript();
      this.setData({ saveNotice: "插图已放进正文，请点保存。" });
      return true;
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "插图没有放进去，请重试" });
      return false;
    }
  },
  /** Runs on touchstart so the native editor keeps the caret the user just chose. */
  async placeSelectedStoryImage() {
    const pending = this.pendingStoryImage;
    if (!pending || this.data.refreshingStoryImage || this.data.saving || this.data.generating || this.data.pickingPhoto) return;
    if (await this.insertStoryImage(pending)) {
      this.pendingStoryImage = undefined;
      this.setData({ storyImageSelected: false });
    } else {
      this.setData({ refreshingStoryImage: true });
      void this.refreshSelectedStoryImageUrl();
    }
  },
  async refreshSelectedStoryImageUrl() {
    const selected = this.pendingStoryImage;
    if (!selected) { this.setData({ refreshingStoryImage: false }); return; }
    try {
      const list = await storyImageApi.listStoryImages(this.data.memberId);
      const current = list.images.find(image => image.imageId === selected.imageId && image.url);
      if (current && this.pendingStoryImage?.imageId === selected.imageId) {
        this.pendingStoryImage = { ...selected, url: current.url };
      } else if (!current && this.pendingStoryImage?.imageId === selected.imageId) {
        this.pendingStoryImage = undefined;
        this.setData({ storyImageSelected: false, refreshingStoryImage: false, saveNotice: "这张插图已经不在了，请重新选择。" });
      }
    } catch {
      // The URL chosen moments ago is usually still valid; insertion itself will report if it is not.
    } finally {
      if (this.pendingStoryImage?.imageId === selected.imageId) this.setData({ refreshingStoryImage: false });
    }
  },
  retryLoad() { this.onShow(); },
  canLeaveEditor() {
    if (this.data.editing || this.data.saving || this.data.generating || this.data.pickingPhoto || this.data.appendingOwn || this.collecting) {
      wx.showToast({ title: this.data.editing ? "请先保存正文，或放弃修改" : "请稍等片刻", icon: "none" });
      return false;
    }
    return true;
  },
  onBack() {
    if (this.data.view === "chapter") this.backToContents();
    else this.goHome();
  },
  backToContents() {
    if (!this.canLeaveEditor()) return;
    this.setData({ view: "contents", moreOpen: false, panel: "" });
  },
  openChapter(event: { currentTarget: { dataset: { id: string } } }) {
    if (!this.canLeaveEditor()) return;
    const id = event.currentTarget.dataset.id;
    if (!this.chapters.some(chapter => chapter.id === id)) return;
    this.activeChapterId = id;
    this.loadActiveChapter();
    this.setData({ view: "chapter", panel: "", moreOpen: false, editChapterTitle: this.chapterTitleBuffer, ...this.chapterData() });
    this.seedEditor();
  },
  toggleSources() {
    if (this.canLeaveEditor()) this.setData({ panel: "sources", showSources: true });
  },
  toggleHistory() {
    if (this.canLeaveEditor()) this.setData({ panel: "history", showHistory: true, previewVersion: null });
  },
  closePanel() { if (this.data.generating || this.data.saving || this.data.appendingOwn) return; this.organizeCandidate = undefined; if (!this.data.saving) this.setData({ panel: "", showHistory: false, showSources: false, previewVersion: null, assignMemoryId: "" }); },
  showMore() {
    if (this.data.saving || this.data.generating || this.data.pickingPhoto) return;
    wx.hideKeyboard();
    this.setData({ moreOpen: !this.data.moreOpen });
  },
  selectTool(event: { currentTarget: { dataset: { action: string } } }) {
    if (this.data.saving || this.data.generating) return;
    this.setData({ moreOpen: false });
    const action = event.currentTarget.dataset.action;
    if (action === "discard") { this.cancelEdit(); return; }
    if (!this.canLeaveEditor()) return;
    switch (action) {
      case "history": this.toggleHistory(); break;
      case "version": this.setData({ panel: "version" }); break;
      case "generate": this.showOrganize(); break;
      case "sources": this.toggleSources(); break;
      case "record": this.startInterview(); break;
      case "new-chapter": this.setData({ panel: "new-chapter" }); break;
      case "memories": this.setData({ panel: "memories" }); break;
      case "up": void this.moveActiveChapter(-1); break;
      case "down": void this.moveActiveChapter(1); break;
      case "delete-chapter": void this.deleteActiveChapter(); break;
      case "images": this.openImages(); break;
      case "audio": this.openAudioStory(); break;
      case "invite": if(this.data.storyId)wx.navigateTo({url:'/packages/story-sharing/pages/invite/index?storyId='+encodeURIComponent(this.data.storyId)}); break;
      case "share-card": if(this.data.storyId)wx.navigateTo({url:'/packages/story-sharing/pages/card/index?storyId='+encodeURIComponent(this.data.storyId)}); break;
      case "mode": void this.switchWritingMode(); break;
    }
  },
  /** Read the native editor selection before the button press makes it lose focus. */
  openShareSelection() {
    if (!this.editorContext || !this.data.editorReady || this.data.saving || this.data.sharingExcerpt) return;
    this.editorContext.getSelectionText({
      success: result => {
        const text = String(result.text ?? "").trim();
        if (!text) {
          wx.showToast({ title: "请先在正文里选中一段文字", icon: "none" });
          return;
        }
        if (text.length > 500) {
          wx.showToast({ title: "一次最多发送 500 字，请少选一些", icon: "none" });
          return;
        }
        void this.prepareExcerptShare(text);
      },
      fail: () => wx.showToast({ title: "没有读到选中的文字，请重新选择", icon: "none" }),
    });
  },
  async prepareExcerptShare(text: string) {
    try {
      const state = await loadRoomStateRemoteFirst();
      const author = accountOwner(state.members);
      if (!author) throw new Error("请先创建自己的记录档案");
      const recipients = state.members.filter(member => isActiveMember(member) && member.id !== author.id);
      if (!recipients.length) {
        wx.showModal({
          title: "还没有可以发送的家人",
          content: "先在“家人和朋友”里添加并邀请对方。对方接受邀请后，才能在记忆之家看到选段。",
          confirmText: "去添加",
          success: result => { if (result.confirm) wx.navigateTo({ url: "/pages/profiles/profiles?mode=people" }); },
        });
        return;
      }
      this.setData({
        panel: "share-excerpt", moreOpen: false, shareText: text, shareRecipientIds: [],
        shareRecipients: recipients.map(member => ({ id: member.id, name: member.name, relation: member.relation, checked: false })),
      });
      this.excerptRequestId = "";
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "家人名单加载失败", icon: "none" });
    }
  },
  onShareRecipients(event: { detail: { value: string[] } }) {
    const selected = new Set(event.detail.value);
    this.setData({
      shareRecipientIds: [...selected],
      shareRecipients: this.data.shareRecipients.map(item => ({ ...item, checked: selected.has(item.id) })),
    });
  },
  async sendExcerpt() {
    if (this.data.sharingExcerpt) return;
    if (!this.data.shareRecipientIds.length) {
      wx.showToast({ title: "请选择要发送给谁", icon: "none" });
      return;
    }
    const names = this.data.shareRecipients.filter(item => this.data.shareRecipientIds.includes(item.id)).map(item => item.name);
    const confirmed = await this.confirm(
      `发送给${names.join("、")}？`,
      `“${this.data.shareText.slice(0, 80)}${this.data.shareText.length > 80 ? "…" : ""}”\n\n对方接受邀请后，可在记忆之家查看。`,
    );
    if (!confirmed) return;
    this.setData({ sharingExcerpt: true });
    try {
      const state = await loadRoomStateRemoteFirst();
      const author = accountOwner(state.members);
      if (!author) throw new Error("请先创建自己的记录档案");
      const active = this.chapters.find(chapter => chapter.id === this.activeChapterId);
      const titleParts = [this.data.editTitle.trim(), active?.title.trim()].filter(Boolean);
      if(state.storyMigration?.status==='active'){
        const story=state.stories?.find(item=>item.id===this.data.storyId&&!item.deletedAt);
        const version=story?.version;
        if(!story||!active||!story.currentRevisionId||!Number.isSafeInteger(version))throw new Error("请先保存当前书稿，再发送选段");
        if(!this.excerptRequestId)this.excerptRequestId='excerpt-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
        await storySharing.shareExcerpt({storyId:story.id,revisionId:story.currentRevisionId,expectedVersion:version as number,
          chapterId:active.id,text:this.data.shareText,recipientMemberIds:this.data.shareRecipientIds,requestId:this.excerptRequestId});
        this.excerptRequestId="";
        this.setData({panel:"",shareText:"",shareRecipientIds:[],saveNotice:`已发送给${names.join("、")}；尚未接受邀请的人会在加入后看到。`});
        return;
      }
      const excerpt = createContribution({
        authorMemberId: author.id,
        authorName: author.name,
        relation: author.relation,
        text: this.data.shareText,
        title: `${titleParts.length ? `《${titleParts.join("·")}》` : "人生之书"}摘录`,
        relatedMemberIds: this.data.shareRecipientIds,
        sharedWithMemberIds: this.data.shareRecipientIds,
        scope: "personal",
        visibility: "private",
      });
      const saved = await appendContributionRemoteFirst(excerpt);
      const stored = saved.contributions.find(item => item.id === excerpt.id);
      const delivered = new Set(stored?.sharedWithMemberIds ?? []);
      if (!this.data.shareRecipientIds.every(id => delivered.has(id))) {
        this.setData({ panel: "", shareText: "", shareRecipientIds: [], saveNotice: "内容安全检查未通过，选段已仅自己保存，没有发送给家人。" });
        return;
      }
      this.setData({ panel: "", shareText: "", shareRecipientIds: [], saveNotice: `已发送给${names.join("、")}；尚未接受邀请的人会在加入后看到。` });
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "发送失败，请重试" });
    } finally {
      this.setData({ sharingExcerpt: false });
    }
  },
  onKeyboardHeight(event: { detail: { height: number } }) {
    const keyboardHeight = Math.max(0, event.detail.height || 0);
    if (keyboardHeight !== this.data.keyboardHeight) this.setData({ keyboardHeight });
    this.updateViewport();
  },
  onVersionName(event: WechatMiniprogram.Input) { this.setData({ versionName: event.detail.value }); },
  editManuscript() {
    if (this.data.protectedCopy || !this.data.draft || this.data.saving || this.data.generating || this.data.editing) return;
    this.setData({ editing: true, saveNotice: "" });
    wx.enableAlertBeforeUnload({ message: "书稿修改尚未保存，请先保存修改。" });
  },
  onEditTitle(event: WechatMiniprogram.Input) { this.titleBuffer = event.detail.value; this.editManuscript(); },
  onEditChapterTitle(event: WechatMiniprogram.Input) { this.chapterTitleBuffer = event.detail.value; this.editManuscript(); },
  cancelEdit() {
    if (this.data.saving) return;
    wx.showModal({ title: "放弃未保存的修改？", content: "已保存的书稿和历史版本不会改变。", success: result => {
      if (result.confirm) {
        this.pendingSave = undefined;
        this.titleBuffer = this.data.draft?.title ?? "";
        this.loadActiveChapter();
        this.editorContext = undefined;
        // Explicit discard remounts native fields, even if the original bound value is unchanged.
        this.setData({
          editing: false, editTitle: this.titleBuffer, editBody: this.bodyBuffer, editChapterTitle: this.chapterTitleBuffer,
          editorKeys: [this.data.editorKeys[0] + 1], editorReady: false, saveNotice: "本次修改已放弃",
        });
        wx.disableAlertBeforeUnload();
        this.onShow();
      }
    } });
  },
  async persist(draft: BiographyDraft, fingerprint: string, kind: ManuscriptRevision["kind"], label: string) {
    if (this.data.protectedCopy) { this.setData({ saveNotice: "亲友原文不能整篇改写，请使用“补充我的经历”。" }); return false; }
    if (this.data.saving) return false;
    this.setData({ saving: true, saveNotice: "" });
    try {
      if (!this.pendingSave || JSON.stringify(this.pendingSave.draft) !== JSON.stringify(draft) || this.pendingSave.kind !== kind || this.pendingSave.label !== label) {
        const revision = makeRevision(this.data.memberId, draft, fingerprint, kind, label);
        revision.storyId = this.data.storyId;
        revision.expectedStoryVersion = this.story?.version;
        revision.sourceRevisionId = this.revisionId || undefined;
        this.pendingSave = revision;
      }
      const state = await saveManuscriptRevision(this.pendingSave, this.revisionId);
      this.pendingSave = undefined;
      await this.refresh(state);
      this.setData({ editing: false, canUndo: false, saveNotice: kind === "draft" ? "修改已保存" : "版本已保存，旧版仍然保留" });
      wx.disableAlertBeforeUnload();
      return true;
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "暂未确认保存，请重试；当前文字仍保留" });
      return false;
    } finally { this.setData({ saving: false }); }
  },
  /** Saves a structural change (new chapter, order, memory placement) as its own version. */
  async saveChapters(chapters: ManuscriptChapter[], label: string) {
    if (!this.canLeaveEditor()) return false;
    return this.persist(draftWithChapters(this.data.draft ?? this.newBookBase(), chapters), this.sourceFingerprint, "draft", label);
  },
  /** A first book gets a default title the user can change; never an AI chapter title. */
  newBookBase(): BiographyDraft {
    return {
      title: this.story?.bookTitle || this.story?.title || (this.data.protagonistName || "我") + "的人生之书", paragraphs: [], sourceCount: 0,
      generatedAt: new Date().toISOString(), generationMode: "local-demo",
    };
  },
  switchWritingMode() {
    const story = this.story;
    if (!story || !this.canLeaveEditor()) return;
    const next = story.writingMode === "creative" ? "objective" : "creative";
    wx.showModal({
      title: next === "creative" ? "切换为 AI 共创？" : "切换为客观记录？",
      content: "已有章节不会被改写，新模式只影响以后的访谈和整理。",
      success: async result => {
        if (!result.confirm) return;
        try {
          const state = await updateStoryBook(story, { writingMode: next });
          await this.refresh(state);
          this.setData({ saveNotice: next === "creative" ? "已切换为 AI 共创" : "已切换为客观记录" });
        } catch (error) { this.setData({ saveNotice: error instanceof Error ? error.message : "切换失败，请重试" }); }
      },
    });
  },
  confirm(title: string, content: string) {
    return new Promise<boolean>(resolve => wx.showModal({ title, content, success: result => resolve(result.confirm), fail: () => resolve(false) }));
  },
  async saveEdits() {
    if (this.data.protectedCopy) { this.setData({ saveNotice: "亲友原文不能整篇改写，请使用“补充我的经历”。" }); return; }
    if (!this.data.draft || this.data.saving || this.data.pickingPhoto || this.collecting) return;
    const inChapter = this.data.view === "chapter" && !!this.activeChapterId;
    this.collecting = true;
    try {
      if (inChapter) {
        await this.collectEditor();
        validateContent(this.contentBuffer);
      }
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "无法读取完整图文，请重试；尚未覆盖已保存内容" });
      return;
    } finally { this.collecting = false; }
    const title = this.titleBuffer.trim();
    if (!title) { this.setData({ saveNotice: "请填写书稿标题" }); return; }
    const chapters = inChapter
      ? updateChapter(this.chapters, this.activeChapterId, { title: this.chapterTitleBuffer, content: this.contentBuffer })
      : this.chapters;
    await this.persist(draftWithChapters({ ...this.data.draft, title }, chapters), this.sourceFingerprint, "draft", "编辑存档");
  },
  openAppendOwn() {
    if (!this.data.protectedCopy || this.data.view !== "chapter" || !this.activeChapterId) return;
    this.setData({ panel: "append-own", moreOpen: false, saveNotice: "" });
  },
  onAppendOwnText(event: WechatMiniprogram.Input) { this.setData({ appendOwnText: event.detail.value }); },
  async appendOwnExperience() {
    const text = this.data.appendOwnText.trim(), story = this.story;
    if (!this.data.protectedCopy || !story || !this.activeChapterId || this.data.appendingOwn) return;
    if (!text) { this.setData({ saveNotice: "请先写下想补充的经历" }); return; }
    if (!story.currentRevisionId || !Number.isSafeInteger(story.version)) { this.setData({ saveNotice: "故事版本信息不完整，请重新打开后再试" }); return; }
    if (!this.appendOwnRequestId) this.appendOwnRequestId = copyRequestId().replace(/^receive-/, "append-");
    this.setData({ appendingOwn: true, saveNotice: "" });
    try {
      await storyCopies.appendOwn({storyId:story.id,revisionId:story.currentRevisionId,expectedVersion:story.version as number,
        chapterId:this.activeChapterId,text,requestId:this.appendOwnRequestId});
      this.appendOwnRequestId = "";
      this.setData({ panel: "", appendOwnText: "", saveNotice: "你的经历已补充在本章末尾" });
      await this.refresh();
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "暂未确认保存，请重试；当前文字仍保留" });
    } finally { this.setData({ appendingOwn: false }); }
  },
  async returnOwnExperience() {
    const story=this.story;
    if(!this.data.protectedCopy || !story || !this.activeChapterId || this.data.returningOwn)return;
    if(!story.currentRevisionId || !Number.isSafeInteger(story.version)){this.setData({saveNotice:"故事版本信息不完整，请重新打开后再试"});return;}
    const confirmed=await this.confirm("把我的补充发回给原作者？","只发送你在本章新增的文字。亲友原文和图片不会重复发送；原作者可以选择收下或拒绝。");
    if(!confirmed)return;
    if(!this.returnOwnRequestId)this.returnOwnRequestId=copyRequestId().replace(/^receive-/,"return-");
    this.setData({returningOwn:true,saveNotice:""});
    try{
      await storyCopies.returnOwn({storyId:story.id,revisionId:story.currentRevisionId,expectedVersion:story.version as number,
        chapterId:this.activeChapterId,requestId:this.returnOwnRequestId});
      this.returnOwnRequestId="";this.setData({saveNotice:"你的补充已发回，等待原作者决定是否收进故事"});
      await this.refresh();
    }catch(error){this.setData({saveNotice:error instanceof Error?error.message:"暂未确认发送，请重试"});}
    finally{this.setData({returningOwn:false});}
  },
  async createChapter(event: { currentTarget: { dataset: { story?: string } } }) {
    const story = event.currentTarget.dataset.story || "";
    const memories = story ? this.memories.filter(memory => contributionStoryTitle(memory) === story) : [];
    const memoryIds = memories.map(memory => memory.id);
    let chapters: ManuscriptChapter[];
    try {
      chapters = addChapter(this.chapters, story);
      const chapterId = chapters[chapters.length - 1].id;
      for (const memory of memories) chapters = placeMemoryInChapter(chapters, memory, chapterId);
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "无法新开一章" });
      return;
    }
    const id = chapters[chapters.length - 1].id;
    const label = chapterLabel(chapters.length);
    if (await this.saveChapters(chapters, "新开" + label)) {
      this.openChapter({ currentTarget: { dataset: { id } } });
      this.setData({ saveNotice: "已新开" + label + (memoryIds.length ? "，已把 " + memoryIds.length + " 条记忆原文加入正文" : "") + "。" });
    }
  },
  chooseChapterFor(event: { currentTarget: { dataset: { id: string } } }) {
    if (this.canLeaveEditor()) this.setData({ panel: "assign", assignMemoryId: event.currentTarget.dataset.id });
  },
  async assignTo(event: { currentTarget: { dataset: { id: string } } }) {
    const memoryId = this.data.assignMemoryId;
    const target = event.currentTarget.dataset.id;
    if (!memoryId) return;
    const memory = this.memories.find(item => item.id === memoryId);
    if (!memory) { this.setData({ saveNotice: "这段记忆已经不存在，请重新打开书稿" }); return; }
    let chapters: ManuscriptChapter[];
    try {
      chapters = target === "new" ? addChapter(this.chapters) : this.chapters;
      const chapterId = target === "new" ? chapters[chapters.length - 1].id : target;
      chapters = placeMemoryInChapter(chapters, memory, chapterId);
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "无法调整章节" });
      return;
    }
    const index = target === "new" ? chapters.length - 1 : chapters.findIndex(chapter => chapter.id === target);
    if (await this.saveChapters(chapters, "调整章节")) {
      this.setData({ panel: "", assignMemoryId: "", saveNotice: "已放进" + chapterLabel(index + 1) + "，原文已加入正文。" });
    }
  },
  async addToChapter(event: { currentTarget: { dataset: { id: string } } }) {
    const memory = this.memories.find(item => item.id === event.currentTarget.dataset.id);
    if (!memory) { this.setData({ saveNotice: "这段记忆已经不存在，请重新打开书稿" }); return; }
    if (await this.saveChapters(placeMemoryInChapter(this.chapters, memory, this.activeChapterId), "调整章节")) {
      this.setData({ saveNotice: "原文已加入本章，可以继续编辑。" });
    }
  },
  async removeFromChapter(event: { currentTarget: { dataset: { id: string } } }) {
    await this.saveChapters(assignMemory(this.chapters, event.currentTarget.dataset.id, ""), "调整章节");
  },
  async moveActiveChapter(offset: number) {
    const chapters = moveChapter(this.chapters, this.activeChapterId, offset);
    if (JSON.stringify(chapters.map(chapter => chapter.id)) === JSON.stringify(this.chapters.map(chapter => chapter.id))) return;
    await this.saveChapters(chapters, "调整章节顺序");
  },
  deleteActiveChapter() {
    return new Promise<void>(resolve => {
      let chapters: ManuscriptChapter[];
      try { chapters = removeChapter(this.chapters, this.activeChapterId); } catch (error) {
        this.setData({ saveNotice: error instanceof Error ? error.message : "无法删除这一章" });
        resolve();
        return;
      }
      wx.showModal({
        title: "删掉" + this.data.chapterLabelText + "？",
        content: "会存成一个新版本。这一章在历史版本里还能找回，里面的记忆会回到「还没放进书稿」，原始记忆不会被删除。",
        success: async result => {
          if (result.confirm && await this.saveChapters(chapters, "删除" + this.data.chapterLabelText)) {
            this.setData({ view: "contents", saveNotice: "这一章已从新版本里拿掉，历史版本里还在。" });
          }
          resolve();
        },
        fail: () => resolve(),
      });
    });
  },
  async saveVersion() {
    if (!this.data.draft || this.data.editing) return;
    const name = this.data.versionName.trim() || "第 " + (this.data.history.filter(item => item.kind !== "draft").length + 1) + " 版";
    if (await this.persist(this.data.draft, this.sourceFingerprint, "version", name)) this.setData({ versionName: "", panel: "" });
  },
  async previewHistory(event: { currentTarget: { dataset: { id: string } } }) {
    const version = this.data.history.find(item => item.id === event.currentTarget.dataset.id);
    if (!version) return;
    this.setData({ previewVersion: version, previewBlocks: [] });
    const previewBlocks = await Promise.all((version.draft.content ?? version.draft.paragraphs.map(text => ({ text }))).map(async item => {
      if (typeof item.text === "string") return { text: item.text };
      if (item.photoId && isStoryImageReference(item.photoId)) {
        const path = this.photoPaths[item.photoId];
        return path ? { path } : { text: "〔AI 插图暂时无法读取〕" };
      }
      const path = await readLocalPhoto(item.photoId!);
      return path ? { path } : { text: "〔照片仅保存在原设备，本机不可用〕" };
    }));
    if (!this.unloaded && this.data.previewVersion?.id === version.id) this.setData({ previewBlocks });
  },
  restoreVersion() {
    const version = this.data.previewVersion;
    if (!version || !this.canLeaveEditor()) return;
    wx.showModal({ title: "恢复这一版？", content: "会另存为一个新版本，当前稿和其他历史都保留。", success: result => {
      if (result.confirm) void this.persist(version.draft, version.sourceFingerprint, "restore", "恢复：" + version.label);
    } });
  },
  /** AI organizing: step 1 choose memories, step 2 choose a chapter. Defaults follow where the user is. */
  showOrganize() {
    if (!this.memories.length) { this.setData({ saveNotice: "先记录一段经历，再请 AI 整理" }); return; }
    const visibleChapters = this.visibleChapters();
    const active = this.data.view === "chapter" ? visibleChapters.find(chapter => chapter.id === this.activeChapterId) : undefined;
    const known = new Set(this.memories.map(memory => memory.id));
    const inChapter = active?.memoryIds.filter(id => known.has(id)) ?? [];
    this.organizeSelection = inChapter.length ? inChapter : unassignedMemoryIds(this.chapters, [...known]);
    const where = new Map<string, string>();
    visibleChapters.forEach((chapter, index) => chapter.memoryIds.forEach(id => where.set(id, "在" + chapterLabel(index + 1))));
    this.setData({
      panel: "organize", organizeTarget: active ? active.id : "new",
      organizeRows: this.memories.map(memory => ({ ...memoryRow(memory), where: where.get(memory.id) ?? "还没放进", checked: this.organizeSelection.includes(memory.id) })),
    });
  },
  async onOrganizeBook(event: { detail: { value: string } }) {
    if (this.data.generating || this.data.saving) return;
    const selected = this.data.organizeBooks.find(item => item.id === event.detail.value);
    if (!selected) return;
    this.openOrganizeOnLoad = true;
    this.requestedStoryKey = selected.id;
    this.requestedStoryTitle = selected.title;
    this.requestedMemberId = selected.memberId;
    this.requestedMemoryIds = selected.memoryIds.length ? [...selected.memoryIds] : [...this.organizeSelection];
    this.organizeCandidate = undefined;
    try { await this.refresh(); } catch (error) { this.setData({ saveNotice: error instanceof Error ? error.message : "加载失败" }); }
  },
  onPreviewText(event: WechatMiniprogram.Input) {
    this.setData({
      previewText: event.detail.value,
      previewAiLabel: this.data.previewAiLabel ? "文字 AI 生成 · 已由你修改" : "",
    });
  },
  onPreviewTitle(event: WechatMiniprogram.Input) {
    this.setData({
      previewTitle: event.detail.value,
      previewAiLabel: this.data.previewAiLabel ? "文字 AI 生成 · 已由你修改" : "",
    });
  },
  onOrganizeMemories(event: { detail: { value: string[] } }) { this.organizeSelection = event.detail.value; },
  onOrganizeTarget(event: { detail: { value: string } }) { this.setData({ organizeTarget: event.detail.value }); },
  async runOrganize() {
    if (this.data.generating || this.data.saving || this.data.editing) return;
    const memoryIds = this.organizeSelection.filter(id => this.memories.some(memory => memory.id === id));
    if (!memoryIds.length) { this.setData({ saveNotice: "先勾选要整理的记忆" }); return; }
    const target = this.chapters.find(chapter => chapter.id === this.data.organizeTarget);
    if (target && plainText(target.content).length > 4000) { this.setData({ saveNotice: "这一章较长，请新开一章整理，避免遗漏已有正文" }); return; }
    if (target?.handEdited && plainText(target.content).trim() && !await this.confirm("这一章你亲手改过",
      "AI 会重写这一章的正文，照片保留。原来的文字在历史版本里能找回，整理完也可以马上撤回。继续吗？")) return;
    this.setData({ generating: true, saveNotice: "正在整理，请稍候…" });
    try {
      const state = await loadRoomStateRemoteFirst();
      const story = this.data.storyId ? activeStory(state, this.data.storyId) : undefined;
      const member = state.members.find(item => item.id === this.data.memberId && isRecordingProfile(item));
      if (!member) throw new Error("这本书已不可用");
      const fingerprint = story ? storySourceFingerprint(state, story.id) : personalBookSourceFingerprint(state, member.id);
      let aiState = state;
      let selectedMemories = memoryPool(state.contributions).filter(memory => (!story || story.memoryIds.includes(memory.id)) && memoryIds.includes(memory.id));
      if (story?.writingMode === "creative" && usesCloudStorage()) {
        const context = await storyAiContext(story.id, memoryIds);
        if (context.story.id !== story.id || context.story.version !== story.version || context.fingerprint !== fingerprint) throw new Error("故事刚刚更新，请重新整理");
        selectedMemories = context.memories;
        aiState = { ...state, contributions: context.memories };
      }
      const request = { memoryIds, storyId: story?.id, chapterTitle: target?.title ?? "", existingText: target ? plainText(target.content).trim() : "" };
      const result = !story || story.writingMode === "creative"
        ? await generateBiographyWithStatus(aiState, member, request)
        : { draft: buildLocalChapterDraft(selectedMemories, request.existingText, request.chapterTitle) };
      const { draft: organized, fallbackReason } = result;
      const latest = await loadRoomStateRemoteFirst();
      const latestFingerprint = story ? storySourceFingerprint(latest, story.id) : personalBookSourceFingerprint(latest, member.id);
      if (fingerprint !== latestFingerprint) throw new Error("素材刚刚变了，请重新整理");
      const { chapters, chapterId, keptImageCount } = applyOrganized(this.chapters, target?.id ?? "new", organized, memoryIds);
      const base = { ...(this.data.draft ?? this.newBookBase()), generationMode: organized.generationMode, generatedAt: organized.generatedAt };
      const label = chapterLabel(chapters.findIndex(chapter => chapter.id === chapterId) + 1);
      const notice = (story?.writingMode === "objective" ? "已按客观记录模式整理，未调用 AI。" : fallbackReason ? "这次没有用上在线 AI（" + FALLBACK_REASONS[fallbackReason] + "），预览由原话整理。" : "")
        + (keptImageCount ? "保留了 " + keptImageCount + " 张照片或插图。" : "");
      this.organizeCandidate = { draft: draftWithChapters(base, chapters), fingerprint, chapterId, label, notice, revisionId: this.revisionId };
      const chapter = chapters.find(item => item.id === chapterId)!;
      this.setData({
        panel: "organize-preview",
        previewTitle: chapter.title,
        previewText: plainText(chapter.content),
        previewAiLabel: organized.generationMode === "cloud-ai" ? "文字 AI 生成" : "",
        saveNotice: notice + "尚未写入，请查看并确认。",
      });
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "整理失败，请重试" });
    } finally { if (this.data.generating) this.setData({ generating: false }); }
  },
  async confirmOrganize() {
    const candidate = this.organizeCandidate;
    if (!candidate || this.data.saving || this.data.generating) return;
    if (!this.data.previewText.trim()) { this.setData({ saveNotice: "正文不能为空" }); return; }
    try {
      const state = await loadRoomStateRemoteFirst();
      const currentFingerprint = this.data.storyId ? storySourceFingerprint(state, this.data.storyId) : personalBookSourceFingerprint(state, this.data.memberId);
      const bookId = this.data.storyId || this.data.memberId;
      if (candidate.fingerprint !== currentFingerprint
        || currentManuscript(state, bookId).revisionId !== candidate.revisionId) throw new Error("素材或正文已有更新，请返回重新整理");
      const before = this.data.draft ? { draft: this.data.draft, fingerprint: this.sourceFingerprint } : undefined;
      const chapters = candidate.draft.chapters!;
      const chapter = chapters.find(item => item.id === candidate.chapterId)!;
      const content = [{ text: this.data.previewText.trim() + "\n" }, ...chapter.content.filter(item => item.photoId)];
      const next = draftWithChapters(candidate.draft, updateChapter(chapters, chapter.id, { title: this.data.previewTitle, content }));
      if (await this.persist(next, candidate.fingerprint, "version", "AI 整理" + candidate.label)) {
        this.organizeCandidate = undefined;
        this.undoState = before;
        this.openChapter({ currentTarget: { dataset: { id: candidate.chapterId } } });
        this.setData({ canUndo: !!before, saveNotice: "已写入" + candidate.label + "。" + candidate.notice });
      }
    } catch (error) { this.setData({ saveNotice: error instanceof Error ? error.message : "写入失败，请重试" }); }
  },
  async undoOrganize() {
    const undo = this.undoState;
    if (!undo || !this.data.canUndo || !this.canLeaveEditor()) return;
    if (await this.persist(undo.draft, undo.fingerprint, "restore", "撤回 AI 整理")) {
      this.undoState = undefined;
      this.setData({ saveNotice: "已撤回，回到整理前的样子。整理后的那一版仍在历史版本里。" });
    }
  },
  startInterview() { wx.navigateTo({ url: "/pages/interview/interview?storyId=" + encodeURIComponent(this.data.storyId) }); },
  /** Pictures are drawn from the saved chapter; selectTool has already refused to leave unsaved edits. */
  openImages() {
    const chapterId = this.data.view === "chapter" ? this.activeChapterId : "";
    const query = [
      this.data.storyId ? "storyId=" + encodeURIComponent(this.data.storyId) : "",
      !this.data.storyId && this.data.memberId ? "memberId=" + encodeURIComponent(this.data.memberId) : "",
      chapterId ? "chapterId=" + encodeURIComponent(chapterId) : "",
    ].filter(Boolean).join("&");
    wx.navigateTo({
      url: "/pages/story-images/story-images" + (query ? "?" + query : ""),
      events: {
        insertStoryImage: (image: { imageId: string; chapterId: string; url: string }) => {
          this.pendingStoryImage = image;
        },
      },
    });
  },
  /** Audio works are always built from the last saved story revision, never the live editor buffer. */
  openAudioStory() {
    if (!this.data.storyId || !this.data.savedRevisionId || !this.activeChapterId) {
      wx.showToast({ title: "请先保存这一章，再制作有声书", icon: "none" });
      return;
    }
    wx.navigateTo({ url: audioCreatePath({ storyId: this.data.storyId, revisionId: this.data.savedRevisionId, chapterId: this.activeChapterId }) });
  },
  goHome() {
    if (!this.canLeaveEditor()) return;
    wx.reLaunch({ url: "/pages/index/index" });
  },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
