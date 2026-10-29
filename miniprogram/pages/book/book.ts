import { bookCoverSource } from "../../services/bookCoverSource";
import { articleChatMaterial } from '../../services/articleChatMaterial';
import { organizeInlineAnswer } from '../../services/memoryOrganizerService';
import { articleChapter, addArticlePhoto, appendArticleText, type ArticleChapter } from '../../services/articleModules';
import { saveArticle, type ArticleSaveRequest } from '../../services/articleService';
import { ensurePhotoUploads } from '../../services/photoCloud';
import { linePosition, splitLines, type LinePosition } from "../../domain/lineModules";
import { exploreMemoryConnection, MemoryConnection } from "../../services/memoryConnections";
import { chapterDraftScope, chapterDraftKey, readChapterDraft, writeChapterDraft, clearChapterDraft } from "../../services/chapterDraft";
import { SendSnapshot, snapshotFromState, stageSendSnapshot } from "../../services/bookSend";
import { LINE_CONTEXT_CHAT_ENABLED } from "../../config/runtime";
import { displayLines, lineContextText, lineIndexFromRange, lineIndexFromSelection } from "../../services/lineContext";
import { storyCoverApi } from "../../services/storyCoverService";
import { logServiceFailure, SavedRefreshError } from '../../services/serviceFailure';
import {
  accountOwner, BiographyDraft, buildLocalChapterDraft, contributionStoryTitle, createContribution, createContributionFromSegments, FamilyRoomState, isActiveMember, isRecordingProfile, ManuscriptChapter, ManuscriptContent, ManuscriptRevision, MemoryContribution, Story,
  memoryAiLabel, memorySegmentCount, memoryPool, personalBookSourceFingerprint,
} from "../../domain/biography";
import {
  InterviewDimension,
  InterviewTurn,
} from "../../domain/interview";
import { BiographyFallbackReason, generateBiographyWithStatus } from "../../services/biographyService";
import { appendContributionRemoteFirst, deleteStoryRemoteFirst, loadCurrentMemberRemoteFirst, loadRoomStateRemoteFirst, roomDataModeLabel, takeStagedRoomStateForBook, usesCloudStorage } from "../../services/roomRepository";
import { cachedAccountScope } from "../../services/cloudRoomStorage";
import { currentManuscript, makeRevision, manuscriptHistory, saveManuscriptRevision } from "../../services/manuscript";
import {
  contentFromDelta, contentToDelta, isStoryImageId, isStoryImageReference, readLocalPhoto, readLocalPhotos, saveLocalPhoto,
  STORY_ILLUSTRATION_WIDTH, storyImageReferenceId, validateContent,
} from "../../services/bookImages";
import { newImageRequestId, StoryImage, storyImageApi } from "../../services/storyImageService";
import { shelfStoryLabel, storyShelf } from "../../services/storyShelf";
import {
  addChapter, applyOrganized, assignMemory, chapterAiLabel, chapterLabel, chaptersOf, draftWithChapters, finalizePendingRevision, moveChapter, pendingRevisionResolved, placeMemoryInChapter, proposeInlineXiaoyiInsert, removeChapter, resolvePendingEdit, unassignedMemoryIds, updateChapter,
} from "../../services/chapters";
import { chapterInsertionPoints, ChapterInsertionPoint, insertChapterText } from "../../services/chapterInsertion";
import { logLoadError } from "../../services/loadErrorLog";
import { measurePerformance, startPerformanceMeasure } from '../../services/performanceLog';
import { activeStory, linkStoryMemories, loadStoryHistory, loadStoryRevision, StoryHistoryEntry, storyAiContext, storySourceFingerprint, updateStoryBook } from "../../services/storyBooks";
import { loadCurrentStoryId, saveCurrentStoryId } from "../../services/storySelection";
import { audioCreatePath } from "../../services/storyAudioService";
import { storySharing, ChapterChange } from "../../services/storySharing";
import { copyRequestId, storyCopies } from "../../services/storyCopies";
import { CHAPTER_PACKAGE_ENABLED, envIsDevelop } from "../../services/chapterPackageGate";
import { exportChapterToCloud, importLastExport } from "../../services/chapterPackageFlow";
import { PackageLayout } from "../../domain/chapterPackage";
import { chapterPackageRequestId, chapterPackages, type ImportTarget } from "../../services/chapterPackageService";
import { chapterClaimToken, claimChapterDelivery, createChapterClaimLink, declineChapterDelivery, importChapterDelivery, listChapterDeliveryContacts, listChapterDeliveryInbox, readChapterDelivery, returnChapter as returnChapterDelivery, sendChapter as sendChapterDelivery } from "../../services/chapterDelivery";
import { CHAPTER_DELIVERY_ENABLED } from "../../config/runtime";
import { chapterPhotoIds, chapterLayoutView, ChapterLayoutViewPage } from "../../services/chapterLayoutView";
import { chapterIdsWithReturns, invalidatePendingReturns, loadPendingReturns, PendingReturn, returnsForChapter, senderLabel } from "../../services/storyReturnsInbox";
import {
  askXiaoyiQuestion, initialXiaoyiPanelData, onXiaoyiAnswerInput, onXiaoyiDraftInput, onXiaoyiWritingInstruction, organizeXiaoyiAnswer,
  resetXiaoyiPanel, useXiaoyiDraft, useXiaoyiOriginal, XiaoyiConfig, XiaoyiLandKind, xiaoyiMessagesAppend,
} from "../../services/xiaoyiCompanion";

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

type MemoryRow = { id: string; text: string; title: string; excerpt: string; dateLabel: string; createdAt: string; aiLabel: string };
type PendingEditRow = { id: string; kind: string; text: string; label: string; status: string };
type ChapterDrag = { id: string; startIndex: number; startY: number; rowHeight: number; changed: boolean; lastY: number; original: ManuscriptChapter[] };
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
  aiLabel: memoryAiLabel(memory),
});

Page({
  data: {
    articleChatPhotos: [] as Array<{id:string;path:string}>,
    article: null as ArticleChapter | null, articleWidth: 320, articlePaths: {} as Record<string,string>, articleStatus: "", articleDirty: false,
    openingChapter: null as { title: string; text: string } | null,
    photoMenu: "", photoAction: "", preparingPhoto: false, bookIntroduction: "", editIntroduction: "",
    coverUrl: "", coverImageId: "", sendOpen: false, preparingSend: false,
    organizeMethod: "insert" as "insert" | "blend", organizeOriginal: "", insertionPoint: "end",
    insertionPoints: [] as ChapterInsertionPoint[], insertionIndex: 0,
    previewInsertion: false, insertionText: "",
    memoryPreviewPhotos: [] as Array<{ id: string; path: string; ai: boolean }>,
    organizeWritingInstruction: "",
    connection: null as MemoryConnection | null, connectionBusy: false, connectionSaving: false, connectionNotice: "", connectionReflection: "",
    organizeCount: 0, organizeBookTitle: "", switchingBook: false,
    organizeBooks: [] as Array<{ id: string; title: string; memberId: string; detail: string; memoryIds: string[] }>, organizeBookKey: "", previewText: "", previewTitle: "", previewAiLabel: "",
    protagonistName: "", memberId: "", storyId: "", savedRevisionId: "", writingMode: "objective" as "objective" | "creative", sources: [] as Array<{ id: string; text: string; byline: string }>,
    sourceCount: 0, draft: null as BiographyDraft | null,
    loading: true, generating: false, saving: false, confirmingOrganize: false, isCloudDraft: false, modeLabel: "", modeNote: "",
    stale: false, showSources: false, editing: false, editTitle: "", editBody: "",
    history: [] as Array<StoryHistoryEntry | ManuscriptRevision>, historyLoading: false, revisionLoading: false, showHistory: false,
    previewVersion: null as ManuscriptRevision | null,
    loadError: "", storageLabel: "", versionName: "", saveNotice: "",
    keyboardHeight: 0, viewportHeight: 0, panel: "", moreOpen: false, moreSection: "", editorKeys: [0], pickingPhoto: false, editorReady: false,
    storyImageSelected: false, refreshingStoryImage: false,
    previewBlocks: [] as Array<{ text?: string; path?: string }>,
    previewLayoutPages: [] as ChapterLayoutViewPage[],
    currentLayoutPages: [] as ChapterLayoutViewPage[],
    // "contents" lists the chapters; "chapter" edits one of them. Empty until the first load.
    view: "" as "" | "contents" | "chapter",
    chapterRows: [] as Array<{ id: string; label: string; title: string; memoryCount: number; photoCount: number; hasReturn: boolean }>,
    swipeOpenChapterId: "", draggingChapterId: "",
    chapterLabelText: "", chapterAiLabelText: "", editChapterTitle: "",
    unassigned: [] as MemoryRow[], chapterMemories: [] as MemoryRow[],
    storyOptions: [] as Array<{ title: string; count: number }>, assignMemoryId: "",
    // AI organizing: choose memories, choose a chapter, write it in directly; undo restores the version before.
    articleMemoryOpen: false, articleMemoryLoading: false, articleMemoryNotice: '',
    articleMemoryRows: [] as Array<{id:string; text:string; checked:boolean}>,
    organizeRows: [] as Array<{ id: string; text: string; where: string; checked: boolean }>, organizeTarget: "", canUndo: false,
    // The active chapter's backdrop picture, when it has one and the cloud can serve it.
    backdropUrl: "",
    shareText: "", shareRecipientIds: [] as string[], sharingExcerpt: false,
    shareRecipients: [] as Array<{ id: string; name: string; relation: string; checked: boolean }>,
    articleSending: false, articleShareUrl: '', articleShareTitle: '', articleShareRevision: '', articleShareChapterId: '',
    protectedCopy: false, chapterPackageOn: CHAPTER_PACKAGE_ENABLED, chapterDeliveryOn: CHAPTER_PACKAGE_ENABLED && CHAPTER_DELIVERY_ENABLED, chapterPackageDev: CHAPTER_PACKAGE_ENABLED && envIsDevelop(), appendOwnText: "", appendingOwn: false, returningOwn: false,
    protectedCanRevise: false, protectedHasDeliveryLineage: false, protectedRevisionRows: [] as Array<{blockId:string;text:string}>, protectedRevisionLayout: null as PackageLayout | null,
    protectedLayoutRows: [] as Array<{pageIndex:number;moduleIndex:number;id:string;kind:string;x:number;y:number}>, protectedRevisionSaving: false,
    chapterReturns: [] as Array<{ returnId: string; senderName: string; text: string }>, decidingReturn: false,
    chapterChanges: [] as Array<{ revisionId: string; by: string; when: string; titleChange: string; blocks: Array<{ index: number; before: string; after: string }> }>, changesOpen: false,
    ...initialXiaoyiPanelData(),
    xiaoyiSelectionLabel: "已定位到当前文章",
    chapterPendingEdits: [] as PendingEditRow[], chapterPendingCount: 0,
  },
  // Native inputs own their live value/cursor. Do not echo the document on each keystroke.
  localDraftKey: "",
  localDraftToken: "",
  editSequence: 0,
  sendEpoch: 0,
  photoEpoch: 0,
  pendingPhotoImportChapter: "",
  editorError: "",
  editSave: undefined as Promise<boolean> | undefined,
  titleBuffer: "",
  chapterTitleBuffer: "",
  introductionBuffer: "",
  bodyBuffer: "",
  contentBuffer: [] as ManuscriptContent[],
  chapters: [] as ManuscriptChapter[],
  chapterSwipe: undefined as { id: string; startX: number; startY: number; moved: boolean } | undefined,
  chapterDrag: undefined as ChapterDrag | undefined,
  suppressChapterOpen: false,
  activeChapterId: "",
  bookImagesReady: undefined as Promise<void> | undefined,
  chapterOpenId: 0,
  excerptRequestId: "",
  appendOwnRequestId: "",
  pendingReturns: [] as PendingReturn[],
  chapterChangeCache: {} as Record<string, ChapterChange[]>,
  ownFamilyId: "",
  returnDecisionRequests: {} as Record<string, string>,
  returnOwnRequestId: "",
  protectedRevisionAttempt: undefined as { fingerprint: string; requestId: string } | undefined,
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
  historyRequestId: 0,
  revisionRequestId: 0,
  loadingId: 0,
  keyboardListener: undefined as ((event: { height: number }) => void) | undefined,
  revisionId: "",
  sourceFingerprint: "",
  story: undefined as Story | undefined,
  sendSnapshot: undefined as SendSnapshot | undefined,
  sendAccountScope: "",
  pendingSave: undefined as ManuscriptRevision | undefined,
  connectionEpoch: 0,
  connectionDraft: undefined as MemoryContribution | undefined,
  organizeSelection: [] as string[],
  organizeMemories: [] as MemoryContribution[],
  undoState: undefined as { draft: BiographyDraft; fingerprint: string } | undefined,
  pendingStoryImage: undefined as { imageId: string; chapterId: string; url: string } | undefined,

  openOrganizeOnLoad: false,
  requestedMemberId: "",
  requestedStoryKey: "",
  requestedStoryTitle: "",
  requestedMemoryIds: [] as string[],
  storyScopeMemoryIds: undefined as Set<string> | undefined,
  organizeCandidate: undefined as { draft: BiographyDraft; fingerprint: string; chapterId: string; label: string; notice: string; revisionId: string; insertion?: { original: ManuscriptContent[]; pointId: string; photoIds: string[] } } | undefined,
  xiaoyiAskedDimensions: [] as InterviewDimension[],
  xiaoyiConversation: [] as InterviewTurn[],
  xiaoyiContextCapturedText: "",
  xiaoyiLineContext: "",
  xiaoyiLinePosition: null as LinePosition | null,
  xiaoyiCapturedKey: "",
  xiaoyiCapturedSequence: -1,
  xiaoyiCaptureId: 0,
  xiaoyiCapturePending: undefined as Promise<void> | undefined,
  articleConflict: false,
  pendingChapterClaim: '',
  articlePending: null as ArticleChapter | null,
  articleAttempt: null as ArticleSaveRequest | null,
  articleSaving: null as Promise<boolean> | null,
  articleTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  articleKey() { return `article-draft:${cachedAccountScope()}:${this.story?.id || this.data.storyId}:${this.activeChapterId}`; },
  onArticleChange(event: { detail: { chapter: ArticleChapter } }) {
    this.setData({ articleShareUrl: '' });
    this.articlePending = event.detail.chapter;
    this.setData({ articleDirty: true, articleStatus: '正在保存…' });
    try { wx.setStorageSync(this.articleKey(), { revisionId: this.revisionId, chapter: this.articlePending }); }
    catch { this.setData({ articleStatus: '本机空间不足，请保持本页打开并重试保存' }); }
    if (this.articleTimer) clearTimeout(this.articleTimer);
    this.articleTimer = setTimeout(() => { void this.flushArticle(); }, 1200);
  },
  async flushArticle(): Promise<boolean> {
    if(this.articleConflict){this.setData({articleStatus:"本机草稿与云端新版冲突，草稿已保留，请先核对历史版本"});return false;}
    if (this.articleTimer) clearTimeout(this.articleTimer);
    if (this.articleSaving) { if (!await this.articleSaving) return false; }
    if (!this.articlePending && !this.articleAttempt) return true;
    const story = this.story;
    if (!story?.currentRevisionId || !story.version) return false;
    const snapshot = this.articlePending!;
    if (!this.articleAttempt) this.articleAttempt = { requestId: `request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`,
      storyId: story.id, revisionId: story.currentRevisionId, expectedVersion: story.version, chapter: snapshot };
    const attempt = this.articleAttempt;
    this.articleSaving = (async () => {
      try {
        await ensurePhotoUploads(chapterPhotoIds(attempt.chapter));
        const result = await saveArticle(attempt);
        this.story = { ...this.story!, version: result.version, currentRevisionId: result.revisionId };
        this.revisionId = result.revisionId;
        this.chapters = this.chapters.map(c => c.id === attempt.chapter.id ? attempt.chapter : c);
        this.articleAttempt = null;
        if (this.articlePending === attempt.chapter) {
          this.articlePending = null; wx.removeStorageSync(this.articleKey());
          this.setData({ article: attempt.chapter, articleDirty: false, articleStatus: '已保存', savedRevisionId: result.revisionId });
        } else {
          wx.setStorageSync(this.articleKey(), { revisionId: result.revisionId, chapter: this.articlePending });
        }
        return true;
      } catch (error) { this.setData({ articleStatus: error instanceof Error ? error.message : '保存失败，点这里重试' }); return false; }
      finally { this.articleSaving = null; }
    })();
    if (!await this.articleSaving) return false;
    return this.articlePending ? this.flushArticle() : true;
  },
  onArticleTitle(event: WechatMiniprogram.Input) {
    const base=this.articlePending || this.data.article;
    if(base)this.onArticleChange({detail:{chapter:{...base,title:event.detail.value}}});
  },
  async addArticleImage(event: { detail?: { blockId?: string; text?: string } } = {}) {
    if (this.data.pickingPhoto || !this.data.article) return;
    const action = await new Promise<number>(resolve => wx.showActionSheet({
      itemList: ['上传图片', '根据选中文字生成 AI 图片'],
      success: result => resolve(result.tapIndex), fail: () => resolve(-1),
    }));
    if (action < 0 || this.unloaded) return;
    if (action === 1) {
      const text = event.detail?.text?.trim();
      if (!text || !event.detail?.blockId) { wx.showToast({ title: '先点选一块文字，再添加图片', icon: 'none' }); return; }
      // Older chapters receive stable editor IDs on opening; persist those IDs before
      // asking the server to verify the selected block, even when no text was edited.
      const saved = this.chapters.find(chapter => chapter.id === this.activeChapterId);
      if (!saved?.content.some(block => block.blockId === event.detail!.blockId) && !this.articlePending)
        this.onArticleChange({detail:{chapter:this.data.article}});
      if (!await this.flushArticle()) return;
      this.openImages('illustration', { blockId: event.detail.blockId, text });
      return;
    }
    await this.uploadArticleImage();
  },
  async uploadArticleImage() {
    if (this.data.pickingPhoto || !this.data.article) return;
    this.setData({ pickingPhoto: true });
    try {
      const picked = await new Promise<WechatMiniprogram.ChooseMediaSuccessCallbackResult>((resolve,reject) => wx.chooseMedia({ count:1, mediaType:['image'], sizeType:['compressed'], success:resolve, fail:reject }));
      if (!picked.tempFiles[0] || this.unloaded) return;
      const photo = await saveLocalPhoto(picked.tempFiles[0].tempFilePath);
      this.photoPaths[photo.id] = photo.path;
      const chapter = addArticlePhoto(this.articlePending || this.data.article, photo.id);
      this.setData({ article:chapter, articlePaths:{...this.photoPaths} });
      this.onArticleChange({ detail:{chapter} });
    } catch (error) { this.setData({ articleStatus:error instanceof Error?error.message:'没有添加图片' }); }
    finally { this.setData({ pickingPhoto:false }); }
  },
  saveCurrentArticle() { if (this.data.article) void this.flushArticle(); else void this.saveEdits(); },
  sendCurrentArticle() { if (this.data.article) void this.sendArticle(); else this.toggleSend(); },
  async sendArticle() {
    if (this.data.articleSending) return;
    if ((this.articlePending || this.articleSaving || this.articleAttempt) && !await this.flushArticle()) return;
    if (!this.data.chapterDeliveryOn) { this.setData({ articleStatus: '发送功能暂未开放' }); return; }
    const choices = [...(this.data.protectedHasDeliveryLineage ? ['发回原作者'] : []), '发给网页用户', '发给微信用户'];
    const index = await new Promise<number>(resolve => wx.showActionSheet({ itemList: choices,
      success: result => resolve(result.tapIndex), fail: () => resolve(-1) }));
    const choice = choices[index];
    if (!choice || this.unloaded) return;
    this.setData({ articleSending: true, articleShareUrl: '' });
    try {
      if (choice === '发回原作者') await this.returnChapterDelivery();
      else if (choice === '发给微信用户') await this.openChapterDeliveryClaimLink('wechat');
      else await this.openChapterDeliveryClaimLink('web');
    } finally { this.setData({ articleSending: false }); }
  },
  onLoad(options: { storyId?: string; memberId?: string; chapterId?: string; memoryIds?: string; chapterClaim?: string } = {}) {
    this.pendingChapterClaim = /^[A-Za-z0-9_-]{43}$/.test(options.chapterClaim || '') ? options.chapterClaim! : '';
    this.sendSnapshot = undefined;
    this.sendAccountScope = "";
    this.openOrganizeOnLoad = options.memoryIds !== undefined;
    this.requestedMemberId = options.memberId || "";
    this.requestedStoryKey = options.storyId || loadCurrentStoryId();
    this.requestedMemoryIds = (options.memoryIds || "").split(",").filter(Boolean);
    if (options.chapterId) { this.activeChapterId = options.chapterId; this.setData({ view: "chapter" }); }
    this.unloaded = false;
    // 非 data 字段挂在页面定义上，每次打开都从干净状态开始，避免串到上一次的书。
    this.chapterChangeCache = {};
    this.ownFamilyId = "";
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
  onHide() {
    this.saveArticleChat();
    if (this.articlePending) void this.flushArticle();
    this.connectionEpoch++;
    this.setData({ connectionBusy: false });
    this.photoEpoch++;
    this.pendingPhotoImportChapter = "";
    this.setData({ photoMenu: "", preparingPhoto: false });
    this.sendEpoch++;
    this.setData({ sendOpen: false, moreOpen: false, moreSection: "" });
    if (this.data.editing) {
      this.backupEdits();
      void this.saveEdits(true);
    }
  },
  onUnload() {
    this.saveArticleChat();
    if (this.articleTimer) clearTimeout(this.articleTimer);
    if (this.articlePending) void this.flushArticle();
    // onUnload cannot await the network. The synchronous input backup is the guarantee.
    if (this.data.editing) { this.backupEdits(); void this.saveEdits(true); }
    this.unloaded = true;
    this.connectionEpoch++;
    if (this.keyboardListener) wx.offKeyboardHeightChange(this.keyboardListener);
    this.editorContext = undefined;
  },
  onShow() {
    // A staged snapshot belongs to this navigation attempt only. Consume it
    // even if another return path (for example image selection) does not
    // refresh the manuscript right now.
    const staged = takeStagedRoomStateForBook();
    if (this.pendingStoryImage) {
      if (this.data.article) { void this.placeSelectedStoryImage(); return; }
      this.setData({ storyImageSelected: true, refreshingStoryImage: true, saveNotice: "插图已选好。请点正文中的位置，再点顶部「插入插图」。" });
      void this.refreshSelectedStoryImageUrl();
      return;
    }
    if (!this.data.xiaoyiOpen && !this.articlePending && !this.articleSaving && !this.organizeCandidate && !this.data.editing && !this.data.generating && !this.data.saving && !this.data.pickingPhoto) {
      void this.refresh(staged, { projection: Boolean(staged) }).then(() => this.receiveSharedArticle()).catch((error) => { logLoadError("book", error); this.setData({ loadError: "书稿暂时加载失败，请重试。已有内容不会被清空。" }); });
    }
  },
  creatingFirstChapter: false,
  async refresh(nextState?: Awaited<ReturnType<typeof loadRoomStateRemoteFirst>>, options: { projection?: boolean } = {}) {
    const loadingId = ++this.loadingId;
    this.setData({loading:true});
    const finish = startPerformanceMeasure('book.refresh');
    let outcome: 'ok' | 'error' = 'error';
    try {
      await this.refreshBook(nextState, options.projection ?? !nextState);
      outcome = 'ok';
    } finally {
      if (!this.unloaded && loadingId === this.loadingId) this.setData({loading:false});
      finish(outcome);
    }
  },
  async refreshBook(nextState?: Awaited<ReturnType<typeof loadRoomStateRemoteFirst>>, projection = false) {
    const refreshId = ++this.refreshId;
    const storyId = this.requestedStoryKey || loadCurrentStoryId();
    // The preceding shelf read already authenticated this exact one-time
    // navigation. Reuse its account scope for the local-draft key; direct
    // links still revalidate before they access any locally stored draft.
    const stagedDraftScope = nextState && projection ? cachedAccountScope() : undefined;
    const [state, draftScope] = await Promise.all([
      // A current-version projection is enough to paint this book. Historical
      // revisions load only if the reader explicitly opens that panel.
      nextState ? Promise.resolve(nextState) : loadRoomStateRemoteFirst({view:"home"}),
      stagedDraftScope ? Promise.resolve(stagedDraftScope) : measurePerformance('book.identity', chapterDraftScope),
    ]);
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
    const available = memoryPool(state.contributions)
      .filter(memory => !deletedStoryTitles.has(contributionStoryTitle(memory)));
    const qualified = available
      .filter(memory => !this.storyScopeMemoryIds || this.storyScopeMemoryIds.has(memory.id));
    const bookId = story?.id || member.id;
    let current = currentManuscript(state, bookId);
    // A recipient can open a share before creating any story or profile.
    // There is no local book draft to restore until an owned book exists.
    const localDraftKey = bookId ? chapterDraftKey(draftScope, bookId) : "";
    let backup = !localDraftKey || story?.sourcePolicyRequired ? undefined : readChapterDraft(localDraftKey);
    const acknowledged = backup?.pendingSave?.id === current.revisionId;
    if (backup && acknowledged && JSON.stringify(backup.draft) === JSON.stringify(backup.pendingSave?.draft)) {
      clearChapterDraft(localDraftKey, backup.token);
      backup = undefined;
    }
    const conflict = !!backup && !acknowledged && (
      backup.revisionId !== current.revisionId ||
      (story && backup.storyVersion !== story.version)
    );
    if (backup) {
      current = {draft:backup.draft, sourceFingerprint:backup.fingerprint, revisionId:acknowledged ? current.revisionId : backup.revisionId};
    }
    if (this.data.editing || this.data.pickingPhoto || this.unloaded) return;
    const chapters = current.draft ? chaptersOf(current.draft, current.sourceFingerprint) : [];
    const visibleChapters = this.visibleChapters(chapters, story);
    const derivedIntroduction = visibleChapters.map(chapter => plainText(chapter.content).trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
    this.introductionBuffer = current.draft?.introduction ?? (Array.from(derivedIntroduction).slice(0, 160).join("") + (Array.from(derivedIntroduction).length > 160 ? "…" : ""));
    let activeChapterId = backup?.chapterId || this.activeChapterId;
    // A stale local draft remains recoverable, but must not trap a shelf visit
    // in its last chapter. Let the owner choose from the retained book's contents.
    let view = conflict ? "contents" : backup?.view || this.data.view;
    if (!visibleChapters.length) view = "contents";
    else if (!view) {
      view = visibleChapters.length === 1 ? "chapter" : "contents";
      if (visibleChapters.length === 1) activeChapterId = visibleChapters[0].id;
    }
    if (view === "chapter" && !visibleChapters.some(chapter => chapter.id === activeChapterId)) view = "contents";
    const localPhotoIds = chapters.flatMap(chapterPhotoIds).filter(id => !isStoryImageReference(id));
    const storyImageReferences = new Set(chapters.flatMap(chapter => chapter.content)
      .flatMap(item => item.photoId && isStoryImageReference(item.photoId) ? [item.photoId] : []));
    const backdropImageIds = new Set(chapters.flatMap(chapter => chapter.backdropImageId ? [chapter.backdropImageId] : []));
    const cloudImages = storyImageReferences.size || backdropImageIds.size || story?.coverImageId
      ? measurePerformance('book.images', () => storyImageApi.listStoryImages(bookId)).then(list => list.images).catch(() => [] as StoryImage[])
      : Promise.resolve([] as StoryImage[]);
    const images = Promise.all([
      measurePerformance('book.photos', () => readLocalPhotos(localPhotoIds)),
      cloudImages,
    ]).then(([{ photoPaths, imageIds }, cloudImages]) => {
      // Unavailable URLs retain their opaque recoverable markers in the editor.
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
      return { photoPaths, imageIds, backdropUrls };
    });
    // Only an editor opening with inline photos needs their URL-to-ID mappings.
    // Contents and plain text can render while decoration/unopened photos load.
    const opening = chapters.find(chapter => chapter.id === activeChapterId);
    const needsInlineImages = view === "chapter" && opening && chapterPhotoIds(opening).length > 0;
    if (needsInlineImages) {
      const chapter = chapters.find(item => item.id === activeChapterId)!;
      this.setData({ openingChapter: { title: chapter.title, text: plainText(chapter.content) } });
    }
    const { photoPaths, imageIds, backdropUrls } = needsInlineImages
      ? await images : { photoPaths: {}, imageIds: {}, backdropUrls: {} };
    if (this.unloaded || refreshId !== this.refreshId || this.data.editing || this.data.pickingPhoto) return;
    this.localDraftKey = localDraftKey;
    this.localDraftToken = backup?.token || "";
    this.editorError = backup?.editorError || "";
    if (backup) {
      this.pendingSave = acknowledged ? undefined : backup.pendingSave;
    }
    if (this.activeChapterId !== activeChapterId || this.data.storyId !== (story?.id ?? "")) {
      this.releaseArticleChat();
      resetXiaoyiPanel.call(this);
      this.xiaoyiContextCapturedText = "";
    }
    this.activeChapterId = activeChapterId;
    this.revisionId = current.revisionId;
    this.sourceFingerprint = current.sourceFingerprint;
    this.story = backup && !acknowledged && story ? {...story, version:backup.storyVersion} : story;
    this.sendAccountScope = draftScope;
    this.rememberSendSnapshot(state);
    this.chapters = chapters;
    this.memories = qualified;
    this.organizeMemories = available;
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
    let organizeBookKey = story?.id || (shelf.some(story => story.key === this.requestedStoryKey)
      ? this.requestedStoryKey
      : shelf.find(story => story.manuscriptMemberId === member.id)?.key ?? "");
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
      openingChapter: null,
      coverImageId: bookCoverSource(story?.coverImageId, current.draft), coverUrl: "",
      editTitle: this.titleBuffer, editBody: this.bodyBuffer, editChapterTitle: this.chapterTitleBuffer, view,
      organizeBooks, organizeBookKey, organizeBookTitle: organizeBooks.find(item => item.id === organizeBookKey)?.title || "",
      protagonistName: member.name, memberId: member.id, storyId: story?.id || "", savedRevisionId: current.revisionId || "", writingMode: story?.writingMode || "creative",
      sources: qualified.map(item => ({ id: item.id, text: item.text, byline: item.authorName + " · 讲述" })),
      sourceCount: qualified.length, draft: current.draft ?? null,
      editIntroduction: this.introductionBuffer,
      protectedCopy: story?.sourcePolicyRequired === true,
      isCloudDraft: current.draft?.generationMode === "cloud-ai",
      modeLabel: story?.sourcePolicyRequired ? "亲友故事副本" : story ? (story.writingMode === "creative" ? "AI 创作" : "自己写") : "当前书稿",
      modeNote: story?.sourcePolicyRequired ? "你收到的故事，修改会保存在这份副本中。" : story ? (story.writingMode === "creative" ? "直接写，没思路时点小鸟。" : "点击正文就能写。") : "可以直接编辑。",
      stale: !!current.draft && current.sourceFingerprint !== (story ? storySourceFingerprint(state, story.id) : personalBookSourceFingerprint(state, member.id)),
      history: projection ? [] : manuscriptHistory(state, bookId), historyLoading: false, storageLabel: roomDataModeLabel(), loadError: "",
      ...this.chapterData(),
    });
    this.bookImagesReady = images.then(result => {
      if (this.unloaded || refreshId !== this.refreshId) return;
      // Preserve any newly inserted photo mappings. Never re-seed the editor
      // or replace its buffers when a background request finishes.
      this.photoPaths = { ...result.photoPaths, ...this.photoPaths };
      this.imageIds = { ...result.imageIds, ...this.imageIds };
      this.backdropUrls = { ...result.backdropUrls, ...this.backdropUrls };
      const backdropUrl = this.activeBackdropUrl();
      if (backdropUrl !== this.data.backdropUrl) this.setData({ backdropUrl });
    }).catch(error => logLoadError('book.images', error));
    const coverSource = bookCoverSource(story?.coverImageId, current.draft);
    if (coverSource) {
      const coverUrl = story?.coverImageId ? cloudImages.then(images =>
        images.find(image => image.imageId === story.coverImageId && image.purpose === 'cover' && image.moderation === 'pass')?.url || '')
        : storyCoverApi.resolveUrl(bookId, coverSource);
      void coverUrl.then(url => {
        if (!this.unloaded && refreshId === this.refreshId) this.setData({coverUrl:url});
      }).catch(() => undefined);
    }
    if (backup) {
      this.bodyBuffer = plainText(this.contentBuffer);
      this.setData({editing:true, saveNotice:conflict
        ? "已找回本机草稿，但故事另有新版。草稿不会自动覆盖新版；可先复制正文保留。"
        : "已恢复上次未保存的草稿，退出编辑时会再次保存。"});
      wx.enableAlertBeforeUnload({message:"本机草稿已保留，尚未确认同步到故事。"});
    }
    this.seedEditor();
    void this.loadReturns(refreshId);
    void this.loadChapterChanges();
    if (story && !story.sourcePolicyRequired && !current.draft && !chapters.length
      && !this.creatingFirstChapter && !this.requestedMemoryIds.length && !this.openOrganizeOnLoad) {
      this.creatingFirstChapter = true;
      this.setData({saveNotice:'正在打开第一章…'});
      try { await this.createChapter({currentTarget:{dataset:{}}}); }
      finally { this.creatingFirstChapter = false; }
    }
    if (this.openOrganizeOnLoad || this.requestedMemoryIds.length) {
      this.openOrganizeOnLoad = false;
      this.showOrganize();
      if (this.requestedMemoryIds.length) this.organizeSelection = this.requestedMemoryIds.filter(id => available.some(item => item.id === id));
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
        organizeCount: this.organizeSelection.length,
      });
      this.updateOrganizeTarget(this.data.organizeTarget);
    }
  },
  openCover() {
    if (this.data.protectedCopy || this.data.saving || this.data.generating) return;
    if (this.data.editing) { this.setData({saveNotice:"请先保存书稿，再制作封面"}); return; }
    if (!this.data.storyId || !this.data.savedRevisionId) { this.setData({saveNotice:"请先保存这本书，再制作封面"}); return; }
    wx.navigateTo({url:"/pages/story-cover/story-cover?storyId=" + encodeURIComponent(this.data.storyId)});
  },
  onCoverError() { this.setData({ coverUrl: "" }); },
  togglePhotoMenu() {
    if (this.data.protectedCopy || !this.data.draft || this.data.panel || this.data.saving || this.data.generating || this.data.pickingPhoto || this.data.preparingPhoto) return;
    wx.hideKeyboard();
    this.setData({ photoMenu: this.data.photoMenu === "main" ? "" : "main", sendOpen: false, moreOpen: false });
  },
  closePhotoMenu() { this.setData({ photoMenu: "", photoAction: "" }); },
  showPhotoGeneration() {
    if (this.data.protectedCopy || !this.data.draft || this.data.panel || this.data.saving || this.data.generating || this.data.pickingPhoto || this.data.preparingPhoto) return;
    this.setData({ photoMenu: "generate" });
  },
  async choosePhotoAction(event: { currentTarget: { dataset: { action: string } } }) {
    const action = event.currentTarget.dataset.action;
    if (!["import", "illustration", "backdrop", "cover"].includes(action) || this.data.protectedCopy || this.data.preparingPhoto || !this.data.draft || this.data.panel || this.data.generating || this.data.pickingPhoto) return;
    if (action !== "cover" && this.data.view === "contents") {
      this.setData({ photoAction: action, photoMenu: "chapters" });
      return;
    }
    await this.runPhotoAction(action, this.activeChapterId);
  },
  async choosePhotoChapter(event: { currentTarget: { dataset: { id: string } } }) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.chapterRows.some(chapter => chapter.id === id)) return;
    await this.runPhotoAction(this.data.photoAction, id);
  },
  async runPhotoAction(action: string, chapterId: string) {
    if (!["import", "illustration", "backdrop", "cover"].includes(action) || this.data.protectedCopy || this.data.preparingPhoto || !this.data.draft || this.data.panel || this.data.generating || this.data.pickingPhoto) return;
    const epoch = ++this.photoEpoch;
    this.setData({ preparingPhoto: true, photoMenu: "", photoAction: "" });
    try {
      if (!await this.finishEditing() || this.unloaded || epoch !== this.photoEpoch) return;
      if (action === "cover") { this.openCover(); return; }
      if (!this.visibleChapters().some(chapter => chapter.id === chapterId)) return;
      if (this.data.view !== "chapter" || this.activeChapterId !== chapterId) {
        await this.openChapter({ currentTarget: { dataset: { id: chapterId } } });
      }
      if (this.unloaded || epoch !== this.photoEpoch || this.data.view !== "chapter" || this.activeChapterId !== chapterId) return;
      if (action === "import") {
        if (this.data.editorReady && !this.editorLoading) await this.addPhoto();
        else {
          this.pendingPhotoImportChapter = chapterId;
          this.setData({ saveNotice: "正在打开这一章，编辑器准备好后会继续导入图片。" });
        }
      } else this.openImages(action as "illustration" | "backdrop");
    } finally {
      if (!this.unloaded && epoch === this.photoEpoch) this.setData({ preparingPhoto: false });
    }
  },
  /** Point the editing buffers at the active chapter's saved text and name. */
  loadActiveChapter() {
    this.xiaoyiCaptureId++;
    this.xiaoyiContextCapturedText = "";
    this.xiaoyiCapturedKey = "";
    this.xiaoyiLineContext = "";
    this.xiaoyiLinePosition = null;
    const active = this.chapters.find(chapter => chapter.id === this.activeChapterId);
    this.contentBuffer = active ? active.content.map(item => ({ ...item })) : [];
    this.chapterTitleBuffer = active?.title ?? "";
    this.bodyBuffer = plainText(this.contentBuffer).replace(/\n+$/, "");
  },
  /** Independent story revisions already contain only their own chapters; virtual legacy stories still need filtering. */
  visibleChapters(chapters?: ManuscriptChapter[], story?: Story): ManuscriptChapter[] {
    const source = chapters ?? this.chapters;
    const scope = this.storyScopeMemoryIds;
    if ((chapters ? story : this.story) || !scope) return source;
    return source.filter((chapter: ManuscriptChapter) => (
      chapter.title.trim() === this.requestedStoryTitle
      || chapter.memoryIds.some(memoryId => scope.has(memoryId))
    ));
  },
  chapterData() {
    const known = new Map(this.memories.map(memory => [memory.id, memory]));
    const visibleChapters = this.visibleChapters();
    const active = visibleChapters.find(chapter => chapter.id === this.activeChapterId);
    const returned = this.story ? chapterIdsWithReturns(this.pendingReturns, this.story.id) : new Set<string>();
    const stories = new Map<string, number>();
    this.memories.forEach(memory => {
      const title = contributionStoryTitle(memory);
      if (title) stories.set(title, (stories.get(title) ?? 0) + 1);
    });
    let article = active && this.story && CHAPTER_PACKAGE_ENABLED ? articleChapter(active) : null;
    this.articleConflict = false;
    if (article) {
      const saved = wx.getStorageSync(this.articleKey());
      if (saved?.chapter?.id === active!.id) {
        article = saved.chapter; this.articlePending = article;
        if(saved.revisionId!==this.revisionId)this.articleConflict=true;
      }
    }
    return {
      article, articleWidth: Math.max(180, (this.windowWidth || 375) - 32), articlePaths: {...this.photoPaths},
      articleDirty: Boolean(this.articlePending), articleStatus:this.articleConflict?'本机草稿与云端新版冲突，草稿已保留':this.articlePending?'已恢复本机草稿，等待保存':this.data.articleStatus,
      currentLayoutPages: this.story?.sourcePolicyRequired && active?.layout
        ? chapterLayoutView(active, Math.max(1, (this.windowWidth || 375) - 56), this.photoPaths) : [],
      bookIntroduction: this.introductionBuffer,
      protectedCanRevise: Boolean(this.story?.sourcePolicyRequired === true && active?.content.some(item => typeof item.text === "string" && item.sourceIds?.length && item.blockId)),
      protectedHasDeliveryLineage: Boolean(active?.packageLineage?.rootPackageId && active.packageLineage.receivedPackageId),
      chapterRows: visibleChapters.map((chapter, index) => ({
        id: chapter.id, label: chapterLabel(index + 1), title: chapter.title,
        memoryCount: chapter.memoryIds.filter(id => known.has(id)).length, photoCount: chapterPhotoIds(chapter).length,
        hasReturn: returned.has(chapter.id),
      })),
      chapterReturns: this.story && active
        ? returnsForChapter(this.pendingReturns, this.story.id, active.id).map(item => ({
          returnId: item.returnId, senderName: senderLabel(item), text: [
            ...(item.sourceEdits ?? []).map(edit => "原文修改建议：\n" + edit.text),
            ...item.blocks.map(block => block.text),
          ].join("\n\n"),
        }))
        : [],
      // 最近讲的记忆排在最前面。
      unassigned: unassignedMemoryIds(visibleChapters, this.memories.map(memory => memory.id)).map(id => memoryRow(known.get(id)!))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      chapterMemories: active ? active.memoryIds.flatMap(id => known.has(id) ? [memoryRow(known.get(id)!)] : []) : [],
      chapterPendingEdits: active?.pendingRevision?.edits.map(edit => ({
        id: edit.id,
        kind: edit.kind,
        text: edit.text,
        label: edit.kind === "insert" ? (edit.source === "ai" ? "待确认新增 · 小忆协助" : "待确认新增") : "待确认删除",
        status: edit.status,
      })) ?? [],
      chapterPendingCount: active?.pendingRevision?.edits.filter(edit => edit.status === "pending").length ?? 0,
      chapterLabelText: active ? chapterLabel(visibleChapters.indexOf(active) + 1) : "",
      chapterAiLabelText: active ? chapterAiLabel(active) : "",
      storyOptions: Array.from(stories, ([title, count]) => ({ title, count })),
      backdropUrl: this.activeBackdropUrl(),
    };
  },
  activeBackdropUrl() {
    const active = this.chapters.find(chapter => chapter.id === this.activeChapterId);
    if (active?.backdropImageId) return this.backdropUrls[active.backdropImageId] ?? "";
    const assetId = active?.layout?.settings.bodyTextureAssetId;
    const photoId = assetId ? active?.packageAssets?.[assetId]?.photoId : undefined;
    return photoId ? this.photoPaths[photoId] ?? '' : '';
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
      success: () => {
        this.editorLoading = false; this.setData({ editorReady: true });
        if (this.pendingPhotoImportChapter === this.activeChapterId && this.data.view === "chapter") {
          this.pendingPhotoImportChapter = "";
          void this.addPhoto();
        }
      },
      fail: () => {
        this.editorLoading = false;
        if (this.pendingPhotoImportChapter === this.activeChapterId) this.pendingPhotoImportChapter = "";
        this.setData({ editorReady: false, saveNotice: "图文编辑器加载失败，请重新打开书稿" });
      },
    });
  },
  onEditorInput(event: { detail: { delta: unknown; text: string } }) {
    if (this.editorLoading || this.data.protectedCopy) return;
    try {
      const next = contentFromDelta(event.detail.delta, this.imageIds);
      if (JSON.stringify(next) === JSON.stringify(this.contentBuffer)) return;
      this.editorError = "";
      this.contentBuffer = next;
      this.bodyBuffer = this.contentBuffer.map(item => item.text ?? "").join("");
      this.editManuscript();
    } catch (error) {
      // Preserve all readable text even for an unsupported pasted image. Never save the stale buffer.
      this.contentBuffer = [{text:event.detail.text}];
      this.bodyBuffer = event.detail.text;
      this.editorError = error instanceof Error ? error.message : "正文读取失败";
      this.editManuscript();
      this.setData({ saveNotice: error instanceof Error ? error.message : "正文读取失败" });
    }
  },
  async collectEditor() {
    if (!this.editorContext) return;
    const sequence = this.editSequence;
    const result = await new Promise<WechatMiniprogram.GetContentsSuccessCallbackResult>((resolve, reject) =>
      this.editorContext!.getContents({ success: resolve, fail: reject }));
    if (sequence !== this.editSequence) return;
    this.contentBuffer = contentFromDelta(result.delta, this.imageIds);
    this.editorError = "";
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
    if (this.data.article) {
      try {
        const referenceId = storyImageReferenceId(input.imageId);
        const base = this.articlePending || this.data.article;
        if (base.content.some(item => item.photoId === referenceId)) return true;
        const chapter = addArticlePhoto(base, referenceId, true);
        this.photoPaths[referenceId] = input.url;
        this.setData({ article: chapter, articlePaths: { ...this.photoPaths } });
        this.onArticleChange({ detail: { chapter } });
        return await this.flushArticle();
      } catch (error) { this.setData({ articleStatus: error instanceof Error ? error.message : '图片没有加入，请重试' }); return false; }
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
        src: input.url, alt: "AI 插图", width: STORY_ILLUSTRATION_WIDTH, success: () => resolve(), fail: reject,
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
      const list = await storyImageApi.listStoryImages(this.data.storyId || this.data.memberId);
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
  canLeaveEditor(allowLocalDraft = false) {
    if (this.data.connectionReflection.trim()) { wx.showToast({ title: "还有未保存的想法，请先保存或清空", icon: "none" }); return false; }
    if (this.data.connectionSaving || (this.data.editing && !allowLocalDraft) || this.data.saving || this.data.generating || this.data.pickingPhoto || this.data.appendingOwn || this.collecting) {
      wx.showToast({ title: this.data.editing ? "请先保存正文，或放弃修改" : "请稍等片刻", icon: "none" });
      return false;
    }
    return true;
  },
  async onBack() {
    if (this.data.openingChapter) {
      if (!this.data.draft) {
        this.refreshId++;
        this.setData({ openingChapter: null });
        await this.goHome();
      } else await this.backToContents();
      return;
    }
    if (this.data.view === "chapter") await this.backToContents();
    else await this.goHome();
  },
  async finishEditing(allowLocalDraft = false) {
    if (this.editSave) await this.editSave;
    if (this.data.editing && !await this.saveEdits()) {
      if (!allowLocalDraft || !this.canLeaveEditor(true)) return false;
      // Navigation may retain an unsynced draft, but it may not discard unread
      // native input or bypass storage failure. Publishing still requires saving.
      this.collecting = true;
      try {
        if (this.data.view === "chapter") await this.collectEditor();
        if (this.editorError || !this.backupEdits()) return false;
        this.chapters = chaptersOf(this.bufferedDraft()!, this.sourceFingerprint);
      } catch {
        this.setData({saveNotice:"无法读取完整正文，请留在本页重试保存或复制正文备份。"});
        return false;
      } finally { this.collecting = false; }
    }
    return this.canLeaveEditor(allowLocalDraft);
  },
  async backToContents() {
    if ((this.articlePending || this.articleSaving || this.articleAttempt) && !await this.flushArticle()) return;
    if (this.data.openingChapter && this.data.loading) this.refreshId++;
    this.chapterOpenId++;
    this.pendingPhotoImportChapter = "";
    if ((this.data.editing || this.editSave) && !await this.finishEditing(true)) return;
    if (!this.canLeaveEditor(true)) return;
    if (this.data.editing && !this.backupEdits("contents")) return;
    this.releaseArticleChat();
    resetXiaoyiPanel.call(this);
    this.setData({ openingChapter: null, view: "contents", moreOpen: false, panel: "", ...this.chapterData() });
  },
  async openChapter(event: { currentTarget: { dataset: { id: string } } }) {
    if ((this.articlePending || this.articleSaving || this.articleAttempt) && !await this.flushArticle()) return;
    if (this.suppressChapterOpen) { this.suppressChapterOpen = false; return; }
    const openId = ++this.chapterOpenId;
    if ((this.data.editing || this.editSave) && !await this.finishEditing(true)) return;
    if (openId !== this.chapterOpenId || !this.canLeaveEditor(true)) return;
    const id = event.currentTarget.dataset.id;
    if (this.pendingPhotoImportChapter && this.pendingPhotoImportChapter !== id) this.pendingPhotoImportChapter = "";
    const chapter = this.chapters.find(chapter => chapter.id === id);
    if (!chapter) return;
    if (chapter.content.some(item => item.photoId) && this.bookImagesReady) {
      this.setData({ openingChapter: { title: chapter.title, text: plainText(chapter.content) } });
      const refreshId = this.refreshId;
      const sequence = this.editSequence;
      const panel = this.data.panel;
      await this.bookImagesReady;
      if (this.unloaded || refreshId !== this.refreshId || openId !== this.chapterOpenId ||
          sequence !== this.editSequence || panel !== this.data.panel || !this.canLeaveEditor(true)) return;
    }
    this.releaseArticleChat();
    this.activeChapterId = id;
    resetXiaoyiPanel.call(this);
    this.xiaoyiContextCapturedText = "";
    this.loadActiveChapter();
    this.setData({ openingChapter: null, view: "chapter", panel: "", moreOpen: false, editChapterTitle: this.chapterTitleBuffer, ...this.chapterData(), chapterChanges: [], changesOpen: false });
    this.seedEditor();
    void this.loadChapterChanges();
  },
  startChapterSwipe(event: WechatMiniprogram.TouchEvent) {
    if (this.data.protectedCopy || this.chapterDrag) return;
    const touch = event.touches[0];
    if (!touch) return;
    this.chapterSwipe = { id: String(event.currentTarget.dataset.id || ""), startX: touch.clientX, startY: touch.clientY, moved: false };
  },
  moveChapterSwipe(event: WechatMiniprogram.TouchEvent) {
    if (!this.chapterSwipe || this.chapterDrag) return;
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - this.chapterSwipe.startX;
    const dy = touch.clientY - this.chapterSwipe.startY;
    if (Math.abs(dx) < 36 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    this.chapterSwipe.moved = true;
    if (dx < 0) this.setData({ swipeOpenChapterId: this.chapterSwipe.id });
    else if (this.data.swipeOpenChapterId) this.setData({ swipeOpenChapterId: "" });
  },
  endChapterSwipe() {
    if (this.chapterSwipe?.moved) this.suppressNextChapterTap();
    this.chapterSwipe = undefined;
  },
  suppressNextChapterTap() {
    this.suppressChapterOpen = true;
    setTimeout(() => { this.suppressChapterOpen = false; }, 400);
  },
  startChapterDrag(event: WechatMiniprogram.TouchEvent) {
    if (this.data.protectedCopy || this.data.saving || this.data.editing || this.data.chapterRows.length < 2 || this.chapterDrag) return;
    const touch = event.touches[0];
    const id = String(event.currentTarget.dataset.id || "");
    const startIndex = this.chapters.findIndex(chapter => chapter.id === id);
    if (!touch || startIndex < 0) return;
    const drag: ChapterDrag = {
      id, startIndex, startY: touch.clientY, rowHeight: Math.max(1, 124 * this.windowWidth / 750), changed: false, lastY: touch.clientY,
      original: this.chapters.map(chapter => ({ ...chapter, memoryIds: [...chapter.memoryIds], content: chapter.content.map(item => ({ ...item })) })),
    };
    this.chapterDrag = drag;
    this.setData({ draggingChapterId: id, swipeOpenChapterId: "" });
  },
  moveChapterDrag(event: WechatMiniprogram.TouchEvent) {
    const drag = this.chapterDrag, touch = event.touches[0];
    if (!drag || !touch) return;
    drag.lastY = touch.clientY;
    this.applyChapterDrag(drag.lastY);
  },
  applyChapterDrag(y: number) {
    const drag = this.chapterDrag;
    if (!drag) return;
    const offset = Math.round((y - drag.startY) / drag.rowHeight);
    const target = Math.max(0, Math.min(this.chapters.length - 1, drag.startIndex + offset));
    const current = this.chapters.findIndex(chapter => chapter.id === drag.id);
    if (current < 0 || target === current) return;
    this.chapters = moveChapter(this.chapters, drag.id, target - current);
    drag.changed = true;
    this.setData({ ...this.chapterData(), draggingChapterId: drag.id, swipeOpenChapterId: "" });
  },
  async endChapterDrag() {
    const drag = this.chapterDrag;
    if (!drag) return;
    this.chapterDrag = undefined;
    this.suppressNextChapterTap();
    this.setData({ draggingChapterId: "" });
    const before = drag.original.map(chapter => chapter.id), after = this.chapters.map(chapter => chapter.id);
    if (!drag.changed || JSON.stringify(before) === JSON.stringify(after)) {
      this.setData({ saveNotice: "按住右侧把手并上下移动，即可调整章节顺序。" });
      return;
    }
    if (await this.saveChapters(this.chapters, "调整章节顺序")) {
      this.setData({ saveNotice: "章节顺序已保存。" });
    } else {
      this.chapters = drag.original;
      this.setData({ ...this.chapterData(), saveNotice: this.data.saveNotice || "顺序没有保存，请重试。" });
    }
  },
  toggleSources() {
    if (this.canLeaveEditor()) this.setData({ panel: "sources", showSources: true });
  },
  toggleHistory() {
    if (!this.canLeaveEditor()) return;
    this.setData({ panel: "history", showHistory: true, previewVersion: null, revisionLoading: false });
    void this.loadHistory();
  },
  async loadHistory() {
    const requestId = ++this.historyRequestId;
    this.setData({ historyLoading: true });
    try {
      const history = this.data.storyId ? await loadStoryHistory(this.data.storyId)
        : manuscriptHistory(await loadRoomStateRemoteFirst(), this.data.memberId);
      if (this.unloaded || requestId !== this.historyRequestId || this.data.panel !== "history") return;
      this.setData({ history, historyLoading: false });
    } catch (error) {
      if (this.unloaded || requestId !== this.historyRequestId) return;
      this.setData({ historyLoading: false, saveNotice: error instanceof Error ? error.message : "历史版本暂时加载失败，请重试" });
    }
  },
  closePanel() { if (this.data.generating || this.data.saving || this.data.confirmingOrganize || this.data.appendingOwn || this.data.connectionSaving) return; this.connectionEpoch++; this.setData({ connectionBusy: false }); this.organizeCandidate = undefined; if (!this.data.saving) this.setData({ panel: "", showHistory: false, showSources: false, previewVersion: null, assignMemoryId: "" }); },
  showMore() {
    if (this.data.saving || this.data.generating || this.data.pickingPhoto) return;
    wx.hideKeyboard();
    this.closePhotoMenu();
    this.setData({ moreOpen: false, moreSection: "", sendOpen: false });
    const actions: Array<{label:string;action:string}> = [];
    if (!this.data.protectedCopy) {
      if (this.data.writingMode === "creative") actions.push({label:"AI 帮我写",action:"generate"});
      if (this.data.storyId) actions.push({label:this.data.writingMode === "creative" ? "切换为自己写" : "切换为 AI 创作",action:"mode"});
      if (this.data.view === "contents") actions.push({label:"新建章节",action:"new-chapter"});
      else if (!this.data.article) actions.push({label:"添加图片",action:"photo-menu"});
    }
    if (this.data.draft) actions.push({label:"历史版本",action:"history"});
    if (this.data.view === "contents" && this.data.storyId && this.data.savedRevisionId && !this.data.protectedCopy)
      actions.push({label:"删除整个故事（可恢复）",action:"delete-story"});
    if (!actions.length) { wx.showToast({title:"先写下你的故事",icon:"none"});return; }
    wx.showActionSheet({
      itemList: actions.map(item=>item.label),
      success: result => {
        const choice=actions[result.tapIndex];
        if (!this.unloaded && choice) void this.selectTool({currentTarget:{dataset:{action:choice.action}}});
      },
      fail: () => {},
    });
  },
  closeMore() { this.setData({ moreOpen: false, moreSection: "" }); },
  showMoreMain() { this.setData({ moreSection: "" }); },
  showChapterTools() {
    if (!this.data.protectedCopy && this.data.view === "chapter" && this.canLeaveEditor()) this.setData({ moreSection: "chapter" });
  },
  deleteCurrentStory() {
    const story = this.story;
    if (!story || !this.data.storyId || this.data.protectedCopy || this.data.editing || this.data.saving || this.data.generating) return;
    wx.showModal({
      title: `删除「${story.title}」？`,
      content: "故事会进入最近删除；原始记忆和书稿版本都会保留，恢复后原样回来。",
      confirmText: "删除",
      confirmColor: "#c75245",
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await deleteStoryRemoteFirst(story.id, story.title);
          saveCurrentStoryId("");
          wx.showToast({ title: "已放进最近删除", icon: "none" });
          wx.navigateBack();
        } catch (error) {
          wx.showToast({ title: error instanceof Error ? error.message : "删除没有完成，请重试", icon: "none" });
        }
      },
    });
  },
  toggleSend() {
    if (this.data.protectedCopy || !this.data.draft || !['contents', 'chapter'].includes(this.data.view) || this.data.panel || this.data.preparingSend || this.data.generating || this.data.pickingPhoto) return;
    wx.hideKeyboard();
    this.closePhotoMenu();
    this.setData({ sendOpen: !this.data.sendOpen, moreOpen: false });
  },
  closeSend() { this.setData({ sendOpen: false }); },
  rememberSendSnapshot(state: FamilyRoomState) {
    this.sendSnapshot = undefined;
    const story = this.story;
    if (!story || !Number.isSafeInteger(story.version) || !story.currentRevisionId || !this.sendAccountScope) return;
    try {
      this.sendSnapshot = snapshotFromState(state, { storyId: story.id, revisionId: story.currentRevisionId, version: story.version! }, this.sendAccountScope);
    } catch { /* Unsaved, protected or mismatched manuscripts use the normal fresh read. */ }
  },
  async chooseSend(event: WechatMiniprogram.TouchEvent) {
    const destination = event.currentTarget.dataset.destination as 'family' | 'social' | 'card';
    if (destination !== 'family' && destination !== 'social' && destination !== 'card') return;
    if (this.data.protectedCopy || this.data.preparingSend || !this.data.draft || !['contents', 'chapter'].includes(this.data.view) || this.data.panel) return;
    const view = this.data.view, chapterId = this.activeChapterId;
    const epoch = ++this.sendEpoch;
    this.setData({ preparingSend: true, sendOpen: false });
    try {
      if (!await this.finishEditing() || this.unloaded || epoch !== this.sendEpoch || this.data.view !== view || (view === 'chapter' && this.activeChapterId !== chapterId) || this.data.panel) return;
      const story = this.story;
      if (!story || story.sourcePolicyRequired || !this.data.savedRevisionId || !Number.isSafeInteger(story.version) || (story.version || 0) < 1) {
        this.setData({ saveNotice: '请从书架打开已保存的自有故事，再准备发送' }); return;
      }
      const base = '/packages/story-sharing/pages/' + ({ family: 'social', social: 'social', card: 'card' } as const)[destination] + '/index';
      const url = base + '?storyId=' + encodeURIComponent(story.id) + (destination !== 'card'
        ? '&revisionId=' + encodeURIComponent(this.data.savedRevisionId) + '&version=' + story.version : '')
        + (destination === 'family' ? '&destination=family' : '');
      stageSendSnapshot(destination !== 'card' ? this.sendSnapshot : undefined);
      await new Promise<void>((resolve, reject) => wx.navigateTo({ url, success: () => resolve(), fail: reject }));
    } catch {
      stageSendSnapshot(undefined);
      if (!this.unloaded && epoch === this.sendEpoch) this.setData({ saveNotice: '发送页面暂未打开，请重试。已有书稿不受影响。' });
    } finally {
      if (!this.unloaded) this.setData({ preparingSend: false });
    }
  },
  async selectTool(event: { currentTarget: { dataset: { action: string } } }) {
    if ((this.articlePending || this.articleSaving || this.articleAttempt) && !await this.flushArticle()) return;
    if (this.data.saving || this.data.generating) return;
    this.closeMore();
    this.closeSend();
    this.closePhotoMenu();
    const action = event.currentTarget.dataset.action;
    if (action === "copy-draft") { this.copyCurrentDraft(); return; }
    if (action === "discard") { this.cancelEdit(); return; }
    if (this.data.editing && !await this.finishEditing()) return;
    if (!this.canLeaveEditor()) return;
    switch (action) {
      case "delete-story": this.deleteCurrentStory(); break;
      case "photo-menu": this.togglePhotoMenu(); break;
      case "history": this.toggleHistory(); break;
      case "version": this.setData({ panel: "version" }); break;
      case "generate": this.showOrganize(); break;
      case "sources": this.toggleSources(); break;
      case "record": this.startInterview(); break;
      case "new-chapter": await this.createChapter({ currentTarget: { dataset: {} } }); break;
      case "memories": this.setData({ panel: "memories" }); break;
      case "up": void this.moveActiveChapter(-1); break;
      case "down": void this.moveActiveChapter(1); break;
      case "delete-chapter": void this.deleteActiveChapter(); break;
      case "images": this.openImages(); break;
      case "audio": this.openAudioStory(); break;
      case "invite": if(this.data.storyId)wx.navigateTo({url:'/packages/story-sharing/pages/invite/index?storyId='+encodeURIComponent(this.data.storyId)}); break;
      case "people": if(this.data.storyId)wx.navigateTo({url:'/pages/room/room?storyId='+encodeURIComponent(this.data.storyId)}); break;
      case "share-card": if(this.data.storyId)wx.navigateTo({url:'/packages/story-sharing/pages/card/index?storyId='+encodeURIComponent(this.data.storyId)}); break;
      case "mode": void this.switchWritingMode(); break;
      case "package-chapter": void this.packageActiveChapter(); break;
      case "import-package": void this.importLastPackage(); break;
      case "chapter-delivery-send": void this.openChapterDeliverySend(); break;
      case "chapter-delivery-link": void this.openChapterDeliveryClaimLink(); break;
      case "chapter-delivery-claim": void this.openChapterDeliveryClaim(); break;
      case "chapter-delivery-inbox": void this.openChapterDeliveryInbox(); break;
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
  async openArticleMemories() {
    if (!this.data.article || this.data.protectedCopy || this.data.xiaoyiLoading || this.data.articleMemoryLoading) return;
    const key = this.articleChatKey();
    this.setData({articleMemoryOpen:true, articleMemoryLoading:true, articleMemoryNotice:'', articleMemoryRows:[]});
    try {
      const state = await loadRoomStateRemoteFirst({view:"memory-sources"});
      if (this.unloaded || key !== this.articleChatKey() || !this.data.articleMemoryOpen) return;
      const owner = accountOwner(state.members);
      const memories = memoryPool(state.contributions).filter(memory => memory.authorMemberId === owner?.id && memory.text.trim());
      this.setData({articleMemoryRows:memories.map(memory => ({id:memory.id, text:memoryRow(memory).text, checked:false})),
        articleMemoryNotice:memories.length ? '' : '还没有自己的文字记忆，可以先直接写。'});
    } catch (error) {
      if (!this.unloaded && key === this.articleChatKey()) this.setData({articleMemoryNotice:error instanceof Error ? error.message : '记忆暂时没加载出来，请重试。'});
    } finally { if (!this.unloaded && key === this.articleChatKey()) this.setData({articleMemoryLoading:false}); }
  },
  closeArticleMemories() {
    if (!this.data.articleMemoryLoading) this.setData({articleMemoryOpen:false});
  },
  onArticleMemories(event: {detail:{value:string[]}}) {
    if (this.data.articleMemoryLoading) return;
    this.setData({articleMemoryRows:this.data.articleMemoryRows.map(row => ({...row, checked:event.detail.value.includes(row.id)}))});
  },
  async composeArticleMemories() {
    if (this.data.articleMemoryLoading || this.data.xiaoyiLoading || this.data.protectedCopy || !this.data.article) return;
    const ids = this.data.articleMemoryRows.filter(row => row.checked).map(row => row.id);
    if (!ids.length) {this.setData({articleMemoryNotice:'先选几段想加入的记忆。'});return;}
    const key = this.articleChatKey();
    this.setData({articleMemoryLoading:true, articleMemoryNotice:''});
    try {
      // Re-read before using sources: removed or unavailable memories must not be sent to AI.
      const state = await loadRoomStateRemoteFirst({view:"memory-sources"});
      if (this.unloaded || key !== this.articleChatKey()) return;
      const owner = accountOwner(state.members);
      const memories = memoryPool(state.contributions).filter(memory => ids.includes(memory.id) && memory.authorMemberId === owner?.id && memory.text.trim());
      if (memories.length !== ids.length) throw new Error('所选记忆已变化，请重新打开选择。');
      this.restoreArticleChat();
      const added = memories.map(memory => ({role:'user' as const, text:'〔选入的记忆〕' + memory.text}))
        .filter(turn => !this.xiaoyiConversation.some(previous => previous.role === 'user' && previous.text === turn.text));
      articleChatMaterial([...this.xiaoyiConversation, ...added], this.data.xiaoyiAnswer);
      this.xiaoyiConversation = [...this.xiaoyiConversation, ...added];
      for (const turn of added) xiaoyiMessagesAppend.call(this,{kind:'answer',text:turn.text,label:'加入的记忆'});
      this.setData({articleMemoryOpen:false, xiaoyiOpen:true});
      this.saveArticleChat();
      await this.organizeXiaoyiAnswer();
    } catch (error) {
      if (!this.unloaded && key === this.articleChatKey()) this.setData({articleMemoryNotice:error instanceof Error ? error.message : '暂时没能加入，请重试。'});
    } finally {if (!this.unloaded && key === this.articleChatKey()) this.setData({articleMemoryLoading:false});}
  },
  articleChatLoadedKey: '',
  articleChatSelection: '',
  articleChatModuleId: '',
  async onArticleModuleSelected(event: { detail: { id: string } }) {
    const chapter = this.articlePending || this.data.article;
    if (!chapter || this.unloaded || this.data.writingMode !== 'creative') return;
    const module = chapter.layout.pages.flatMap(page => page.modules).find(item => item.id === event.detail.id);
    if (!module) return;
    const key = this.xiaoyiContextKey() + ':' + module.id;
    const repeated = this.articleChatSelection === key;
    this.articleChatSelection = key;
    this.articleChatModuleId = module.id;
    this.setData({ xiaoyiSelectionLabel: module.kind === 'image' ? '已定位到当前图片' : '已定位到当前文字' });
    if (!this.data.xiaoyiOpen) return;
    await this.openXiaoyi();
    if (repeated || this.unloaded || this.articleChatSelection !== key || !this.data.xiaoyiOpen) return;
    const excerpt = this.xiaoyiContextText().trim().replace(/\s+/g, ' ').slice(0, 18);
    const reply = module.kind === 'image' ? (excerpt ? '这张图和“' + excerpt + '”，有什么故事？' : '这张图片让你想起了什么？')
      : excerpt ? '关于“' + excerpt + '”，你还想补充哪一点？' : '这里想记下什么？零散的想法也可以。';
    this.xiaoyiMessagesAppend({ kind: 'question', text: reply });
    this.xiaoyiConversation = [...this.xiaoyiConversation, { role: 'assistant', text: reply }];
    this.saveArticleChat();
  },
  articleChatKey() { return `article-chat:${cachedAccountScope()}:${this.xiaoyiContextKey()}`; },
  saveArticleChat() {
    if(!this.articleChatLoadedKey) return;
    try { wx.setStorageSync(this.articleChatLoadedKey, {messages:this.data.xiaoyiMessages,answer:this.data.xiaoyiAnswer,
      draft:this.data.xiaoyiDraftText,instruction:this.data.xiaoyiWritingInstruction,conversation:this.xiaoyiConversation,
      dimensions:this.xiaoyiAskedDimensions,photos:this.data.articleChatPhotos,memory:this.articleChatMemory}); }
    catch { this.setData({xiaoyiStatus:'本机空间不足，对话还在当前页面，请先复制保存。'}); }
  },
  releaseArticleChat() {
    this.saveArticleChat();
    this.articleChatLoadedKey = '';
    this.articleChatMemory = undefined;
    this.articleChatSelection = '';
    this.articleChatModuleId = '';
    this.setData({xiaoyiSelectionLabel: '已定位到当前文章'});
    this.setData({articleChatPhotos: [], articleMemoryOpen:false, articleMemoryLoading:false, articleMemoryRows:[]});
  },
  restoreArticleChat() {
    const key=this.articleChatKey();if(key===this.articleChatLoadedKey)return;
    this.saveArticleChat();
    const saved=wx.getStorageSync(key);
    resetXiaoyiPanel.call(this);
    this.articleChatLoadedKey=key;
    this.articleChatMemory=saved?.memory;
    this.setData({xiaoyiMessages:saved?.messages || [],xiaoyiAnswer:saved?.answer || '',xiaoyiDraftText:saved?.draft || '',
      xiaoyiWritingInstruction:saved?.instruction || '',articleChatPhotos:saved?.photos || []});
    this.xiaoyiConversation=saved?.conversation || [];this.xiaoyiAskedDimensions=saved?.dimensions || [];
  },
  articleChatMemory: undefined as { key: string; memory: MemoryContribution; saved: boolean; imageRequestId?: string } | undefined,
  articleChatMaterial() { return articleChatMaterial(this.xiaoyiConversation, this.data.xiaoyiAnswer); },
  recordArticleChatInput() {
    const text = this.data.xiaoyiAnswer.trim();
    const last = this.xiaoyiConversation.filter(turn => turn.role === 'user').slice(-1)[0];
    if (text && last?.text !== text) {
      this.xiaoyiConversation = [...this.xiaoyiConversation, {role:'user', text}];
      xiaoyiMessagesAppend.call(this, {kind:'answer', text});
    }
    this.saveArticleChat();
  },
  async saveArticleChatMemory() {
    const transcript = this.articleChatMaterial();
    const photoIds = this.data.articleChatPhotos.map(photo => photo.id);
    if (!transcript.length && !photoIds.length) throw new Error('先和小忆说点什么，或添加一张照片。');
    const key = JSON.stringify([this.articleChatKey(), transcript, photoIds]);
    const chatKey = this.articleChatKey();
    let pending = this.articleChatMemory;
    if (!pending || pending.key !== key) {
      const state = await loadRoomStateRemoteFirst();
      if (this.unloaded || this.articleChatKey() !== chatKey) throw new Error('已切换章节，素材仍保留。');
      const author = accountOwner(state.members);
      if (!author) throw new Error('请先创建自己的记录档案');
      const input = {authorMemberId:author.id, authorName:author.name, relation:author.relation,
        text:transcript[0] || '', title:transcript[0]?.slice(0,20) || '对话中的照片',
        memoryType:'note' as const, scope:'personal' as const, visibility:'private' as const,
        sharedWithMemberIds:[], photoIds};
      const memory = transcript.length ? createContributionFromSegments(input, transcript, 'note') : createContribution(input);
      pending = {key, memory, saved:false};
      this.articleChatMemory = pending;
      this.saveArticleChat();
    }
    if (!pending.saved) {
      if (photoIds.length) await ensurePhotoUploads(photoIds);
      await appendContributionRemoteFirst(pending.memory);
      pending.saved = true;
      if (!this.unloaded && this.articleChatKey() === chatKey) this.saveArticleChat();
    }
    return pending.memory;
  },
  async rememberXiaoyiAnswer() {
    if (this.data.xiaoyiLoading) return;
    const key = this.articleChatKey();
    this.setData({xiaoyiLoading:true, xiaoyiStatus:'正在存为记忆…'});
    try {
      this.recordArticleChatInput();
      await this.saveArticleChatMemory();
      if (!this.unloaded && key === this.articleChatKey()) this.setData({xiaoyiStatus:'已存为私有记忆，可以在记忆中找到，之后放进其他文章。'});
    } catch(error) {
      if (!this.unloaded && key === this.articleChatKey()) this.setData({xiaoyiStatus:error instanceof Error ? error.message : '没有保存成功，素材仍保留。'});
    } finally { if (!this.unloaded && key === this.articleChatKey()) { this.setData({xiaoyiLoading:false}); this.saveArticleChat(); } }
  },
  async addXiaoyiPhoto() {
    if(this.data.xiaoyiLoading)return;
    const key=this.articleChatLoadedKey;
    try {
      const result=await new Promise<WechatMiniprogram.ChooseMediaSuccessCallbackResult>((resolve,reject)=>wx.chooseMedia({count:1,mediaType:['image'],sizeType:['compressed'],success:resolve,fail:reject}));
      if(!result.tempFiles[0] || this.unloaded || key!==this.articleChatLoadedKey)return;
      const photo=await saveLocalPhoto(result.tempFiles[0].tempFilePath);
      if (this.unloaded || key !== this.articleChatLoadedKey) return;
      this.setData({articleChatPhotos:[...this.data.articleChatPhotos,photo]});
      xiaoyiMessagesAppend.call(this,{kind:'status',text:'添加了一张图片，原图已保留。'});this.saveArticleChat();
    } catch(error) { if (!this.unloaded && key === this.articleChatLoadedKey) this.setData({xiaoyiStatus:error instanceof Error?error.message:'这次没有添加图片'}); }
  },
  async describeXiaoyiPhotos() {
    if(this.data.xiaoyiLoading || !this.data.articleChatPhotos.length)return;
    const key=this.articleChatLoadedKey;this.setData({xiaoyiLoading:true});
    try {
      const ids=this.data.articleChatPhotos.slice(-3).map(photo=>photo.id);
      await ensurePhotoUploads(ids);
      const result=await storyImageApi.captionPhotos({photoIds:ids});
      if(this.unloaded || key!==this.articleChatLoadedKey)return;
      if(!result.aiGenerated || !result.caption)throw new Error(result.message || '这次没有整理出文字，图片仍保留。');
      this.xiaoyiConversation = [...this.xiaoyiConversation, {role:'assistant',text:'图片整理（AI生成）：' + result.caption}];
      this.setData({xiaoyiDraftText:result.caption,xiaoyiStatus:'这是图片整理稿，确认后再放进文章。'});
      xiaoyiMessagesAppend.call(this,{kind:'draft',text:result.caption,label:'看图整理 · AI生成'});
    } catch(error){if (!this.unloaded && key === this.articleChatLoadedKey) this.setData({xiaoyiStatus:error instanceof Error?error.message:'看图整理暂时失败'});}
    finally {if (!this.unloaded && key === this.articleChatLoadedKey) {this.setData({xiaoyiLoading:false});this.saveArticleChat();}}
  },
  async illustrateXiaoyiText() {
    if (this.data.xiaoyiLoading) return;
    const key = this.articleChatKey();
    this.setData({xiaoyiLoading:true, xiaoyiStatus:'正在保留对话素材并生成配图…'});
    try {
      this.recordArticleChatInput();
      const memory = await this.saveArticleChatMemory();
      if (this.unloaded || key !== this.articleChatKey()) return;
      if (memory.text.length > 500) throw new Error('这段对话已完整存为记忆。当前配图服务最多读取 500 字，暂未开始生成。');
      const source = this.articleChatMemory!;
      source.imageRequestId ||= newImageRequestId();
      this.saveArticleChat();
      await storyImageApi.submitChapterImage({memoryId:memory.id, chapterId:'memory', purpose:'illustration', requestId:source.imageRequestId});
      if (this.unloaded || key !== this.articleChatKey()) return;
      this.setData({xiaoyiStatus:'配图已开始，原始对话已保留为私有记忆。'});
      await new Promise<void>((resolve,reject) => wx.navigateTo({url:'/pages/story-images/story-images?memoryId='+encodeURIComponent(memory.id),success:()=>resolve(),fail:reject}));
    } catch(error) {
      if (!this.unloaded && key === this.articleChatKey()) this.setData({xiaoyiStatus:error instanceof Error ? error.message : '配图暂未完成，对话素材仍保留。'});
    } finally { if (!this.unloaded && key === this.articleChatKey()) { this.setData({xiaoyiLoading:false}); this.saveArticleChat(); } }
  },
  openXiaoyi() {
    if (this.data.writingMode !== "creative") return;
    if ((this.data.protectedCopy && !this.data.article) || this.data.view !== "chapter" || this.data.panel || this.data.saving || this.data.generating) return;
    if (this.data.article) this.restoreArticleChat();
    this.setData({ xiaoyiOpen: true, xiaoyiAnswer: this.data.xiaoyiAnswer, xiaoyiDraftText: this.data.xiaoyiDraftText, xiaoyiWritingInstruction: this.data.xiaoyiWritingInstruction, moreOpen: false, xiaoyiStatus: "", xiaoyiContextPreview: "正在读取当前正文…" });
    this.xiaoyiCapturePending = this.captureXiaoyiContext();
    return this.xiaoyiCapturePending;
  },
  closeXiaoyi() {
    if (this.data.article) { this.saveArticleChat(); this.setData({xiaoyiOpen:false}); return; }
    this.xiaoyiCaptureId++;
    this.xiaoyiContextCapturedText = "";
    this.xiaoyiLineContext = "";
    this.xiaoyiLinePosition = null;
    resetXiaoyiPanel.call(this);
  },
  async captureXiaoyiContext() {
    const captureId = ++this.xiaoyiCaptureId;
    const key = this.xiaoyiContextKey();
    this.xiaoyiCapturedKey = key;
    const sequence = this.editSequence;
    this.xiaoyiCapturedSequence = sequence;
    const ctx = this.editorContext;
    this.xiaoyiContextCapturedText = "";
    this.xiaoyiLineContext = "";
    this.xiaoyiLinePosition = null;
    const current = () => captureId === this.xiaoyiCaptureId && key === this.xiaoyiContextKey()
      && sequence === this.editSequence && ctx === this.editorContext
      && !this.unloaded && this.data.xiaoyiOpen && this.data.view === "chapter";
    let plain = this.data.article ? this.xiaoyiContextText() : this.bodyBuffer || plainText(this.contentBuffer);
    let selected = "";
    let index: number | null = null;
    if (!this.data.article && ctx && this.data.editorReady) {
      // Snapshot native text/selection together. Never collect into a different chapter's buffers.
      const [contents, selection, range] = await Promise.all([
        new Promise<WechatMiniprogram.GetContentsSuccessCallbackResult | null>(resolve =>
          typeof ctx.getContents === "function" ? ctx.getContents({ success: resolve, fail: () => resolve(null) }) : resolve(null)).catch(() => null),
        new Promise<string>(resolve => ctx.getSelectionText({
          success: result => resolve(String(result.text ?? "")), fail: () => resolve(""),
        })).catch(() => ""),
        LINE_CONTEXT_CHAT_ENABLED && typeof ctx.getSelection === "function"
          ? new Promise<number | null>(resolve => ctx.getSelection({
              success: result => resolve(result.range?.index ?? null), fail: () => resolve(null),
            })).catch(() => null) : Promise.resolve(null),
      ]);
      if (!current()) return;
      selected = selection.trim();
      if (contents) {
        // Use native text rather than concatenated text blocks: image offsets and newline offsets differ.
        if (typeof contents.text === "string") plain = contents.text;
        const ops = (contents.delta as { ops?: Array<{ insert?: unknown }> })?.ops;
        const hasEmbed = !Array.isArray(ops) || ops.some(op => typeof op.insert !== "string");
        if (LINE_CONTEXT_CHAT_ENABLED) {
          if (typeof contents.text === "string" && !hasEmbed && range !== null && (!selected || plain.slice(range, range + selection.length) === selection)) {
            index = lineIndexFromRange(plain, range);
          } else if (selected) index = lineIndexFromSelection(plain, selected);
        }
      }
    }
    if (!current()) return;
    if (selected.length > 1000) {
      wx.showToast({ title: "选中的内容有点长，请少选一些", icon: "none" });
      this.setData({ xiaoyiContextPreview: "请少选一些，再点小忆。" });
      return;
    }
    const text = selected || plain.trim();
    this.xiaoyiContextCapturedText = text;
    if (LINE_CONTEXT_CHAT_ENABLED) {
      this.xiaoyiLineContext = lineContextText(plain, index, this.chapters.map(chapter => chapter.title));
      const lines = splitLines(plain);
      const saved = this.chapters.find(chapter => chapter.id === this.activeChapterId)?.content.filter(item => item.text?.trim()) ?? [];
      // Consume existing ids only when canonical one-line blocks exactly match the native snapshot.
      // Unsaved/legacy positions are explicitly ephemeral; 04 owns persistence and reconciliation.
      const matches = saved.length === lines.length && saved.every((item, i) => item.blockId && item.text === lines[i]);
      this.xiaoyiLinePosition = linePosition(this.activeChapterId, lines.map((text, i) => ({ id: matches ? saved[i].blockId! : `snapshot-line-${i}`, text })), index);
    }
    this.setData({ xiaoyiContextPreview: this.data.article && this.data.protectedCopy ? "只整理你接下来提供的想法和图片，保留原文。" : text ? (text.length > 120 ? text.slice(0, 120) + "…" : text) : "这一章还没有正文，小忆会先从你接下来要说的话问起。" });
  },
  /** 就地小忆共享机制要读的场景参数：故事名与是否走客观记录模式。 */
  xiaoyiConfig(): XiaoyiConfig {
    return {
      memoryType: "memoir",
      storyTitle: [this.data.editTitle, this.data.editChapterTitle].filter(Boolean).join(" · "),
      // Article chat already sends its explicit live sourceText. The legacy saved-book
      // context reader rejects modern blockIds and must not reload this manuscript.
      storyId: this.data.writingMode === "objective" || this.data.article ? undefined : this.data.storyId,
      mode: "personal",
    };
  },
  /** 就地小忆共享机制要读的当前文本：选区优先，否则当前章节正文。 */
  xiaoyiContextText() {
    if (this.data.article && this.data.protectedCopy) return "";
    if (this.data.article && this.articleChatModuleId) {
      const chapter = this.articlePending || this.data.article;
      const modules = chapter.layout.pages.flatMap(page => page.modules);
      const index = modules.findIndex(module => module.id === this.articleChatModuleId);
      const module = modules[index];
      if (!module) return '';
      // Resolve live text on each action, including edits made after the initial tap.
      if (module.kind === 'text') return 'blockId' in module.bind
        ? chapter.content.find(block => block.blockId === ('blockId' in module.bind ? module.bind.blockId : ''))?.text || '' : chapter.title;
      // Nearby text gives an image a conversation anchor; it is not a vision description.
      const nearby = [...modules.slice(0, index).reverse(), ...modules.slice(index + 1)]
        .find(item => item.kind === 'text' && 'blockId' in item.bind);
      return nearby?.kind === 'text' && 'blockId' in nearby.bind
        ? chapter.content.find(block => block.blockId === ('blockId' in nearby.bind ? nearby.bind.blockId : ''))?.text || '' : '';
    }
    if(this.data.article) return (this.articlePending || this.data.article).content.map(block=>block.text || "").join("\n");
    if (this.xiaoyiCapturedKey !== this.xiaoyiContextKey() || this.xiaoyiCapturedSequence !== this.editSequence) {
      this.xiaoyiLineContext = "";
      this.xiaoyiLinePosition = null;
      return this.bodyBuffer || plainText(this.contentBuffer);
    }
    const base = this.xiaoyiContextCapturedText || this.bodyBuffer || plainText(this.contentBuffer);
    return LINE_CONTEXT_CHAT_ENABLED && this.xiaoyiLineContext ? this.xiaoyiLineContext : base;
  },
  xiaoyiContextKey() { return [this.data.storyId, this.data.memberId, this.activeChapterId].join(":"); },
  xiaoyiMessagesAppend,
  async askXiaoyiQuestion() {
    const key = this.xiaoyiContextKey();
    const captureId = this.xiaoyiCaptureId;
    await this.xiaoyiCapturePending;
    if (this.unloaded || !this.data.xiaoyiOpen || key !== this.xiaoyiContextKey() || captureId !== this.xiaoyiCaptureId) return;
    try { return await askXiaoyiQuestion.call(this); } finally { this.saveArticleChat(); }
  },
  onXiaoyiAnswerInput(event: {detail:{value:string}}) { onXiaoyiAnswerInput.call(this,event); this.saveArticleChat(); },
  onXiaoyiDraftInput(event: {detail:{value:string}}) { onXiaoyiDraftInput.call(this,event); this.saveArticleChat(); },
  onXiaoyiWritingInstruction(event: {detail:{value:string}}) { onXiaoyiWritingInstruction.call(this,event); this.saveArticleChat(); },
  async useXiaoyiOriginal() { await useXiaoyiOriginal.call(this); this.saveArticleChat(); },
  async organizeXiaoyiAnswer(event?: Parameters<typeof organizeXiaoyiAnswer>[0]) {
    if (this.data.article) {
      if (this.data.xiaoyiLoading) return;
      const key = this.articleChatKey();
      this.setData({xiaoyiLoading:true, xiaoyiStatus:'正在把你的对话整理成文…'});
      try {
        const transcript = this.articleChatMaterial();
        if (!transcript.length) throw new Error('先和小忆说点什么，再整理成文。');
        this.recordArticleChatInput();
        const draft = await organizeInlineAnswer({answer:'', transcript, memoryType:'note', writingMode:'compose',
          basisText:this.data.protectedCopy ? '' : (this.articlePending || this.data.article).content.map(block => block.text || '').join('\n').slice(-500),
          conversation:(this.data.xiaoyiDraftText.match(/[\s\S]{1,500}/g) || []).map(content => ({role:'assistant' as const,content})),
          writingInstruction:'根据所选记忆和对话生成一段文字，结合已有正文自然衔接。已有草稿时按用户最新要求修改草稿。修改要求是指令，不写进故事。不重复或改写正文，保留虚构标记，不补造事实。'});
        if (this.unloaded || key !== this.articleChatKey()) return;
        if (!draft) throw new Error('这次没有整理成功，对话还在，可以重试。');
        this.setData({xiaoyiDraftText:draft.body, xiaoyiStatus:'整理好了，可以修改，满意后放进文章。'});
        xiaoyiMessagesAppend.call(this,{kind:'draft',text:draft.body,label:'对话整理 · AI生成'});
      } catch(error) {
        if (!this.unloaded && key === this.articleChatKey()) this.setData({xiaoyiStatus:error instanceof Error ? error.message : '整理失败，对话仍保留。'});
      } finally { if (!this.unloaded && key === this.articleChatKey()) {this.setData({xiaoyiLoading:false});this.saveArticleChat();} }
      return;
    }
    const key = this.xiaoyiContextKey();
    const captureId = this.xiaoyiCaptureId;
    await this.xiaoyiCapturePending;
    if (this.unloaded || !this.data.xiaoyiOpen || key !== this.xiaoyiContextKey() || captureId !== this.xiaoyiCaptureId) return;
    try { return await organizeXiaoyiAnswer.call(this, event); } finally { this.saveArticleChat(); }
  },
  async useXiaoyiDraft() {
    if(this.data.article) { if(!this.data.xiaoyiLoading && this.data.xiaoyiDraftText.trim()) await this.xiaoyiLand(this.data.xiaoyiDraftText,'organized'); }
    else await useXiaoyiDraft.call(this);
    this.saveArticleChat();
  },
  /** 就地小忆共享机制的落回目标：本章的待确认新增，接受后才写入正文。 */
  async xiaoyiLand(text: string, kind: XiaoyiLandKind): Promise<boolean> {
    if (this.data.article) {
      if (this.data.xiaoyiLoading || !text.trim()) return false;
      const chapter=appendArticleText(this.articlePending || this.data.article,text);
      this.onArticleChange({detail:{chapter}});
      const ok=await this.flushArticle();
      this.setData({xiaoyiStatus:ok?'已放进文章，原来的文字保留。':'文字已保存在本机草稿，请处理保存提示。'});
      this.saveArticleChat();return ok;
    }
    const label = kind === "spoken" ? "小忆：原话待确认" : "小忆：整理稿待确认";
    if (!this.activeChapterId || this.data.protectedCopy || this.data.saving) return false;
    try {
      await this.collectEditor();
      const liveChapters = updateChapter(this.chapters, this.activeChapterId, { title: this.chapterTitleBuffer, content: this.contentBuffer });
      const chapters = proposeInlineXiaoyiInsert(liveChapters, this.activeChapterId, text);
      const draft = draftWithChapters({ ...(this.data.draft ?? this.newBookBase()), title: this.titleBuffer }, chapters);
      const ok = await this.persist(draft, this.sourceFingerprint, "draft", label);
      if (ok) {
        this.setData({ xiaoyiAnswer: "", xiaoyiDraftText: "", xiaoyiStatus: "已放到本章的待确认修改里，点“收下”才会写入正文。", ...this.chapterData() });
      }
      return ok;
    } catch (error) {
      this.setData({ xiaoyiStatus: error instanceof Error ? error.message : "暂时没放进去，请重试" });
      return false;
    }
  },
  openXiaoyiMemories() {
    if (this.data.xiaoyiLoading) return;
    this.setData({ xiaoyiOpen: false });
    this.selectTool({ currentTarget: { dataset: { action: "memories" } } });
  },
  async decidePendingEdit(event: { currentTarget: { dataset: { id: string; decision: string } } }) {
    const id = event.currentTarget.dataset.id;
    const decision = event.currentTarget.dataset.decision === "accept" ? "accept" : "reject";
    if (!id || !this.activeChapterId || this.data.saving) return;
    const chapters = resolvePendingEdit(this.chapters, this.activeChapterId, id, decision);
    if (await this.persist(draftWithChapters(this.data.draft ?? this.newBookBase(), chapters), this.sourceFingerprint, "draft", decision === "accept" ? "收下小忆待确认文字" : "不要小忆待确认文字")) {
      this.setData({ ...this.chapterData() });
    }
  },
  async finishPendingEdits() {
    const active = this.chapters.find(chapter => chapter.id === this.activeChapterId);
    if (!active || !pendingRevisionResolved(active) || this.data.saving) return;
    try {
      const chapters = finalizePendingRevision(this.chapters, this.activeChapterId);
      if (await this.persist(draftWithChapters(this.data.draft ?? this.newBookBase(), chapters), this.sourceFingerprint, "draft", "确认小忆写入正文")) {
        this.setData({ saveNotice: "已按你的选择写入正文。", ...this.chapterData() });
      }
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "还有没确认的修改" });
    }
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
          success: result => { if (result.confirm) wx.navigateTo({ url: "/pages/room/room" }); },
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
  bufferedDraft(): BiographyDraft | undefined {
    if (!this.data.draft) return undefined;
    const chapters = this.data.view === "chapter" && this.activeChapterId
      ? updateChapter(this.chapters, this.activeChapterId, {title:this.chapterTitleBuffer, content:this.contentBuffer})
      : this.chapters;
    return draftWithChapters({...this.data.draft, title:this.titleBuffer, introduction:this.introductionBuffer}, chapters);
  },
  backupEdits(view?: "chapter" | "contents"): boolean {
    if (this.data.protectedCopy) return false;
    try {
      const existing = this.localDraftKey ? readChapterDraft(this.localDraftKey) : undefined;
      if (existing && existing.token !== this.localDraftToken) throw new Error("另一编辑页已有更新草稿");
      const draft = this.bufferedDraft();
      if (!draft) return false;
      const backup = writeChapterDraft(this.localDraftKey, {
        draft, chapterId:this.activeChapterId, view:view ?? (this.data.view === "chapter" ? "chapter" : "contents"),
        revisionId:this.revisionId, storyVersion:this.story?.version, fingerprint:this.sourceFingerprint,
        ...(this.pendingSave ? {pendingSave:this.pendingSave} : {}),
        ...(this.editorError ? {editorError:this.editorError} : {}),
      });
      this.localDraftToken = backup.token;
      return true;
    } catch {
      this.setData({saveNotice:"本机草稿保存失败，请勿退出；请点保存重试或复制正文备份。"});
      return false;
    }
  },
  editManuscript() {
    if (this.data.protectedCopy || !this.data.draft || this.data.generating) return;
    this.editSequence++;
    const backedUp = this.backupEdits();
    const saveNotice = backedUp ? "草稿已留在本机，退出编辑时自动保存到故事。" : this.data.saveNotice;
    if (!this.data.editing || this.data.saveNotice !== saveNotice) this.setData({editing:true,saveNotice});
    wx.enableAlertBeforeUnload({message:backedUp ? "草稿已留在本机，尚未确认保存到故事。" : "草稿备份失败，请取消退出，先保存或复制正文。"});
  },
  onEditTitle(event: WechatMiniprogram.Input) { this.titleBuffer = event.detail.value; this.editManuscript(); },
  editIntroduction() {
    if (this.data.protectedCopy || this.data.view !== "contents" || !this.data.draft) return;
    this.introductionBuffer = this.data.bookIntroduction;
    this.setData({ editIntroduction: this.introductionBuffer });
    this.editManuscript();
  },
  onEditIntroduction(event: WechatMiniprogram.Input) {
    this.introductionBuffer = event.detail.value;
    this.editSequence++;
    this.setData({ editIntroduction: event.detail.value });
    this.editManuscript();
  },
  onEditChapterTitle(event: WechatMiniprogram.Input) { this.chapterTitleBuffer = event.detail.value; this.editManuscript(); },
  copyCurrentDraft() {
    wx.setClipboardData({data:this.chapterTitleBuffer + "\n\n" + this.bodyBuffer});
  },
  cancelEdit() {
    if (this.data.saving) return;
    wx.showModal({ title: "放弃未保存的修改？", content: "已保存的书稿和历史版本不会改变。", success: result => {
      if (result.confirm) {
        try { if (this.localDraftKey) clearChapterDraft(this.localDraftKey, this.localDraftToken); }
        catch { this.setData({saveNotice:"无法清除本次草稿，已保留，请稍后重试。"}); return; }
        this.localDraftToken = "";
        this.editorError = "";
        this.pendingSave = undefined;
        this.titleBuffer = this.data.draft?.title ?? "";
        this.introductionBuffer = this.data.draft?.introduction ?? this.data.bookIntroduction;
        this.loadActiveChapter();
        this.editorContext = undefined;
        // Explicit discard remounts native fields, even if the original bound value is unchanged.
        this.setData({
          editing: false, editTitle: this.titleBuffer, editIntroduction: this.introductionBuffer, editBody: this.bodyBuffer, editChapterTitle: this.chapterTitleBuffer,
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
      this.setData({ editing: false });
      try { await this.refresh(state); }
      catch (error) {
        logServiceFailure('storyBooks', 'refresh', error);
        throw new SavedRefreshError(this.pendingSave.id);
      }
      this.pendingSave = undefined;
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
      title: next === "creative" ? "切换为 AI 创作？" : "切换为自己写？",
      content: "AI 创作会显示小鸟，自己写会收起小鸟。已有文字保留。",
      success: async result => {
        if (!result.confirm) return;
        try {
          const state = await updateStoryBook(story, { writingMode: next });
          if (next === "objective") this.closeXiaoyi();
          await this.refresh(state);
          this.setData({ saveNotice: next === "creative" ? "已切换为 AI 创作" : "已切换为自己写" });
        } catch (error) { this.setData({ saveNotice: error instanceof Error ? error.message : "切换失败，请重试" }); }
      },
    });
  },
  confirm(title: string, content: string) {
    return new Promise<boolean>(resolve => wx.showModal({ title, content, success: result => resolve(result.confirm), fail: () => resolve(false) }));
  },
  saveEdits(bufferOnly: unknown = false): Promise<boolean> {
    if (this.editSave) return this.editSave;
    const task = this.saveBufferedEdits(bufferOnly === true);
    this.editSave = task;
    void task.finally(() => { if (this.editSave === task) this.editSave = undefined; });
    return task;
  },
  async saveBufferedEdits(bufferOnly: boolean): Promise<boolean> {
    if (this.data.protectedCopy || !this.data.draft || this.data.saving || this.data.pickingPhoto || this.collecting) return false;
    if (!this.data.editing) return true;
    this.collecting = true;
    try {
      if (!bufferOnly && this.data.view === "chapter") await this.collectEditor();
      this.backupEdits();
      if (this.editorError) throw new Error(this.editorError);
      validateContent(this.contentBuffer);
      if (!this.titleBuffer.trim()) throw new Error("请填写书稿标题；正文草稿已保留");
    } catch (error) {
      this.setData({saveNotice:error instanceof Error ? error.message : "无法读取正文；草稿已保留"});
      return false;
    } finally { this.collecting = false; }
    const sequence = this.editSequence;
    const draft = this.bufferedDraft()!;
    const key = this.localDraftKey;
    this.setData({saving:true});
    try {
      // Retry an uncertain previous write with its original id before saving newer input.
      if (!this.pendingSave) {
        this.pendingSave = makeRevision(this.data.memberId, draft, this.sourceFingerprint, "draft", "编辑存档");
        this.pendingSave.storyId = this.data.storyId;
        this.pendingSave.expectedStoryVersion = this.story?.version;
        this.pendingSave.sourceRevisionId = this.revisionId || undefined;
      }
      this.backupEdits();
      const pending = this.pendingSave;
      const state = await saveManuscriptRevision(pending, this.revisionId);
      const current = currentManuscript(state, this.data.storyId || this.data.memberId);
      if (current.revisionId !== pending.id) throw new Error("故事已有更新版本，本机草稿已保留，请先核对新版");
      this.revisionId = current.revisionId;
      this.story = this.data.storyId ? activeStory(state,this.data.storyId) : undefined;
      this.rememberSendSnapshot(state);
      this.pendingSave = undefined;
      const unchanged = sequence === this.editSequence && JSON.stringify(draft) === JSON.stringify(pending.draft);
      // A retried request can acknowledge an older snapshot. Keep the working
      // book (including edits in other chapters) until the newer draft is saved.
      this.chapters = chaptersOf(unchanged ? current.draft! : draft, current.sourceFingerprint);
      this.setData({draft:current.draft!, savedRevisionId:current.revisionId, history:manuscriptHistory(state,this.data.storyId || this.data.memberId), canUndo:false});
      if (unchanged) {
        clearChapterDraft(key,this.localDraftToken);
        this.localDraftToken = "";
        this.setData({editing:false,saveNotice:"修改已保存", ...this.chapterData()});
        wx.disableAlertBeforeUnload();
      } else {
        this.backupEdits();
        this.setData({saveNotice:"先前文字已保存，新增文字已留在本机；退出时继续保存。"});
      }
      return unchanged;
    } catch (error) {
      const retained = this.backupEdits();
      this.setData({saveNotice:(error instanceof Error ? error.message : "暂未确认保存") + (retained
        ? (error instanceof SavedRefreshError ? "本机草稿也已保留。" : "；草稿已保留在本机，请重试。")
        : "；本机备份也失败，请勿退出，先复制正文。")});
      return false;
    } finally { this.setData({saving:false}); }
  },
  /** 朋友的回信：后台读取，失败当作没有；读到后只补一次目录标注和本章回信。 */
  async loadReturns(refreshId: number) {
    const story = this.story;
    if (!story || story.sourcePolicyRequired === true) { if (this.pendingReturns.length) { this.pendingReturns = []; this.setData(this.chapterData()); } return; }
    const returns = await loadPendingReturns();
    if (this.unloaded || refreshId !== this.refreshId || this.story?.id !== story.id) return;
    const changed = returns.length !== this.pendingReturns.length || returns.some((item, index) => item.returnId !== this.pendingReturns[index]?.returnId);
    this.pendingReturns = returns;
    if (changed) this.setData(this.chapterData());
  },
  /** 谁改了本章的哪几段：只有自己的书、且本章有人改过时才去读，失败就不显示。 */
  async loadChapterChanges() {
    const story = this.story, chapterId = this.activeChapterId;
    if (!story || story.sourcePolicyRequired === true || !chapterId) { this.setData({ chapterChanges: [], changesOpen: false }); return; }
    const key = story.id + ":" + chapterId + ":" + story.currentRevisionId;
    let changes = this.chapterChangeCache[key];
    if (!changes) {
      try {
        const familyId = this.ownFamilyId || (await storySharing.capabilities()).familyId || "";
        if (!familyId) return;
        this.ownFamilyId = familyId;
        changes = (await storySharing.chapterChanges(familyId, story.id, chapterId)).changes;
      } catch { changes = []; }
      this.chapterChangeCache[key] = changes;
    }
    if (this.unloaded || this.activeChapterId !== chapterId || this.story?.id !== story.id ||
        this.story?.currentRevisionId !== story.currentRevisionId) return;
    this.setData({ changesOpen: false, chapterChanges: changes.map(change => ({
      revisionId: change.revisionId, by: change.by, when: change.savedAt.slice(0, 10),
      titleChange: change.title ? "标题：" + change.title.before + " → " + change.title.after : "", blocks: change.blocks,
    })) });
  },
  toggleChanges() { this.setData({ changesOpen: !this.data.changesOpen }); },
  /** 收下或不要一封回信。收下会在本章末尾生成新版本，旧版本仍保留。 */
  async decideChapterReturn(event: { currentTarget: { dataset: { id: string; decision: string } } }) {
    const { id, decision } = event.currentTarget.dataset;
    if (this.data.decidingReturn || (decision !== "accept" && decision !== "reject")) return;
    const item = this.pendingReturns.find(value => value.returnId === id);
    if (!item) return;
    const key = id + ":" + decision;
    if (!this.returnDecisionRequests[key]) this.returnDecisionRequests[key] = copyRequestId().replace(/^receive-/, "decision-");
    this.setData({ decidingReturn: true, saveNotice: "" });
    try {
      await storyCopies.decideReturn({ returnId: id, decision, requestId: this.returnDecisionRequests[key] });
      delete this.returnDecisionRequests[key];
      invalidatePendingReturns();
      this.pendingReturns = this.pendingReturns.filter(value => value.returnId !== id);
      const acceptedNotice = item.sourceEdits?.length
        ? `${senderLabel(item)}的原文修改已采用${item.blocks.length ? "，新增经历也已收进本章" : ""}`
        : senderLabel(item) + "的回信已收进本章末尾";
      this.setData({ saveNotice: decision === "accept" ? acceptedNotice : "已选择不收这封回信" });
      if (decision === "accept") await this.refresh();
      else this.setData(this.chapterData());
    } catch (error) {
      this.setData({ saveNotice: (error instanceof Error ? error.message : "操作没有完成") + "，可以直接重试" });
    } finally { this.setData({ decidingReturn: false }); }
  },
  openAppendOwn() {
    if (!this.data.protectedCopy || this.data.view !== "chapter" || !this.activeChapterId) return;
    this.setData({ panel: "append-own", moreOpen: false, saveNotice: "" });
  },
  openProtectedRevision() {
    if (!CHAPTER_PACKAGE_ENABLED || !this.data.protectedCopy || this.data.view !== "chapter") return;
    const chapter = this.chapters.find(item => item.id === this.activeChapterId);
    if (!chapter) return;
    const rows = chapter.content.flatMap(item => typeof item.text === "string" && item.sourceIds?.length && item.blockId
      ? [{ blockId: item.blockId, text: item.text.replace(/\n$/, "") }] : []);
    if (!rows.length) { this.setData({ saveNotice: "这章没有可修订的来源原文" }); return; }
    const layout = chapter.layout ? JSON.parse(JSON.stringify(chapter.layout)) as PackageLayout : null;
    this.protectedRevisionAttempt = undefined;
    this.setData({ panel: "source-revision", moreOpen: false, saveNotice: "", protectedRevisionRows: rows,
      protectedRevisionLayout: layout,
      protectedLayoutRows: (layout?.pages ?? []).flatMap((page, pageIndex) => page.modules.map((module, moduleIndex) => ({
        pageIndex, moduleIndex, id: module.id, kind: module.kind === "image" ? "图片" : "文字", x: module.rect.x, y: module.rect.y,
      }))) });
  },
  onProtectedRevisionInput(event: WechatMiniprogram.Input) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isSafeInteger(index) || !this.data.protectedRevisionRows[index]) return;
    const rows = this.data.protectedRevisionRows.map((row, rowIndex) => rowIndex === index ? { ...row, text: event.detail.value } : row);
    this.setData({ protectedRevisionRows: rows });
  },
  nudgeProtectedLayout(event: WechatMiniprogram.TouchEvent) {
    const { page, module, dx, dy } = event.currentTarget.dataset;
    const pageIndex = Number(page), moduleIndex = Number(module), offsetX = Number(dx) || 0, offsetY = Number(dy) || 0;
    const layout = this.data.protectedRevisionLayout;
    const target = layout?.pages[pageIndex]?.modules[moduleIndex];
    if (!layout || !target) return;
    target.rect.x = Math.max(0, Math.min(900 - target.rect.width, target.rect.x + offsetX));
    target.rect.y = Math.max(0, Math.min(1200 - target.rect.height, target.rect.y + offsetY));
    this.setData({ protectedRevisionLayout: layout, protectedLayoutRows: layout.pages.flatMap((pageItem, pageNo) => pageItem.modules.map((item, moduleNo) => ({
      pageIndex: pageNo, moduleIndex: moduleNo, id: item.id, kind: item.kind === "image" ? "图片" : "文字", x: item.rect.x, y: item.rect.y,
    }))) });
  },
  async saveProtectedRevision() {
    const story = this.story, chapter = this.chapters.find(item => item.id === this.activeChapterId);
    if (!CHAPTER_PACKAGE_ENABLED || !this.data.protectedCopy || !story || !chapter || this.data.protectedRevisionSaving) return;
    if (!story.currentRevisionId || !Number.isSafeInteger(story.version)) { this.setData({ saveNotice: "故事版本信息不完整，请重新打开后再试" }); return; }
    const before = new Map(chapter.content.filter(item => typeof item.text === "string" && item.blockId).map(item => [item.blockId!, item.text as string]));
    const edits = this.data.protectedRevisionRows.flatMap(row => before.get(row.blockId)?.replace(/\n$/, "") === row.text ? [] : [{ blockId: row.blockId, text: row.text }]);
    const layout = this.data.protectedRevisionLayout;
    if (!edits.length && JSON.stringify(layout) === JSON.stringify(chapter.layout ?? null)) {
      this.setData({ panel: "", saveNotice: "没有需要保存的改动" }); return;
    }
    const request = { storyId: story.id, revisionId: story.currentRevisionId, expectedVersion: story.version as number,
      chapterId: chapter.id, edits, layout };
    const fingerprint = JSON.stringify(request);
    if (this.protectedRevisionAttempt?.fingerprint !== fingerprint)
      this.protectedRevisionAttempt = { fingerprint, requestId: chapterPackageRequestId() };
    this.setData({ protectedRevisionSaving: true, saveNotice: "" });
    try {
      const result = await chapterPackages.revise({ ...request, requestId: this.protectedRevisionAttempt.requestId });
      if (!result || result.ok !== true || result.storyId !== story.id || result.chapterId !== chapter.id || !result.revisionId ||
          (!result.alreadySaved && result.version !== story.version! + 1)) throw new Error("章节修订回执不完整，请刷新后确认结果");
      this.protectedRevisionAttempt = undefined;
      this.setData({ panel: "", saveNotice: "原文修改已保存，旧版本仍保留" });
      await this.refresh();
    } catch (error) {
      this.setData({ saveNotice: (error instanceof Error ? error.message : "原文修改未完成") + "；内容仍保留在当前编辑面板，可重试" });
    } finally { this.setData({ protectedRevisionSaving: false }); }
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
  async packageActiveChapter() {
    const chapter = this.chapters.find(item => item.id === this.activeChapterId);
    if (!CHAPTER_PACKAGE_ENABLED || !chapter) return;
    try {
      const result = await exportChapterToCloud(chapter, this.data.protagonistName, this.story?.title || "", this.data.storyId || undefined);
      this.setData({ saveNotice: "这一章已打包，章节包编号 " + result.packageId });
    } catch (error) { this.setData({ saveNotice: error instanceof Error ? error.message : "打包没有成功，请重试" }); }
  },
  activeChapterForDelivery() {
    return this.chapters.find(item => item.id === this.activeChapterId);
  },
  async openChapterDeliverySend() {
    if (!this.data.chapterDeliveryOn || (this.data.protectedCopy && !this.data.protectedHasDeliveryLineage) || this.data.view !== "chapter" || this.data.editing || this.data.panel) return;
    const chapter = this.activeChapterForDelivery();
    if (!chapter) return;
    try {
      if (!await this.finishEditing()) return;
      const { contacts } = await listChapterDeliveryContacts();
      if (!contacts.length) { this.setData({ saveNotice: "还没有可投递的已连接亲友" }); return; }
      const choice = await new Promise<number>((resolve, reject) => wx.showActionSheet({
        itemList: contacts.map(item => item.displayName), success: result => resolve(result.tapIndex), fail: reject,
      }));
      const recipient = contacts[choice];
      if (!recipient || !this.data.chapterDeliveryOn) return;
      wx.showLoading({ title: "准备章节…", mask: true });
      const result = await sendChapterDelivery(chapter, this.data.protagonistName || "我", this.story?.title || "", this.data.storyId || undefined, recipient.contactId);
      wx.hideLoading();
      this.setData({ articleStatus: `已发送给${recipient.displayName}`, saveNotice: `已投递给${recipient.displayName}` });
    } catch (error) {
      wx.hideLoading();
      const message = error instanceof Error ? error.message : String((error as { errMsg?: string })?.errMsg || "投递没有完成，请重试");
      if (!/cancel/i.test(message)) this.setData({ saveNotice: message });
    }
  },
  async openChapterDeliveryClaimLink(channel: "web" | "wechat" = "web") {
    if (!this.data.chapterDeliveryOn || (this.data.protectedCopy && !this.data.protectedHasDeliveryLineage) || this.data.view !== "chapter" || this.data.editing || this.data.panel) return;
    const chapter = this.activeChapterForDelivery();
    if (!chapter) return;
    try {
      if (!await this.finishEditing()) return;
      wx.showLoading({ title: "准备领取链接…", mask: true });
      const result = await createChapterClaimLink(chapter, this.data.protagonistName || "我", this.story?.title || "", this.data.storyId || undefined);
      wx.hideLoading();
      if (!result.claimUrl) throw new Error("这条领取链接已被使用，或已失效");
      if (channel === 'wechat') {
        this.setData({ articleShareUrl: result.claimUrl, articleShareTitle: chapter.title || this.story?.title || '一篇文章', articleShareRevision: this.revisionId, articleShareChapterId: chapter.id });
      } else {
        await new Promise<void>((resolve, reject) => wx.setClipboardData({ data: result.claimUrl!, success: () => resolve(), fail: reject }));
        this.setData({ articleStatus: '网页领取链接已复制', saveNotice: '链接已复制。发给对方，登录网页后即可领取文字和图片；每条链接限一个账号。' });
        await this.confirm('网页领取链接已复制', '发给对方后，对方登录网页即可领取这篇文章的文字和图片。每条链接限一个账号。');
      }
    } catch (error) {
      wx.hideLoading();
      const message = error instanceof Error ? error.message : String((error as { errMsg?: string })?.errMsg || "领取链接没有创建成功，请重试");
      if (!/cancel/i.test(message)) this.setData({ saveNotice: message });
    }
  },
  keepArticleShareOpen() {},
  closeArticleShare() { this.setData({ articleShareUrl: '' }); },
  async receiveSharedArticle() {
    const token = this.pendingChapterClaim;
    if (!token || this.unloaded || !this.data.chapterDeliveryOn) return;
    this.pendingChapterClaim = '';
    if (!await this.confirm('接收这篇文章？', '接收后会放进你的收件箱，原稿不会被覆盖。')) return;
    try {
      const result = await claimChapterDelivery(token, true);
      if (result.senderPreview) {
        await this.confirm("这是你发出的分享", "请让好友在自己的微信中打开卡片。你不会接收自己的文章，领取名额会为对方保留。");
        return;
      }
      await this.openChapterDeliveryInbox(result.deliveryId);
    } catch (error) { this.setData({ loadError: error instanceof Error ? error.message : '暂时无法接收，请重新打开分享卡片' }); }
  },
  async openChapterDeliveryClaim() {
    if (!this.data.chapterDeliveryOn || this.data.panel || this.data.saving || this.data.generating) return;
    try {
      const input = await new Promise<string | null>((resolve, reject) => wx.showModal({
        title: "接收网页故事", editable: true, placeholderText: "粘贴网页的领取链接",
        confirmText: "接收", success: result => resolve(result.confirm ? result.content || "" : null), fail: reject,
      }));
      if (input === null || !this.data.chapterDeliveryOn) return;
      const token = chapterClaimToken(input);
      wx.showLoading({ title: "接收故事…", mask: true });
      const result = await claimChapterDelivery(token);
      wx.hideLoading();
      await this.openChapterDeliveryInbox(result.deliveryId);
    } catch (error) {
      wx.hideLoading();
      const message = error instanceof Error ? error.message : "接收没有完成，请重试";
      if (!/cancel/i.test(message)) this.setData({ saveNotice: message });
    }
  },
  async openChapterDeliveryInbox(claimedDeliveryId?: string) {
    if (!this.data.chapterDeliveryOn || this.data.panel || this.data.saving || this.data.generating) return;
    try {
      const { items } = await listChapterDeliveryInbox();
      const pending = items.filter(item => item.status === "pending");
      if (!pending.length) { this.setData({ saveNotice: "收件箱里还没有待处理的章节" }); return; }
      const selected = claimedDeliveryId ? pending.findIndex(item => item.deliveryId === claimedDeliveryId) : await new Promise<number>((resolve, reject) => wx.showActionSheet({
        itemList: pending.map(item => `${item.kind === "return" ? "发回" : "章节"} · ${new Date(item.createdAt).toLocaleDateString()} · ${item.deliveryId.slice(0, 8)}`),
        success: result => resolve(result.tapIndex), fail: reject,
      }));
      const delivery = pending[selected];
      if (!delivery) return;
      const read = await readChapterDelivery(delivery.deliveryId);
      const chapter = read.package.chapters[0];
      const preview = chapter.blocks.flatMap(block => block.type === "text" ? [block.text] : []).join("").slice(0, 120);
      const accepted = await new Promise<boolean>((resolve, reject) => wx.showModal({
        title: `${read.package.sender.displayName} 发来的${delivery.kind === "return" ? "修改稿" : "章节"}`,
        content: `${chapter.title || read.package.storyTitle}${preview ? `\n${preview}${preview.length >= 120 ? "…" : ""}` : ""}\n\n先通过审核再导入。原稿不会被覆盖。`,
        confirmText: "选择处理", cancelText: "稍后处理", success: result => resolve(result.confirm), fail: reject,
      }));
      if (!accepted) return;
      const canAppend = Boolean(this.story && this.data.storyId && this.story.currentRevisionId && Number.isSafeInteger(this.story.version));
      const choices = ["留下成新故事", ...(canAppend ? ["加入当前故事"] : []), "不要这份"];
      const mode = await new Promise<number>((resolve, reject) => wx.showActionSheet({ itemList: choices, success: result => resolve(result.tapIndex), fail: reject }));
      if (mode === choices.length - 1) {
        await declineChapterDelivery(delivery.deliveryId);
        this.setData({ saveNotice: "已拒绝这份章节，原稿没有变化" });
        return;
      }
      const target: ImportTarget = mode === 1 && canAppend ? {
        mode: "append", storyId: this.data.storyId, expectedVersion: this.story!.version!, expectedRevisionId: this.story!.currentRevisionId!,
      } : {
        mode: "new", storyId: `story-delivery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: chapter.title || "收到的章节",
      };
      wx.showLoading({ title: "审核并导入…", mask: true });
      const result = await importChapterDelivery(delivery.deliveryId, target);
      wx.hideLoading();
      this.setData({ saveNotice: target.mode === "append" ? "章节已加入当前故事" : "章节已留下，正在打开新故事" });
      if (target.mode === "append") await this.refresh();
      else if (result.storyId) wx.redirectTo({ url: "/pages/book/book?storyId=" + encodeURIComponent(result.storyId) });
    } catch (error) {
      wx.hideLoading();
      const message = error instanceof Error ? error.message : String((error as { errMsg?: string })?.errMsg || "收件操作没有完成，请重试");
      if (!/cancel/i.test(message)) this.setData({ saveNotice: message });
    }
  },
  async returnChapterDelivery() {
    if ((this.articlePending || this.articleSaving || this.articleAttempt) && !await this.flushArticle()) return;
    this.closeMore();
    if (!this.data.chapterDeliveryOn || !this.data.protectedCopy || !this.data.protectedHasDeliveryLineage || this.data.protectedRevisionSaving) return;
    const chapter = this.activeChapterForDelivery();
    if (!chapter) return;
    const confirmed = await this.confirm("把修改后的章节发回原作者？", "把这版文字和图片发回原作者。对方确认采用后才会更新原稿，之前的版本仍会保留。");
    if (!confirmed) return;
    try {
      wx.showLoading({ title: "发送修改稿…", mask: true });
      await returnChapterDelivery(chapter, this.data.protagonistName || "我", this.story?.title || "", this.data.storyId || undefined);
      wx.hideLoading();
      this.setData({ saveNotice: "修改稿已发回原作者" });
    } catch (error) {
      wx.hideLoading();
      this.setData({ saveNotice: error instanceof Error ? error.message : "修改稿没有发回，请重试" });
    }
  },
  async importLastPackage() {
    if (!CHAPTER_PACKAGE_ENABLED || this.data.saving || this.data.generating || this.data.appendingOwn) return;
    try {
      if ((this.data.editing || this.editSave) && !await this.finishEditing()) return;
      const currentStory = this.story;
      const appendStory = currentStory && typeof currentStory.version === "number" && this.data.storyId && this.revisionId ? currentStory : undefined;
      const canAppend = Boolean(appendStory);
      const choice = canAppend ? await new Promise<number>((resolve, reject) => wx.showActionSheet({
        itemList: ["导入为新故事", "加入当前书稿"], success: result => resolve(result.tapIndex), fail: reject,
      })) : 0;
      const target = choice === 1 && appendStory ? {
        mode: "append" as const, storyId: appendStory.id, expectedVersion: Number(appendStory.version), expectedRevisionId: this.revisionId,
      } : undefined;
      const result = await importLastExport({ target });
      if (target) {
        await this.refresh();
        this.setData({ saveNotice: "章节已加入当前书稿" });
      } else {
        this.setData({ saveNotice: "章节包已导入，正在打开新故事" });
        wx.redirectTo({ url: "/pages/book/book?storyId=" + encodeURIComponent(result.storyId) });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String((error as { errMsg?: string })?.errMsg || "导入没有成功，请重试");
      if (!/cancel/i.test(message)) this.setData({ saveNotice: message });
    }
  },
  async returnOwnExperience() {
    this.closeMore();
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
    if (this.data.protectedCopy || this.data.saving || this.data.generating) return;
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
      await this.openChapter({ currentTarget: { dataset: { id } } });
      this.setData({ saveNotice: "已新开" + label + (memoryIds.length ? "，已把 " + memoryIds.length + " 条记忆图文加入正文" : "") + "。" });
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
      this.setData({ panel: "", assignMemoryId: "", saveNotice: "已放进" + chapterLabel(index + 1) + "，图文已加入正文，可以继续编辑。" });
    }
  },
  async addToChapter(event: { currentTarget: { dataset: { id: string } } }) {
    const memory = this.memories.find(item => item.id === event.currentTarget.dataset.id);
    if (!memory) { this.setData({ saveNotice: "这段记忆已经不存在，请重新打开书稿" }); return; }
    if (await this.saveChapters(placeMemoryInChapter(this.chapters, memory, this.activeChapterId), "调整章节")) {
      this.setData({ saveNotice: "图文已加入本章，可以继续编辑；点图片可移除。" });
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
  deleteChapterFromContents(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    this.suppressChapterOpen = false;
    if (id) void this.deleteChapterById(id);
  },
  deleteActiveChapter() { return this.deleteChapterById(this.activeChapterId); },
  deleteChapterById(chapterId: string) {
    return new Promise<void>(resolve => {
      let chapters: ManuscriptChapter[];
      const index = this.chapters.findIndex(chapter => chapter.id === chapterId);
      if (index < 0) { resolve(); return; }
      const label = chapterLabel(index + 1);
      try { chapters = removeChapter(this.chapters, chapterId); } catch (error) {
        this.setData({ saveNotice: error instanceof Error ? error.message : "无法删除这一章" });
        resolve();
        return;
      }
      wx.showModal({
        title: "删除" + label + "？",
        content: "会保存为一个新版本。这一章可以从历史版本恢复，里面的记忆会回到「还没放进书稿」；原始记忆和其他章节都不会删除。",
        success: async result => {
          if (result.confirm && await this.saveChapters(chapters, "删除" + label)) {
            this.setData({ view: "contents", swipeOpenChapterId: "", saveNotice: "这一章已从新版本移除，历史版本仍可恢复。" });
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
    const entry = this.data.history.find(item => item.id === event.currentTarget.dataset.id);
    if (!entry) return;
    const requestId=++this.revisionRequestId, historyRequestId=this.historyRequestId, storyId=this.data.storyId;
    this.setData({previewVersion:null,previewBlocks:[],previewLayoutPages:[],revisionLoading:true});
    let version: ManuscriptRevision;
    try {
      version = 'draft' in entry ? entry : await loadStoryRevision(storyId,entry.id);
    } catch (error) {
      if (!this.unloaded && requestId===this.revisionRequestId && historyRequestId===this.historyRequestId && this.data.panel==='history')
        this.setData({revisionLoading:false,saveNotice:error instanceof Error ? error.message : '这一版暂时加载失败，请重试'});
      return;
    }
    if (this.unloaded || requestId!==this.revisionRequestId || historyRequestId!==this.historyRequestId || this.data.panel!=='history' || storyId!==this.data.storyId) return;
    this.setData({revisionLoading:false});
    this.setData({ previewVersion: version, previewBlocks: [], previewLayoutPages: [] });
    const previewBlocks = await Promise.all((version.draft.content ?? version.draft.paragraphs.map(text => ({ text }))).map(async item => {
      if (typeof item.text === "string") return displayLines([item]);
      if (item.photoId && isStoryImageReference(item.photoId)) {
        const path = this.photoPaths[item.photoId];
        return [path ? { path } : { text: "〔AI 插图暂时无法读取〕" }];
      }
      const path = await readLocalPhoto(item.photoId!);
      return [path ? { path } : { text: "〔照片仅保存在原设备，本机不可用〕" }];
    })).then(groups => groups.flat());
    const previewChapters = version.draft.chapters || [];
    const layoutPhotoPaths: Record<string, string> = {};
    let canUseLayout = previewChapters.length > 0 && previewChapters.every(chapter => Boolean(chapter.layout));
    for (const chapter of previewChapters) {
      for (const modulePhotoId of chapterPhotoIds(chapter)) {
        const path = isStoryImageReference(modulePhotoId) ? this.photoPaths[modulePhotoId] : await readLocalPhoto(modulePhotoId);
        if (path) layoutPhotoPaths[modulePhotoId] = path;
        else canUseLayout = false;
      }
    }
    if (previewChapters.some(chapter => chapter.layout?.pages.some(page => page.modules.some(module => module.kind === "image")))) {
      for (const chapter of previewChapters) {
        for (const page of chapter.layout?.pages || []) for (const module of page.modules) {
          if (module.kind !== "image") continue;
          const photoId = chapter.packageAssets?.[module.assetId]?.photoId ?? chapter.content.find(item => item.photoId?.endsWith(module.assetId.slice(6)))?.photoId;
          if (!photoId || !layoutPhotoPaths[photoId]) canUseLayout = false;
        }
      }
    }
    const previewLayoutPages = canUseLayout ? previewChapters.flatMap(chapter => chapterLayoutView(chapter, Math.max(1, (this.windowWidth || 375) - 32), layoutPhotoPaths)) : [];
    if (!this.unloaded && requestId === this.revisionRequestId && historyRequestId === this.historyRequestId &&
        this.data.panel === "history" && storyId === this.data.storyId && this.data.previewVersion?.id === version.id) {
      this.setData({ previewBlocks, previewLayoutPages });
    }
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
    this.clearMemoryConnection();
    if (this.data.protectedCopy) { this.setData({ saveNotice: "亲友原文不能整篇改写，请使用“补充我的经历”。" }); return; }
    const visibleChapters = this.visibleChapters();
    const active = this.data.view === "chapter" ? visibleChapters.find(chapter => chapter.id === this.activeChapterId) : undefined;
    const known = new Set(this.memories.map(memory => memory.id));
    this.organizeSelection = unassignedMemoryIds(this.chapters, [...known]);
    const where = new Map<string, string>();
    visibleChapters.forEach((chapter, index) => chapter.memoryIds.forEach(id => where.set(id, "在" + chapterLabel(index + 1))));
    this.setData({
      panel: "organize", organizeTarget: active ? active.id : "new",
      organizeCount: this.organizeSelection.length,
      organizeRows: this.organizeMemories.map(memory => ({ ...memoryRow(memory), where: where.get(memory.id) ?? "还没放进", checked: this.organizeSelection.includes(memory.id) })),
    });
    this.updateOrganizeTarget(this.data.organizeTarget);
  },
  async onOrganizeBook(event: { detail: { value: string } }) {
    if (this.data.connectionSaving || this.data.generating || this.data.saving || this.data.switchingBook) return;
    const selected = this.data.organizeBooks.find(item => item.id === event.detail.value);
    if (!selected) return;
    this.clearMemoryConnection();
    const previous = { key: this.requestedStoryKey, title: this.requestedStoryTitle, memberId: this.requestedMemberId };
    this.setData({ switchingBook: true, saveNotice: "" });
    this.openOrganizeOnLoad = true;
    this.requestedStoryKey = selected.id;
    this.requestedStoryTitle = selected.title;
    this.requestedMemberId = selected.memberId;
    this.requestedMemoryIds = this.organizeSelection.length ? [...this.organizeSelection] : [...selected.memoryIds];
    this.organizeCandidate = undefined;
    try { await this.refresh(); } catch (error) {
      this.requestedStoryKey = previous.key;
      this.requestedStoryTitle = previous.title;
      this.requestedMemberId = previous.memberId;
      this.requestedMemoryIds = [];
      this.openOrganizeOnLoad = false;
      this.setData({ saveNotice: error instanceof Error ? error.message : "加载失败" });
    } finally { this.setData({ switchingBook: false }); }
  },
  onPreviewText(event: WechatMiniprogram.Input) {
    if (this.data.saving || this.data.confirmingOrganize) return;
    this.setData({
      previewText: event.detail.value,
      previewAiLabel: this.data.previewAiLabel ? "文字 AI 生成 · 已由你修改" : "",
    });
  },
  onPreviewTitle(event: WechatMiniprogram.Input) {
    if (this.data.saving || this.data.confirmingOrganize) return;
    this.setData({
      previewTitle: event.detail.value,
      previewAiLabel: this.data.previewAiLabel ? "文字 AI 生成 · 已由你修改" : "",
    });
  },
  onOrganizeMemories(event: { detail: { value: string[] } }) {
    if (this.data.connectionSaving || this.data.generating || this.data.saving || this.data.switchingBook) return;
    this.clearMemoryConnection();
    this.organizeSelection = event.detail.value;
    this.setData({ organizeCount: this.organizeSelection.length, organizeRows: this.data.organizeRows.map(row => ({ ...row, checked: this.organizeSelection.includes(row.id) })) });
  },
  updateOrganizeTarget(id: string) {
    const target = this.chapters.find(chapter => chapter.id === id);
    const points = target ? chapterInsertionPoints(target.content) : [];
    this.setData({ organizeTarget: id, organizeMethod: "insert", insertionPoint: "end", organizeWritingInstruction: "",
      insertionPoints: points, insertionIndex: Math.max(0, points.length - 1),
      organizeOriginal: target ? target.content.map(item => item.text ?? "\n〔照片或插图，原位置保留〕\n").join("") : "",
    });
  },
  onOrganizeTarget(event: { detail: { value: string } }) {
    if (this.data.connectionSaving || this.data.generating || this.data.saving || this.data.switchingBook) return;
    this.updateOrganizeTarget(event.detail.value);
  },
  onOrganizeMethod(event: { detail: { value: string } }) {
    if (this.data.connectionSaving || this.data.generating || this.data.saving || this.data.switchingBook) return;
    this.setData({ organizeMethod: event.detail.value === "blend" && this.data.writingMode === "creative" ? "blend" : "insert" });
  },
  onOrganizeWritingInstruction(event: WechatMiniprogram.Input) {
    if (this.data.connectionSaving || this.data.generating || this.data.saving || this.data.switchingBook) return;
    this.data.organizeWritingInstruction = event.detail.value;
  },
  onInsertionPoint(event: { detail: { value: string } }) {
    if (this.data.connectionSaving || this.data.generating || this.data.saving || this.data.switchingBook) return;
    const index = Number(event.detail.value);
    const point = this.data.insertionPoints[index];
    if (point) this.setData({ insertionPoint: point.id, insertionIndex: index });
  },
  onInsertionText(event: WechatMiniprogram.Input) {
    if (this.data.saving || this.data.confirmingOrganize) return;
    const insertion = this.organizeCandidate?.insertion;
    if (!insertion) return;
    const text = event.detail.value;
    this.setData({ insertionText: text,
      previewText: text.trim() || insertion.photoIds.length ? insertChapterText(insertion.original, insertion.pointId, text, insertion.photoIds).map(item => item.text ?? "\n〔照片或插图，原位置保留〕\n").join("") : "",
      previewAiLabel: this.data.previewAiLabel ? "含 AI 文字 · 已由你修改" : "",
    });
  },
  clearMemoryConnection() {
    this.connectionEpoch++;
    this.setData({ connection: null, connectionBusy: false, connectionNotice: "" });
  },
  async exploreConnections() {
    if (this.data.connectionBusy || this.data.connectionSaving || this.data.generating || this.data.switchingBook || this.data.writingMode !== "creative") return;
    const epoch = ++this.connectionEpoch;
    const selected = [...this.organizeSelection];
    this.setData({ connectionBusy: true, connection: null, connectionNotice: "正在一起看你选中的记忆…" });
    try {
      const connection = await exploreMemoryConnection(selected);
      if (this.unloaded || epoch !== this.connectionEpoch || this.data.panel !== "organize") return;
      this.setData({ connection, connectionNotice: connection.evidence.length ? "这只是一个可能的线索，由你判断；不会自动写进故事。" : "这几段还没有足够明确的联系，你也可以按自己的想法组合。" });
    } catch (error) {
      if (!this.unloaded && epoch === this.connectionEpoch) this.setData({ connectionNotice: error instanceof Error ? error.message : "暂时没能找到线索，可以直接组合。" });
    } finally { if (!this.unloaded && epoch === this.connectionEpoch) this.setData({ connectionBusy: false }); }
  },
  dismissConnection() {
    this.clearMemoryConnection();
    this.setData({ connectionNotice: "这条线索不会采用。你写下的想法仍保留，也可以直接组合记忆。" });
  },
  onConnectionReflection(event: WechatMiniprogram.Input) {
    if (this.data.connectionSaving) return;
    this.setData({ connectionReflection: event.detail.value });
    if (event.detail.value.trim()) wx.enableAlertBeforeUnload({ message: "你刚写的想法还没保存为记忆。" });
    else if (!this.data.editing) wx.disableAlertBeforeUnload();
  },
  async saveConnectionReflection() {
    if (this.data.connectionSaving || this.data.generating || this.data.switchingBook) return;
    const text = this.data.connectionReflection.trim();
    const storyKey = this.requestedStoryKey;
    this.clearMemoryConnection();
    if (!text || text.length > 500) { this.setData({ connectionNotice: "写下 1—500 字自己的想法，再保存。" }); return; }
    this.setData({ connectionSaving: true });
    try {
      const state = await loadRoomStateRemoteFirst();
      const author = accountOwner(state.members);
      if (!author) throw new Error("暂时无法确认记忆的主人，请重新打开。");
      if (!this.connectionDraft) this.connectionDraft = createContribution({authorMemberId:author.id, authorName:author.name, relation:author.relation,
        text, title:"看着几段记忆想到的事", memoryType:"note", scope:"personal", visibility:"private", sharedWithMemberIds:[], relatedMemberIds:[]});
      if (this.connectionDraft.authorMemberId !== author.id) throw new Error("记忆主人已经变化，请重新打开后核对保存结果。");
      if (this.connectionDraft.text !== text) throw new Error("上次补充尚未确认保存，请先保留原输入并重试核对，避免重复保存。");
      const draft = this.connectionDraft;
      const existing = state.contributions.find(memory => memory.id === draft.id);
      if (existing && (existing.deletedAt || existing.text !== draft.text || existing.authorMemberId !== draft.authorMemberId)) throw new Error("这段补充已有变化，请在记忆列表核对。");
      const saved = existing ? state : await appendContributionRemoteFirst(draft);
      const confirmed = memoryPool(saved.contributions).find(memory => memory.id === draft.id);
      if (!confirmed || confirmed.text !== draft.text) throw new Error("补充尚未确认保存，可以保留原输入再试一次。");
      this.connectionDraft = undefined;
      if (!this.data.editing) wx.disableAlertBeforeUnload();
      if (this.unloaded) return;
      if (storyKey !== this.requestedStoryKey) { this.setData({ connectionReflection: "", connectionNotice: "已存为独立记忆，可在记忆列表查看。" }); return; }
      this.organizeMemories = [...this.organizeMemories.filter(memory => memory.id !== confirmed.id), confirmed];
      this.organizeSelection = [...new Set([...this.organizeSelection, confirmed.id])];
      this.setData({ connectionReflection: "", connection: null, connectionNotice: "已存为一段独立记忆，并勾选到这次组合中。下一步预览后才会写进故事。",
        organizeCount:this.organizeSelection.length,
        organizeRows:[...this.data.organizeRows.filter(row => row.id !== confirmed.id), {...memoryRow(confirmed), where:"独立记忆", checked:true}] });
    } catch (error) {
      if (!this.unloaded) this.setData({ connectionNotice: error instanceof Error ? error.message : "补充未确认保存，请保留输入重试。" });
    } finally { if (!this.unloaded) this.setData({ connectionSaving:false }); }
  },
  async showMemoryPreviewPhotos(photoIds: string[]) {
    const ids = [...new Set(photoIds)];
    const photos = await readLocalPhotos(ids);
    if (this.unloaded) return;
    this.setData({ memoryPreviewPhotos: ids.map(id => ({ id, path: photos.photoPaths[id] || "", ai: isStoryImageReference(id) })) });
  },
  async runOrganize() {
    if (this.data.connectionSaving) return;
    if (this.data.connectionReflection.trim()) { this.setData({ connectionNotice: "你还有没保存的想法。先存为独立记忆，或清空输入后继续。" }); return; }
    this.connectionEpoch++;
    if (this.data.generating || this.data.saving || this.data.editing || this.data.switchingBook) return;
    if (this.data.protectedCopy) return;
    const memoryIds = this.organizeSelection.filter(id => this.organizeMemories.some(memory => memory.id === id));
    if (!memoryIds.length) { this.setData({ saveNotice: "先勾选要整理的记忆" }); return; }
    const target = this.chapters.find(chapter => chapter.id === this.data.organizeTarget);
    const inserting = Boolean(target && this.data.organizeMethod === "insert");
    if (target && !inserting && plainText(target.content).length > 4000) { this.setData({ saveNotice: "这一章较长，请新开一章整理，避免遗漏已有正文" }); return; }
    if (!inserting && target?.handEdited && plainText(target.content).trim() && !await this.confirm("这一章你亲手改过",
      "AI 会重写这一章的正文，照片保留。原来的文字在历史版本里能找回，整理完也可以马上撤回。继续吗？")) return;
    this.setData({ generating: true, memoryPreviewPhotos: [], saveNotice: "正在整理，请稍候…" });
    try {
      let state = await loadRoomStateRemoteFirst();
      let story = this.data.storyId ? activeStory(state, this.data.storyId) : undefined;
      if (story?.sourcePolicyRequired) throw new Error("亲友原文不能整篇改写，请使用“补充我的经历”。");
      // Only the explicit preview action attaches selected sources. Merely choosing a book never writes.
      if (story && memoryIds.some(id => !story!.memoryIds.includes(id))) {
        state = await linkStoryMemories(story, memoryIds);
        story = activeStory(state, story.id);
        this.story = story;
      }
      const member = state.members.find(item => item.id === this.data.memberId && isRecordingProfile(item));
      if (!member) throw new Error("这本书已不可用");
      const fingerprint = story ? storySourceFingerprint(state, story.id) : personalBookSourceFingerprint(state, member.id);
      if (currentManuscript(state, story?.id || member.id).revisionId !== this.revisionId) throw new Error("正文已有更新，请重新打开章节");
      let aiState = state;
      let selectedMemories = memoryPool(state.contributions).filter(memory => (!story || story.memoryIds.includes(memory.id)) && memoryIds.includes(memory.id));
      if (inserting && target) {
        if (target.pendingRevision?.edits.some(edit => edit.status === "pending")) throw new Error("这一章还有待确认的修改，请先处理完再插入");
        if (selectedMemories.length !== memoryIds.length) throw new Error("所选记忆已变动，请重新选择");
        const insertionText = selectedMemories.map(memory => memory.text.trim()).filter(Boolean).join("\n\n");
        const photoIds = selectedMemories.flatMap(memory => memory.photoIds ?? []);
        const content = insertChapterText(target.content, this.data.insertionPoint, insertionText, photoIds);
        const containsAiText = Boolean(target.containsAiText || target.generationMode === "cloud-ai" || selectedMemories.some(memory => memoryAiLabel(memory)));
        const chapter: ManuscriptChapter = { ...target, content, containsAiText,
          memoryIds: Array.from(new Set([...target.memoryIds, ...memoryIds])),
          memorySegmentCounts: { ...target.memorySegmentCounts, ...Object.fromEntries(selectedMemories.map(memory => [memory.id, memorySegmentCount(memory)])) },
        };
        const chapters = this.chapters.map(item => item.id === target.id ? chapter : item);
        const label = this.data.chapterRows.find(row => row.id === target.id)?.label || chapterLabel(chapters.findIndex(item => item.id === target.id) + 1);
        this.organizeCandidate = { draft: draftWithChapters(this.data.draft ?? this.newBookBase(), chapters), fingerprint,
          chapterId: target.id, label, notice: "记忆的文字和配图已一起写入，原章节图片位置保留。可以继续编辑文字，点图片可移除；换图请用顶部照片入口。", revisionId: this.revisionId,
          insertion: { original: target.content.map(item => ({ ...item })), pointId: this.data.insertionPoint, photoIds },
        };
        this.setData({ panel: "organize-preview", previewInsertion: true, insertionText,
          previewTitle: target.title, previewText: content.map(item => item.text ?? "\n〔照片或插图，原位置保留〕\n").join(""),
          previewAiLabel: containsAiText ? "含 AI 文字" : "", saveNotice: "尚未写入。记忆的配图也会一起带入，写入后可以修改图文。" });
        await this.showMemoryPreviewPhotos(photoIds);
        return;
      }
      if (story?.writingMode === "creative" && usesCloudStorage()) {
        const context = await storyAiContext(story.id, memoryIds);
        if (context.story.id !== story.id || context.story.version !== story.version || context.fingerprint !== fingerprint) throw new Error("故事刚刚更新，请重新整理");
        selectedMemories = context.memories;
        aiState = { ...state, contributions: context.memories };
      }
      const request = { memoryIds, storyId: story?.id, chapterTitle: target?.title ?? "", existingText: target ? plainText(target.content).trim() : "", writingInstruction: this.data.organizeWritingInstruction.trim() };
      const result = !story || story.writingMode === "creative"
        ? await generateBiographyWithStatus(aiState, member, request)
        : { draft: buildLocalChapterDraft(selectedMemories, request.existingText, request.chapterTitle) };
      const { draft: organized, fallbackReason } = result;
      const latest = await loadRoomStateRemoteFirst();
      const latestFingerprint = story ? storySourceFingerprint(latest, story.id) : personalBookSourceFingerprint(latest, member.id);
      if (fingerprint !== latestFingerprint) throw new Error("素材刚刚变了，请重新整理");
      const { chapters, chapterId, keptImageCount } = applyOrganized(this.chapters, target?.id ?? "new", organized, memoryIds, selectedMemories.flatMap(memory => memory.photoIds ?? []));
      const base = { ...(this.data.draft ?? this.newBookBase()), generationMode: organized.generationMode, generatedAt: organized.generatedAt };
      const label = this.data.chapterRows.find(row => row.id === chapterId)?.label || chapterLabel(this.data.chapterRows.length + 1);
      const notice = (story?.writingMode === "objective" ? "已按客观记录模式整理，未调用 AI。" : fallbackReason ? "这次没有用上在线 AI（" + FALLBACK_REASONS[fallbackReason] + "），预览由原话整理。" : "")
        + (keptImageCount ? "保留了 " + keptImageCount + " 张照片或插图。" : "");
      this.organizeCandidate = { draft: draftWithChapters(base, chapters), fingerprint, chapterId, label, notice, revisionId: this.revisionId };
      const chapter = chapters.find(item => item.id === chapterId)!;
      this.setData({
        panel: "organize-preview", previewInsertion: false,
        previewTitle: chapter.title,
        previewText: plainText(chapter.content),
        previewAiLabel: organized.generationMode === "cloud-ai" ? "文字 AI 生成" : "",
        saveNotice: notice + "尚未写入，记忆的配图会一起带入，写入后可以修改图文。",
      });
      await this.showMemoryPreviewPhotos(selectedMemories.flatMap(memory => memory.photoIds ?? []));
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "整理失败，请重试" });
    } finally { if (this.data.generating) this.setData({ generating: false }); }
  },
  async confirmOrganize() {
    const candidate = this.organizeCandidate;
    if (!candidate || this.data.saving || this.data.generating || this.data.confirmingOrganize) return;
    if (!this.data.previewText.trim()) { this.setData({ saveNotice: "正文不能为空" }); return; }
    this.setData({ confirmingOrganize: true, saveNotice: "正在核对最新版本并写入…" });
    try {
      const state = await loadRoomStateRemoteFirst();
      const currentFingerprint = this.data.storyId ? storySourceFingerprint(state, this.data.storyId) : personalBookSourceFingerprint(state, this.data.memberId);
      const bookId = this.data.storyId || this.data.memberId;
      if (candidate.fingerprint !== currentFingerprint
        || currentManuscript(state, bookId).revisionId !== candidate.revisionId) throw new Error("素材或正文已有更新，请返回重新整理");
      const before = this.data.draft ? { draft: this.data.draft, fingerprint: this.sourceFingerprint } : undefined;
      const chapters = candidate.draft.chapters!;
      const chapter = chapters.find(item => item.id === candidate.chapterId)!;
      const content = candidate.insertion
        ? insertChapterText(candidate.insertion.original, candidate.insertion.pointId, this.data.insertionText, candidate.insertion.photoIds)
        : [{ text: this.data.previewText.trim() + "\n" }, ...chapter.content.filter(item => item.photoId)];
      const next = draftWithChapters(candidate.draft, updateChapter(chapters, chapter.id, { title: this.data.previewTitle, content }));
      if (await this.persist(next, candidate.fingerprint, "version", (candidate.insertion ? "插入记忆到" : "AI 整理") + candidate.label)) {
        this.organizeCandidate = undefined;
        this.undoState = before;
        this.openChapter({ currentTarget: { dataset: { id: candidate.chapterId } } });
        this.setData({ canUndo: !!before, saveNotice: "已写入" + candidate.label + "。" + candidate.notice });
      }
    } catch (error) { this.setData({ saveNotice: error instanceof Error ? error.message : "写入失败，请重试" }); }
    finally { this.setData({ confirmingOrganize: false }); }
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
  openImages(purpose?: "illustration" | "backdrop", selection?: { blockId: string; text: string }) {
    const chapterId = this.data.view === "chapter" ? this.activeChapterId : "";
    const query = [
      this.data.storyId ? "storyId=" + encodeURIComponent(this.data.storyId) : "",
      !this.data.storyId && this.data.memberId ? "memberId=" + encodeURIComponent(this.data.memberId) : "",
      chapterId ? "chapterId=" + encodeURIComponent(chapterId) : "",
      purpose ? "purpose=" + purpose : "",
    ].filter(Boolean).join("&");
    wx.navigateTo({
      url: "/pages/story-images/story-images" + (query ? "?" + query : ""),
      success: result => { if (selection) result.eventChannel.emit('selectedText', { ...selection, generate: true }); },
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
  async goHome() {
    if ((this.data.editing || this.editSave) && !await this.finishEditing(true)) return;
    if (!this.canLeaveEditor(true)) return;
    if (this.data.editing && !this.backupEdits("contents")) return;
    if (this.data.editing) this.setData({view:"contents"});
    const previous = typeof getCurrentPages === "function" ? getCurrentPages().slice(-2)[0] : undefined;
    if (previous && ["pages/index/index", "pages/stories/stories"].includes(previous.route)) {
      wx.navigateBack();
    } else wx.reLaunch({ url: "/pages/index/index" });
  },
  onShareAppMessage(event: WechatMiniprogram.Page.IShareAppMessageOption): { title: string; path: string } {
    if (event?.from === 'button' && event.target?.dataset?.chapterShare && this.data.articleShareUrl && this.data.articleShareRevision === this.revisionId && this.data.articleShareChapterId === this.activeChapterId) {
      return { title: this.data.articleShareTitle, path: '/pages/book/book?chapterClaim=' + chapterClaimToken(this.data.articleShareUrl) };
    }
    return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" };
  },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
