import {
  BiographyDraft, contributionStoryTitle, isRecordingProfile, ManuscriptChapter, ManuscriptContent, ManuscriptRevision, MemoryContribution,
  memoryPool, personalBookSourceFingerprint,
} from "../../domain/biography";
import { BiographyFallbackReason, generateBiographyWithStatus } from "../../services/biographyService";
import { loadCurrentMemberRemoteFirst, loadRoomStateRemoteFirst, roomDataModeLabel } from "../../services/roomRepository";
import { currentManuscript, makeRevision, manuscriptHistory, saveManuscriptRevision } from "../../services/manuscript";
import { contentFromDelta, contentToDelta, readLocalPhoto, saveLocalPhoto, validateContent } from "../../services/bookImages";
import { storyImageApi } from "../../services/storyImageService";
import {
  addChapter, applyOrganized, assignMemory, chapterLabel, chaptersOf, draftWithChapters, moveChapter, removeChapter, unassignedMemoryIds, updateChapter,
} from "../../services/chapters";

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

type MemoryRow = { id: string; text: string };
const photoCount = (content: ManuscriptContent[]) => content.filter(item => item.photoId).length;
const plainText = (content: ManuscriptContent[]) => content.map(item => item.text ?? "").join("");
const memoryRow = (memory: MemoryContribution): MemoryRow => ({ id: memory.id, text: (memory.title ? memory.title + "：" : "") + memory.text.slice(0, 60) });

Page({
  data: {
    organizeBooks: [] as Array<{ id: string; title: string }>, previewText: "", previewTitle: "",
    protagonistName: "", memberId: "", sources: [] as Array<{ id: string; text: string; byline: string }>,
    sourceCount: 0, draft: null as BiographyDraft | null,
    generating: false, saving: false, isCloudDraft: false, modeLabel: "", modeNote: "",
    stale: false, showSources: false, editing: false, editTitle: "", editBody: "",
    history: [] as ManuscriptRevision[], showHistory: false,
    previewVersion: null as ManuscriptRevision | null,
    loadError: "", storageLabel: "", versionName: "", saveNotice: "",
    keyboardHeight: 0, viewportHeight: 0, panel: "", moreOpen: false, editorKeys: [0], pickingPhoto: false, editorReady: false,
    previewBlocks: [] as Array<{ text?: string; path?: string }>,
    // "contents" lists the chapters; "chapter" edits one of them. Empty until the first load.
    view: "" as "" | "contents" | "chapter",
    chapterRows: [] as Array<{ id: string; label: string; title: string; memoryCount: number; photoCount: number }>,
    chapterLabelText: "", editChapterTitle: "",
    unassigned: [] as MemoryRow[], chapterMemories: [] as MemoryRow[],
    storyOptions: [] as Array<{ title: string; count: number }>, assignMemoryId: "",
    // AI organizing: choose memories, choose a chapter, write it in directly; undo restores the version before.
    organizeRows: [] as Array<{ id: string; text: string; where: string; checked: boolean }>, organizeTarget: "", canUndo: false,
    // The active chapter's backdrop picture, when it has one and the cloud can serve it.
    backdropUrl: "",
  },
  // Native inputs own their live value/cursor. Do not echo the document on each keystroke.
  titleBuffer: "",
  chapterTitleBuffer: "",
  bodyBuffer: "",
  contentBuffer: [] as ManuscriptContent[],
  chapters: [] as ManuscriptChapter[],
  activeChapterId: "",
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
  pendingSave: undefined as ManuscriptRevision | undefined,
  organizeSelection: [] as string[],
  undoState: undefined as { draft: BiographyDraft; fingerprint: string } | undefined,

  openOrganizeOnLoad: false,
  requestedMemberId: "",
  requestedMemoryIds: [] as string[],
  organizeCandidate: undefined as { draft: BiographyDraft; fingerprint: string; chapterId: string; label: string; notice: string; revisionId: string } | undefined,
  onLoad(options: { memberId?: string; chapterId?: string; memoryIds?: string } = {}) {
    this.openOrganizeOnLoad = options.memoryIds !== undefined;
    this.requestedMemberId = options.memberId || "";
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
    if (!this.organizeCandidate && !this.data.editing && !this.data.generating && !this.data.saving && !this.data.pickingPhoto) {
      void this.refresh().catch(() => this.setData({ loadError: "书稿暂时加载失败，请重试。已有内容不会被清空。" }));
    }
  },
  async refresh(nextState?: Awaited<ReturnType<typeof loadRoomStateRemoteFirst>>) {
    const refreshId = ++this.refreshId;
    const state = nextState ?? await loadRoomStateRemoteFirst();
    const member = this.requestedMemberId ? state.members.find(item => item.id === this.requestedMemberId && isRecordingProfile(item)) : await loadCurrentMemberRemoteFirst(state);
    if (!member) throw new Error("这本书已不可用，请重新选择");
    const qualified = memoryPool(state.contributions);
    const current = currentManuscript(state, member.id);
    if ((this.data.editing && !this.data.saving) || this.data.pickingPhoto || this.unloaded) return;
    const chapters = current.draft ? chaptersOf(current.draft, current.sourceFingerprint) : [];
    const photoPaths: Record<string, string> = {};
    const imageIds: Record<string, string> = {};
    for (const item of chapters.flatMap(chapter => chapter.content)) {
      if (item.photoId) {
        const path = await readLocalPhoto(item.photoId);
        if (path) { photoPaths[item.photoId] = path; imageIds[path] = item.photoId; }
      }
    }
    if (this.unloaded || refreshId !== this.refreshId || (this.data.editing && !this.data.saving) || this.data.pickingPhoto) return;
    let view = this.data.view;
    if (!chapters.length) view = "contents";
    else if (!view) {
      // A single-chapter book (every older book) opens straight into its text, as before.
      view = chapters.length === 1 ? "chapter" : "contents";
      if (chapters.length === 1) this.activeChapterId = chapters[0].id;
    }
    if (view === "chapter" && !chapters.some(chapter => chapter.id === this.activeChapterId)) view = "contents";
    this.revisionId = current.revisionId;
    this.sourceFingerprint = current.sourceFingerprint;
    this.chapters = chapters;
    this.memories = qualified;
    this.titleBuffer = current.draft?.title ?? "";
    this.photoPaths = photoPaths;
    this.imageIds = imageIds;
    this.loadActiveChapter();
    this.setData({
      editTitle: this.titleBuffer, editBody: this.bodyBuffer, editChapterTitle: this.chapterTitleBuffer, view,
      organizeBooks: state.members.filter(isRecordingProfile).map(item => ({ id: item.id, title: currentManuscript(state, item.id).draft?.title || item.name + "的人生之书" })),
      protagonistName: member.name, memberId: member.id,
      sources: qualified.map(item => ({ id: item.id, text: item.text, byline: item.authorName + " · 讲述" })),
      sourceCount: qualified.length, draft: current.draft ?? null,
      isCloudDraft: current.draft?.generationMode === "cloud-ai",
      modeLabel: "当前书稿", modeNote: "可以直接编辑。新增记忆不会自动改动这份正文。",
      stale: !!current.draft && current.sourceFingerprint !== personalBookSourceFingerprint(state, member.id),
      history: manuscriptHistory(state, member.id), storageLabel: roomDataModeLabel(), loadError: "",
      ...this.chapterData(),
    });
    this.seedEditor();
    if (this.openOrganizeOnLoad || this.requestedMemoryIds.length) {
      this.openOrganizeOnLoad = false;
      this.showOrganize();
      this.organizeSelection = this.requestedMemoryIds.filter(id => qualified.some(item => item.id === id));
      this.requestedMemoryIds = [];
      this.setData({ organizeRows: this.data.organizeRows.map(row => ({ ...row, checked: this.organizeSelection.includes(row.id) })) });
    }
    void this.loadBackdrops(member.id, refreshId);
  },
  /** Point the editing buffers at the active chapter's saved text and name. */
  loadActiveChapter() {
    const active = this.chapters.find(chapter => chapter.id === this.activeChapterId);
    this.contentBuffer = active ? active.content.map(item => ({ ...item })) : [];
    this.chapterTitleBuffer = active?.title ?? "";
    this.bodyBuffer = plainText(this.contentBuffer).replace(/\n+$/, "");
  },
  chapterData() {
    const known = new Map(this.memories.map(memory => [memory.id, memory]));
    const active = this.chapters.find(chapter => chapter.id === this.activeChapterId);
    const stories = new Map<string, number>();
    this.memories.forEach(memory => {
      const title = contributionStoryTitle(memory);
      if (title) stories.set(title, (stories.get(title) ?? 0) + 1);
    });
    return {
      chapterRows: this.chapters.map((chapter, index) => ({
        id: chapter.id, label: chapterLabel(index + 1), title: chapter.title,
        memoryCount: chapter.memoryIds.filter(id => known.has(id)).length, photoCount: photoCount(chapter.content),
      })),
      unassigned: unassignedMemoryIds(this.chapters, this.memories.map(memory => memory.id)).map(id => memoryRow(known.get(id)!)),
      chapterMemories: active ? active.memoryIds.flatMap(id => known.has(id) ? [memoryRow(known.get(id)!)] : []) : [],
      chapterLabelText: active ? chapterLabel(this.chapters.indexOf(active) + 1) : "",
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
    if (this.editorLoading) return;
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
    if (!this.data.draft || this.data.view !== "chapter" || this.data.panel || this.data.saving || this.data.generating || this.data.pickingPhoto) return;
    if (!this.editorContext || !this.data.editorReady) { wx.showToast({ title: "编辑器还没准备好，请稍候", icon: "none" }); return; }
    this.setData({ pickingPhoto: true, saveNotice: "" });
    try {
      await this.collectEditor();
      const otherPhotos = this.chapters.filter(chapter => chapter.id !== this.activeChapterId).reduce((total, chapter) => total + photoCount(chapter.content), 0);
      if (otherPhotos + photoCount(this.contentBuffer) >= 9) throw new Error("一本书稿最多放 9 张照片");
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
      this.setData({ saveNotice: "照片仅在本机；请点保存。换手机或清理小程序后不可恢复。" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String((error as { errMsg?: string })?.errMsg ?? "");
      if (!/cancel/i.test(message)) this.setData({ saveNotice: error instanceof Error ? error.message : "无法添加照片，请检查相册权限或本机存储空间后重试" });
    } finally { if (!this.unloaded) this.setData({ pickingPhoto: false }); }
  },
  retryLoad() { this.onShow(); },
  canLeaveEditor() {
    if (this.data.editing || this.data.saving || this.data.generating || this.data.pickingPhoto || this.collecting) {
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
  closePanel() { if (this.data.generating || this.data.saving) return; this.organizeCandidate = undefined; if (!this.data.saving) this.setData({ panel: "", showHistory: false, showSources: false, previewVersion: null, assignMemoryId: "" }); },
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
    }
  },
  onKeyboardHeight(event: { detail: { height: number } }) {
    const keyboardHeight = Math.max(0, event.detail.height || 0);
    if (keyboardHeight !== this.data.keyboardHeight) this.setData({ keyboardHeight });
    this.updateViewport();
  },
  onVersionName(event: WechatMiniprogram.Input) { this.setData({ versionName: event.detail.value }); },
  editManuscript() {
    if (!this.data.draft || this.data.saving || this.data.generating || this.data.editing) return;
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
    if (this.data.saving) return false;
    this.setData({ saving: true, saveNotice: "" });
    try {
      if (!this.pendingSave || JSON.stringify(this.pendingSave.draft) !== JSON.stringify(draft) || this.pendingSave.kind !== kind || this.pendingSave.label !== label) {
        this.pendingSave = makeRevision(this.data.memberId, draft, fingerprint, kind, label);
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
      title: (this.data.protagonistName || "我") + "的人生之书", paragraphs: [], sourceCount: 0,
      generatedAt: new Date().toISOString(), generationMode: "local-demo",
    };
  },
  confirm(title: string, content: string) {
    return new Promise<boolean>(resolve => wx.showModal({ title, content, success: result => resolve(result.confirm), fail: () => resolve(false) }));
  },
  async saveEdits() {
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
  async createChapter(event: { currentTarget: { dataset: { story?: string } } }) {
    const story = event.currentTarget.dataset.story || "";
    const memoryIds = story ? this.memories.filter(memory => contributionStoryTitle(memory) === story).map(memory => memory.id) : [];
    let chapters: ManuscriptChapter[];
    try { chapters = addChapter(this.chapters, story, memoryIds); } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "无法新开一章" });
      return;
    }
    const id = chapters[chapters.length - 1].id;
    const label = chapterLabel(chapters.length);
    if (await this.saveChapters(chapters, "新开" + label)) {
      this.openChapter({ currentTarget: { dataset: { id } } });
      this.setData({ saveNotice: "已新开" + label + (memoryIds.length ? "，放进了 " + memoryIds.length + " 条记忆" : "") + "。" });
    }
  },
  chooseChapterFor(event: { currentTarget: { dataset: { id: string } } }) {
    if (this.canLeaveEditor()) this.setData({ panel: "assign", assignMemoryId: event.currentTarget.dataset.id });
  },
  async assignTo(event: { currentTarget: { dataset: { id: string } } }) {
    const memoryId = this.data.assignMemoryId;
    const target = event.currentTarget.dataset.id;
    if (!memoryId) return;
    let chapters: ManuscriptChapter[];
    try {
      chapters = target === "new" ? addChapter(this.chapters, "", [memoryId]) : assignMemory(this.chapters, memoryId, target);
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "无法调整章节" });
      return;
    }
    const index = target === "new" ? chapters.length - 1 : chapters.findIndex(chapter => chapter.id === target);
    if (await this.saveChapters(chapters, "调整章节")) {
      this.setData({ panel: "", assignMemoryId: "", saveNotice: "已放进" + chapterLabel(index + 1) + "，正文没有改动。" });
    }
  },
  async addToChapter(event: { currentTarget: { dataset: { id: string } } }) {
    await this.saveChapters(assignMemory(this.chapters, event.currentTarget.dataset.id, this.activeChapterId), "调整章节");
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
      const path = await readLocalPhoto(item.photoId);
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
    const active = this.data.view === "chapter" ? this.chapters.find(chapter => chapter.id === this.activeChapterId) : undefined;
    const known = new Set(this.memories.map(memory => memory.id));
    const inChapter = active?.memoryIds.filter(id => known.has(id)) ?? [];
    this.organizeSelection = inChapter.length ? inChapter : unassignedMemoryIds(this.chapters, [...known]);
    const where = new Map<string, string>();
    this.chapters.forEach((chapter, index) => chapter.memoryIds.forEach(id => where.set(id, "在" + chapterLabel(index + 1))));
    this.setData({
      panel: "organize", organizeTarget: active ? active.id : "new",
      organizeRows: this.memories.map(memory => ({ ...memoryRow(memory), where: where.get(memory.id) ?? "还没放进", checked: this.organizeSelection.includes(memory.id) })),
    });
  },
  async onOrganizeBook(event: { detail: { value: string } }) {
    if (this.data.generating || this.data.saving) return;
    this.openOrganizeOnLoad = true;
    this.requestedMemberId = event.detail.value;
    this.requestedMemoryIds = [...this.organizeSelection];
    this.organizeCandidate = undefined;
    try { await this.refresh(); } catch (error) { this.setData({ saveNotice: error instanceof Error ? error.message : "加载失败" }); }
  },
  onPreviewText(event: WechatMiniprogram.Input) { this.setData({ previewText: event.detail.value }); },
  onPreviewTitle(event: WechatMiniprogram.Input) { this.setData({ previewTitle: event.detail.value }); },
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
      const member = state.members.find(item => item.id === this.data.memberId && isRecordingProfile(item));
      if (!member) throw new Error("这本书已不可用");
      const fingerprint = personalBookSourceFingerprint(state, member.id);
      const { draft: organized, fallbackReason } = await generateBiographyWithStatus(state, member, {
        memoryIds, chapterTitle: target?.title ?? "", existingText: target ? plainText(target.content).trim() : "",
      });
      const latest = await loadRoomStateRemoteFirst();
      if (fingerprint !== personalBookSourceFingerprint(latest, member.id)) throw new Error("素材刚刚变了，请重新整理");
      const { chapters, chapterId, keptPhotoIds } = applyOrganized(this.chapters, target?.id ?? "new", organized, memoryIds);
      const base = { ...(this.data.draft ?? this.newBookBase()), generationMode: organized.generationMode, generatedAt: organized.generatedAt };
      const label = chapterLabel(chapters.findIndex(chapter => chapter.id === chapterId) + 1);
      const notice = (fallbackReason ? "这次没有用上在线 AI（" + FALLBACK_REASONS[fallbackReason] + "），预览由原话整理。" : "")
        + (keptPhotoIds.length ? "保留了 " + keptPhotoIds.length + " 张照片。" : "");
      this.organizeCandidate = { draft: draftWithChapters(base, chapters), fingerprint, chapterId, label, notice, revisionId: this.revisionId };
      const chapter = chapters.find(item => item.id === chapterId)!;
      this.setData({ panel: "organize-preview", previewTitle: chapter.title, previewText: plainText(chapter.content), saveNotice: notice + "尚未写入，请查看并确认。" });
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
      if (candidate.fingerprint !== personalBookSourceFingerprint(state, this.data.memberId)
        || currentManuscript(state, this.data.memberId).revisionId !== candidate.revisionId) throw new Error("素材或正文已有更新，请返回重新整理");
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
  startInterview() { wx.navigateTo({ url: "/pages/interview/interview" }); },
  /** Pictures are drawn from the saved chapter; selectTool has already refused to leave unsaved edits. */
  openImages() {
    const chapterId = this.data.view === "chapter" ? this.activeChapterId : "";
    wx.navigateTo({ url: "/pages/story-images/story-images" + (chapterId ? "?chapterId=" + encodeURIComponent(chapterId) : "") });
  },
  goHome() {
    if (!this.canLeaveEditor()) return;
    wx.reLaunch({ url: "/pages/index/index" });
  },
  onShareAppMessage() { return { title: "拾光Ai｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光Ai｜把重要的故事慢慢写下来" }; },
});
