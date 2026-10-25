import { storyCoverApi } from '../../services/storyCoverService';
import { chapterPhotoIds, galleryPhotos, type GalleryPhoto } from "../../services/storyImageGallery";
import { illustrationAnchor, illustrationPoints, IllustrationPoint, saveChapterIllustration } from "../../services/chapterIllustrations";
import { saveChapterBackdrop } from "../../services/chapterBackdrop";
import { chapterLabel, chaptersOf } from "../../services/chapters";
import { FamilyRoomState, isRecordingProfile, ManuscriptChapter, memoryPool } from "../../domain/biography";
import { currentManuscript } from "../../services/manuscript";
import { loadCurrentMemberRemoteFirst, loadRoomStateRemoteFirst } from "../../services/roomRepository";
import {
  callStoryImages, formatBytes, isActiveJob, moderationLabel, nextPollDelayMs, qualityLabel, StoryImage, StoryImageJob, StoryImagePurpose,
  StoryImageServiceError, storyImageApi,
} from "../../services/storyImageService";
import { logLoadError } from "../../services/loadErrorLog";
import { isStoryImageReference, storyImageMatchesReference } from "../../services/bookImages";
import { activeStory } from "../../services/storyBooks";
import { choosePhoneReferencePhotos, isPhotoPickerCancel, PhoneReferencePhoto } from "../../services/phoneReferencePhotos";

interface ImageCard {
  uploaded?: boolean; isCover?: boolean; sourceLabel: string; sourceText: string; uploaderLabel: string;
  imageId: string; url: string; sizeLabel: string; purposeLabel: string;
  isBackdrop: boolean; referenceReady: boolean; inUse: boolean; inText: boolean; moderationLabel: string; qualityLabel: string; qualityFlawed: boolean;
}
interface JobRow { jobId: string; message: string; active: boolean; purposeLabel: string }
interface ChapterGroup {
  id: string; label: string; title: string; backdropImageId: string; backdropMissing: boolean;
  referencePhotoIds: string[]; referencePhotoLabel: string;
  images: ImageCard[]; pending: JobRow[];
}

const PURPOSE_LABELS: Record<string, string> = { illustration: "插图", backdrop: "底图", cover: "封面" };
const LOCAL_PHOTO_ID = /^photo-(?!ai-)[a-z0-9-]{1,80}$/;
const routePurpose = (value?: string): "" | "illustration" | "backdrop" => value === "illustration" || value === "backdrop" ? value : "";
const chapterReferencePhotoIds = (chapter: ManuscriptChapter): string[] =>
  [...new Set(chapter.content
    .map((item): string => typeof item.photoId === "string" ? item.photoId : "")
    .filter((id): id is string => LOCAL_PHOTO_ID.test(id)))].slice(0, 3);

const card = (image: StoryImage, backdropImageId = "", textImageReferences = new Set<string>()): ImageCard => ({
  isCover: image.purpose === 'cover',
  sourceLabel: image.sourceKind === 'upload' ? '上传的图片' : image.sourceKind === 'selection' ? '选中文字生成' : image.sourceKind === 'chapter' ? '根据整章文字生成' : image.sourceKind === 'memory' ? '根据回忆生成' : '生成原文未记录',
  sourceText: image.sourceText || '', uploaderLabel: '',
  imageId: image.imageId, url: image.url, sizeLabel: formatBytes(image.bytes),
  purposeLabel: PURPOSE_LABELS[image.purpose] ?? "配图",
  isBackdrop: image.purpose === "backdrop", referenceReady: image.purpose === "illustration" && image.moderation === "pass",
  inUse: !!backdropImageId && image.imageId === backdropImageId,
  inText: Array.from(textImageReferences).some(reference => storyImageMatchesReference(image.imageId, reference)),
  moderationLabel: moderationLabel(image.moderation), qualityLabel: qualityLabel(image), qualityFlawed: image.quality === "flawed",
});
const photoCard = (photo: GalleryPhoto, aiGenerated = false): ImageCard => ({
  imageId: photo.photoId, url: photo.url, uploaded:true,
  sourceLabel: aiGenerated ? '接收的 AI 图像 · 生成原文未记录' : '上传或接收的图片', sourceText:'', uploaderLabel:photo.uploaderLabel,
  sizeLabel:'', purposeLabel:aiGenerated ? 'AI 图像' : '照片', isBackdrop:false, referenceReady:false,
  inUse:false, inText:true, moderationLabel:photo.url ? '' : '图片暂不可读取', qualityLabel:'', qualityFlawed:false,
});
const jobRow = (job: StoryImageJob): JobRow => ({
  jobId: job.jobId, message: job.message, active: isActiveJob(job), purposeLabel: PURPOSE_LABELS[job.purpose] ?? "配图",
});
const messageOf = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const imageLimitLabel = (limits: { daily: number | null; book: number | null; unlimited?: boolean }): string =>
  limits.unlimited || limits.daily === null || limits.book === null
    ? "不设每日或单本张数上限；生成成功会产生供应商用量和费用。"
    : `每天最多画 ${limits.daily} 张，这本书最多 ${limits.book} 张；没画成的不算。`;

/**
 * 这本书的图：按章节列出插图和底图，可以给一章配图、选本章底图、看大图、删除，并显示占用的空间。
 * 配图以本章为画面主体，只从其他章节取人物连续性线索；正在画的图在页面打开时轮询，离开页面就停。
 */
Page({
  data: {
    memoryId: "", storyId: "", memberId: "", bookTitle: "", focusChapterId: "", focusPurpose: "" as "" | "illustration" | "backdrop",
    roleChapterIndex:0, libraryImages: [] as ImageCard[], groups: [] as ChapterGroup[], otherImages: [] as ImageCard[],
    usageLabel: "", limitsLabel: "", loading: true, loadError: "", notice: "", noticeChapterId: "",
    submitting: "", removingId: "", savingBackdrop: false,
    selectedText: '', selectedBlockId: '', selectionExpanded:false, coverImages: [] as ImageCard[], coverJobs: [] as JobRow[], storyVersion:0,
    artDirections: {} as Record<string, string>,
    useChapterPhotos: {} as Record<string, boolean>,
    phoneReferences: {} as Record<string, PhoneReferencePhoto[]>, pickingReference: "",
    preview: null as (ImageCard & { chapterId: string }) | null,
    placementOptions: [] as IllustrationPoint[], placementIndex: 0, savingPlacement: false, previewNotice: "",
  },
  unloaded: false,
  hidden: false,
  activeJobIds: [] as string[],
  roomState: undefined as FamilyRoomState | undefined,
  refreshId: 0,
  polling: false,
  pendingImageChecks: false,
  startQueued: false,
  pollStartedAt: 0,
  pollTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  requestedMemberId: "",
  requestedStoryId: "",
  requestedMemoryId: "",
  referenceBookId: "",
  selectionGenerationPending: false,
  confirmingGeneration: false,

  onLoad(options: { memoryId?: string; storyId?: string; memberId?: string; chapterId?: string; purpose?: string } = {}) {
    this.unloaded = false;
    this.getOpenerEventChannel?.().on?.('selectedText', (selection: { blockId: string; text: string; generate?: boolean }) => {
      this.setData({ selectedText: selection.text, selectedBlockId: selection.blockId });
      this.selectionGenerationPending = selection.generate === true;
      void this.startSelectionGeneration();
    });
    if (options.memoryId) {
      try { this.requestedMemoryId = decodeURIComponent(options.memoryId); } catch { this.requestedMemoryId = '!invalid'; }
      this.setData({memoryId:this.requestedMemoryId, focusChapterId:'memory', focusPurpose:'illustration'});
    }
    if (options.memberId) {
      try { this.requestedMemberId = decodeURIComponent(options.memberId); } catch { this.requestedMemberId = ""; }
    }
    if (options.storyId) {
      try { this.requestedStoryId = decodeURIComponent(options.storyId); } catch { this.requestedStoryId = ""; }
    }
    if (!options.chapterId) return;
    try {
      this.setData({ focusChapterId: decodeURIComponent(options.chapterId), focusPurpose: routePurpose(options.purpose) });
    } catch {
      // 参数坏了就不高亮任何一章。
    }
  },
  onShow() {
    this.hidden = false;
    void this.refresh().catch(error => { logLoadError("story-images", error); this.setData({ loading: false, loadError: messageOf(error, "配图暂时没加载出来，请重试。") }); });
  },
  onHide() {
    this.hidden = true;
    this.clearPoll();
  },
  onUnload() {
    this.unloaded = true;
    this.clearPoll();
  },
  async refresh(imagesOnly = false) {
    if (imagesOnly && (this.data.savingPlacement || this.data.savingBackdrop || this.data.removingId)) return;
    const refreshId = ++this.refreshId;
    const state = imagesOnly && this.roomState ? this.roomState : await loadRoomStateRemoteFirst({ view: "home" });
    if (this.requestedMemoryId) {
      const memory = memoryPool(state.contributions).find(item => item.id === this.requestedMemoryId);
      if (!memory) throw new Error('这段记忆已不可用，请返回记忆列表');
      const list = await storyImageApi.listStoryImages('', memory.id);
      if (this.unloaded || refreshId !== this.refreshId) return;
      this.roomState = state;
      this.activeJobIds = list.pending.filter(isActiveJob).map(job => job.jobId);
      this.pendingImageChecks = list.images.some(image => image.moderation === 'pending' || image.quality === 'pending');
      if (!this.activeJobIds.length && !this.pendingImageChecks) this.pollStartedAt = 0;
      const refs = new Set(memory.photoIds || []);
      const referencePhotoIds = (memory.photoIds || []).filter(id => LOCAL_PHOTO_ID.test(id)).slice(0,3);
      this.setData({memoryId:memory.id, bookTitle:memory.title || '一段回忆',
        groups:[{id:'memory', label:'这段回忆', title:memory.title || '', backdropImageId:'', backdropMissing:false,
          referencePhotoIds, referencePhotoLabel:referencePhotoIds.length ? `默认参考这段回忆的${referencePhotoIds.length}张照片，可关闭` : '可以选参考照片，也可以只根据回忆文字生成',
          images:list.images.map(image => card(image, '', refs)), pending:list.pending.map(jobRow)}],
        useChapterPhotos:{...this.data.useChapterPhotos, memory:this.data.useChapterPhotos.memory ?? referencePhotoIds.length > 0},
        otherImages:[], usageLabel:`共 ${list.usage.count} 张 · ${formatBytes(list.usage.bytes)}`,
        limitsLabel:'生成成功会产生供应商用量和费用。', loading:false, loadError:''});
      const selected = this.data.preview;
      if (selected) {
        const latest = this.data.groups[0].images.find(image => image.imageId === selected.imageId);
        this.setData({preview:latest ? {...latest, chapterId:'memory'} : null});
      }
      this.schedulePoll();
      return;
    }
    const story = this.requestedStoryId ? activeStory(state, this.requestedStoryId) : undefined;
    if (this.requestedStoryId && !story) throw new Error("这本书已不可用，请重新选择");
    const member = story ? undefined : (this.requestedMemberId
      ? state.members.find(item => item.id === this.requestedMemberId && isRecordingProfile(item))
      : await loadCurrentMemberRemoteFirst(state));
    const bookId = story?.id || member?.id || "";
    if (!bookId) throw new Error("这本书已不可用，请重新选择");
    const current = currentManuscript(state, bookId);
    const chapters = current.draft ? chaptersOf(current.draft, current.sourceFingerprint) : [];
    const chapterIds = new Set(chapters.map(chapter => chapter.id));
    const [list, photos, library] = await Promise.all([
      storyImageApi.listStoryImages(bookId),
      galleryPhotos(chapters.flatMap(chapterPhotoIds), !!story?.sourcePolicyRequired),
      story ? callStoryImages<{images:StoryImage[]}>("listLibrary", {}) : Promise.resolve({images:[] as StoryImage[]}),
    ]);
    if (this.unloaded || refreshId !== this.refreshId) return;
    this.roomState = state;
    const phoneReferences = this.referenceBookId === bookId ? this.data.phoneReferences : {};
    this.referenceBookId = bookId;
    const known = new Set(chapters.map(chapter => chapter.id));
    const listed = new Set(list.images.map(image => image.imageId));
    this.activeJobIds = list.pending.filter(isActiveJob).map(job => job.jobId);
    this.pendingImageChecks = list.images.some(image => image.moderation === "pending" || image.quality === "pending");
    if (!this.activeJobIds.length && !this.pendingImageChecks) this.pollStartedAt = 0;
    this.setData({
      libraryImages:library.images.filter(image=>!listed.has(image.imageId)).map(image=>card(image)),
      storyVersion:story?.version || 0,
      coverImages:list.images.filter(image=>image.purpose === 'cover').map(image=>({...card(image),inUse:image.imageId === story?.coverImageId})),
      coverJobs:list.pending.filter(job=>job.purpose === 'cover').map(jobRow),
      storyId: story?.id || "", memberId: member?.id || this.requestedMemberId,
      bookTitle: current.draft?.title ?? story?.bookTitle ?? story?.title ?? "",
      groups: chapters.map((chapter, index) => {
        const backdropImageId = chapter.backdropImageId ?? "";
        const textImageReferences = new Set(chapter.content.flatMap(item => item.photoId && isStoryImageReference(item.photoId) ? [item.photoId] : []));
        const referencePhotoIds = chapterReferencePhotoIds(chapter);
        return {
          id: chapter.id, label: chapterLabel(index + 1), title: chapter.title, backdropImageId,
          referencePhotoIds,
          referencePhotoLabel: referencePhotoIds.length ? `默认参考本章 ${referencePhotoIds.length} 张照片，可关闭` : "本章没有正文照片，可从手机选择或只根据文字生成",
          // The chosen picture was deleted or failed the platform check.
          backdropMissing: !!backdropImageId && !listed.has(backdropImageId),
          images: [...list.images.filter(image => image.chapterId === chapter.id).map(image => card(image, backdropImageId, textImageReferences)),
            ...chapterPhotoIds(chapter).map(id => photoCard(photos[id], Object.values(chapter.packageAssets || {}).some(asset => asset.photoId === id && asset.aiGenerated)))],
          pending: list.pending.filter(job => job.chapterId === chapter.id).map(jobRow),
        };
      }),
      // A chapter can be deleted after it got pictures; its pictures stay manageable here.
      otherImages: list.images.filter(image => image.purpose !== "cover" && !known.has(image.chapterId)).map(image => card(image)),
      usageLabel: `共 ${list.images.length + Object.keys(photos).length} 张 · AI 配图占用 ${formatBytes(list.usage.bytes)}`,
      limitsLabel: imageLimitLabel(list.limits),
      phoneReferences: Object.fromEntries(Object.entries(phoneReferences).filter(([id]) => chapterIds.has(id))),
      useChapterPhotos: Object.fromEntries(chapters.map(chapter => [chapter.id,
        this.data.useChapterPhotos[chapter.id] ?? chapterReferencePhotoIds(chapter).length > 0])),
      loading: false,
      loadError: "",
    });
    const selected = this.data.preview;
    if (selected) {
      const latest = [...this.data.coverImages,...this.data.groups.flatMap(group=>group.images),...this.data.otherImages,...this.data.libraryImages].find(image=>image.imageId === selected.imageId);
      this.setData({ preview: latest ? { ...latest, chapterId: selected.chapterId } : null });
    }
    this.schedulePoll();
    void this.startSelectionGeneration();
  },
  async startSelectionGeneration() {
    if (!this.selectionGenerationPending || this.data.loading || this.hidden || this.unloaded
      || !this.data.selectedText || !this.data.selectedBlockId
      || !this.data.groups.some(group => group.id === this.data.focusChapterId)) return;
    // Consume before awaiting confirmation: refresh/onShow must never submit twice.
    this.selectionGenerationPending = false;
    await this.generate({currentTarget:{dataset:{id:this.data.focusChapterId,purpose:this.data.focusPurpose}}});
  },
  clearPoll() {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  },
  schedulePoll(immediate = false) {
    this.startQueued = this.startQueued || immediate;
    this.clearPoll();
    if (this.unloaded || this.hidden || this.polling || (!this.activeJobIds.length && !this.pendingImageChecks)) return;
    if (!this.pollStartedAt) this.pollStartedAt = Date.now();
    const delay = this.startQueued ? 0 : nextPollDelayMs(Date.now() - this.pollStartedAt);
    this.startQueued = false;
    this.pollTimer = setTimeout(() => { void this.pollOnce(); }, delay);
  },
  async pollOnce() {
    this.clearPoll();
    if (this.unloaded || this.hidden || this.polling) return;
    this.polling = true;
    const jobs = [...this.activeJobIds];
    let changed = this.pendingImageChecks;
    try {
      // A status call can draw for tens of seconds. Two independent jobs may progress together.
      for (let offset = 0; offset < jobs.length; offset += 2) {
        if (this.unloaded || this.hidden) return;
        await Promise.all(jobs.slice(offset, offset + 2).map(async jobId => {
          try {
            const { job } = await storyImageApi.checkImageJob(jobId, this.data.storyId || this.data.memberId, this.data.memoryId || undefined);
            if (this.unloaded || this.hidden) return;
            this.setData({
              groups: this.data.groups.map(group => ({ ...group,
                pending: group.pending.map(item => item.jobId === job.jobId ? jobRow(job) : item),
              })),
              ...(job.chapterId === this.data.noticeChapterId ? { notice: job.message } : {}),
            });
            if (!isActiveJob(job)) changed = true;
          } catch (error) {
            if (!this.unloaded && !this.hidden) this.setData({ notice: messageOf(error, "暂时查不到进度，稍后会再看一次"), noticeChapterId: "" });
          }
        }));
      }
      if (changed && !this.unloaded && !this.hidden) {
        await this.refresh(true).catch(error => {
          logLoadError("story-images", error);
          if (!this.unloaded && !this.hidden) this.setData({ notice: messageOf(error, "配图暂时没加载出来，请重试。"), noticeChapterId: "" });
        });
      }
    } finally {
      this.polling = false;
      this.schedulePoll();
    }
  },
  toggleSelection() { this.setData({selectionExpanded:!this.data.selectionExpanded}); },
  async generateCover() {
    if (!this.data.storyId || this.data.submitting || this.data.savingBackdrop || this.data.savingPlacement) return;
    this.setData({submitting:'cover',noticeChapterId:'',notice:''});
    try {
      const job = await storyCoverApi.submit({storyId:this.data.storyId,referenceImageIds:[],referencePhotoIds:[]});
      if(this.unloaded)return;
      this.setData({coverJobs:[jobRow(job),...this.data.coverJobs],notice:job.message});
      if(isActiveJob(job))this.activeJobIds=[...new Set([...this.activeJobIds,job.jobId])];
      this.schedulePoll(true);
    } catch(error) { if(!this.unloaded)this.setData({notice:messageOf(error,'封面暂时没生成成功')}); }
    finally { if(!this.unloaded)this.setData({submitting:''}); }
  },
  async usePreviewCover() {
    const image=this.data.preview;
    if(!image?.isCover || !this.data.storyId || this.data.savingBackdrop || this.data.submitting)return;
    this.setData({savingBackdrop:true});
    try {
      await storyCoverApi.select(this.data.storyId,image.inUse ? '' : image.imageId,this.data.storyVersion);
      this.setData({preview:null});
      await this.refresh();
    } catch(error) { this.setData({previewNotice:messageOf(error,'封面未能保存')}); }
    finally { this.setData({savingBackdrop:false}); }
  },
  async generate(event: { currentTarget: { dataset: { id: string; purpose?: string; reference?: string } } }) {
    const chapterId = event.currentTarget.dataset.id;
    const referenceImageId = event.currentTarget.dataset.reference;
    const purpose: StoryImagePurpose = event.currentTarget.dataset.purpose === "backdrop" ? "backdrop" : "illustration";
    const group = this.data.groups.find(item => item.id === chapterId);
    if (this.confirmingGeneration || this.data.submitting || this.data.pickingReference || this.data.removingId || this.data.savingBackdrop || this.data.savingPlacement || !chapterId) return;
    if (this.data.selectedText) {
      this.confirmingGeneration = true;
      const confirmed = await new Promise<boolean>(resolve => wx.showModal({ title: '根据这段文字生成图片',
        content: this.data.selectedText + '\n\n生成成功会产生供应商费用，确认后开始。',
        confirmText: '确认生成', success: result => resolve(result.confirm), fail: () => resolve(false) }));
      this.confirmingGeneration = false;
      if (!confirmed || this.unloaded || this.data.submitting) return;
    }
    const phoneIds = (this.data.phoneReferences[chapterId] || []).map(photo => photo.id);
    const referencePhotoIds = this.data.selectedText ? [] : [...new Set([...phoneIds, ...(this.data.useChapterPhotos[chapterId] ? group?.referencePhotoIds || [] : [])])].slice(0, 3);
    this.setData({
      submitting: [chapterId, purpose, referenceImageId].filter(Boolean).join(":"),
      notice: this.data.memoryId ? "正在读取这段回忆，准备配图…" : "正在读取这一章，准备配图…", noticeChapterId: chapterId,
    });
    try {
      const job = await storyImageApi.submitChapterImage({
        ...(this.data.memoryId ? {memoryId:this.data.memoryId} : this.data.storyId ? { storyId: this.data.storyId } : { memberId: this.data.memberId }), chapterId, purpose,
        ...(this.data.selectedText ? { selectedText: this.data.selectedText, selectedBlockId: this.data.selectedBlockId } : {}),
        ...(referenceImageId ? { referenceImageId } : {}),
        ...(!referenceImageId && referencePhotoIds.length ? { referencePhotoIds,
          ...(phoneIds.length ? { phoneReferencePhotoIds: phoneIds.filter(id => referencePhotoIds.includes(id)) } : {}) } : {}),
        ...(this.data.artDirections[chapterId]?.trim() ? { artDirection: this.data.artDirections[chapterId].trim() } : {}),
      });
      if (this.unloaded) return;
      // submit already contains the job; a full reload here delays the first generation call.
      ++this.refreshId;
      this.setData({ notice: job.message, groups: this.data.groups.map(group => group.id === job.chapterId
        ? { ...group, pending: [jobRow(job), ...group.pending.filter(item => item.jobId !== job.jobId)] } : group) });
      if (isActiveJob(job)) this.activeJobIds = [...new Set([...this.activeJobIds, job.jobId])];
      this.schedulePoll(true);
    } catch (error) {
      if (this.unloaded) return;
      this.setData({ notice: messageOf(error, "配图没成功，请稍后再试") });
      if (error instanceof StoryImageServiceError && error.code === "TIMEOUT") {
        await this.refresh(true).catch((error) => logLoadError("story-images", error));
      }
    } finally {
      if (!this.unloaded) this.setData({ submitting: "" });
    }
  },
  onReferenceModeChange(event: { currentTarget: { dataset: { id: string } }; detail: { value: boolean } }) {
    if (this.data.submitting || this.data.savingBackdrop || this.data.savingPlacement || this.data.removingId) return;
    const chapterId = event.currentTarget.dataset.id;
    if (!this.data.groups.some(group => group.id === chapterId)) return;
    this.setData({ useChapterPhotos: { ...this.data.useChapterPhotos, [chapterId]: event.detail.value === true } });
  },
  async addPhoneReference(event: { currentTarget: { dataset: { id: string } } }) {
    const chapterId = event.currentTarget.dataset.id;
    if (!this.data.groups.some(group => group.id === chapterId) || this.data.pickingReference || this.data.submitting) return;
    const existing = this.data.phoneReferences[chapterId] || [];
    if (existing.length >= 3) { this.setData({ notice: '最多选 3 张手机参考图', noticeChapterId: chapterId }); return; }
    this.setData({ pickingReference: chapterId });
    try {
      const photos = await choosePhoneReferencePhotos(3 - existing.length);
      if (this.unloaded) return;
      this.setData({ phoneReferences: { ...this.data.phoneReferences, [chapterId]: [...existing, ...photos] },
        notice: photos.length ? '已选手机照片；生成时会优先参考它们，不会放进正文' : '', noticeChapterId: chapterId });
    } catch (error) {
      if (!this.unloaded && !isPhotoPickerCancel(error)) this.setData({ notice: messageOf(error, '无法选择照片，请检查相册权限'), noticeChapterId: chapterId });
    } finally { if (!this.unloaded) this.setData({ pickingReference: '' }); }
  },
  removePhoneReference(event: { currentTarget: { dataset: { chapter: string; id: string } } }) {
    if (this.data.submitting || this.data.pickingReference) return;
    const { chapter, id } = event.currentTarget.dataset;
    this.setData({ phoneReferences: { ...this.data.phoneReferences,
      [chapter]: (this.data.phoneReferences[chapter] || []).filter(photo => photo.id !== id) } });
  },
  onArtDirectionInput(event: { currentTarget: { dataset: { id: string } }; detail: { value: string } }) {
    const chapterId = event.currentTarget.dataset.id;
    if (!chapterId) return;
    this.setData({ artDirections: { ...this.data.artDirections, [chapterId]: event.detail.value } });
  },
  /** Chooses a backdrop picture for a chapter, or clears it when the image id is empty. */
  async setBackdrop(event: { currentTarget: { dataset: { chapter: string; image?: string } } }) {
    const chapterId = event.currentTarget.dataset.chapter;
    const imageId = event.currentTarget.dataset.image ?? "";
    if (this.data.memoryId || this.data.savingBackdrop || this.data.savingPlacement || this.data.removingId || this.data.submitting || !chapterId) return;
    ++this.refreshId;
    this.setData({ savingBackdrop: true, notice: "", noticeChapterId: chapterId });
    try {
      await saveChapterBackdrop({ ...(this.data.storyId ? { storyId: this.data.storyId } : { memberId: this.data.memberId }), chapterId, imageId });
      if (this.unloaded) return;
      this.setData({ notice: imageId ? "已设为本章底图，回到书稿就能看到" : "这一章不再使用底图" });
      await this.refresh();
    } catch (error) {
      if (!this.unloaded) this.setData({ notice: messageOf(error, "没保存上，请稍后再试") });
    } finally {
      if (!this.unloaded) this.setData({ savingBackdrop: false });
    }
  },
  previewImage(event: { currentTarget: { dataset: { url: string } } }) {
    const url = event.currentTarget.dataset.url;
    if (!url || this.data.savingPlacement || this.data.savingBackdrop || this.data.removingId || this.data.submitting) return;
    const cover = this.data.coverImages.find(image=>image.url === url);
    if(cover){this.setData({preview:{...cover,chapterId:'cover'},roleChapterIndex:0,previewNotice:''});return;}
    const group = this.data.groups.find(item => item.images.some(image => image.url === url));
    const image = group?.images.find(item => item.url === url) || [...this.data.otherImages,...this.data.libraryImages].find(item=>item.url === url);
    if (!image || !this.roomState) {
      wx.previewImage({ current: url, urls: [url] }); return;
    }
    const chapterId = group?.id || this.data.focusChapterId || this.data.groups[0]?.id || '';
    this.setData({roleChapterIndex:Math.max(0,this.data.groups.findIndex(item=>item.id === chapterId))});
    if (image.uploaded || !group) { this.setData({preview:{...image,chapterId},previewNotice:''}); return; }
    this.updatePreviewImage(image, chapterId);
    this.setData({ previewNotice: "" });
  },
  onRoleChapterChange(event: {detail:{value:string}}) {
    if (!this.data.savingPlacement) this.setData({roleChapterIndex:Number(event.detail.value)});
  },
  async useImageRole(event: {currentTarget:{dataset:{role:string}}}) {
    const image = this.data.preview, purpose = event.currentTarget.dataset.role;
    if (!image || !this.data.storyId || this.data.savingPlacement || this.data.savingBackdrop || this.data.submitting) return;
    const group = this.data.groups[this.data.roleChapterIndex];
    if (purpose !== 'cover' && !group) return;
    this.setData({savingPlacement:true,previewNotice:''});
    try {
      const selected = await callStoryImages<{imageId:string}>('prepareImageRole', {
        storyId:this.data.storyId,chapterId:group?.id || '',imageId:image.imageId,purpose,
      });
      if (purpose === 'cover') await storyCoverApi.select(this.data.storyId,selected.imageId,this.data.storyVersion);
      else if (purpose === 'backdrop') await saveChapterBackdrop({storyId:this.data.storyId,chapterId:group.id,imageId:selected.imageId});
      else await saveChapterIllustration({storyId:this.data.storyId,chapterId:group.id,imageId:selected.imageId,after:null});
      if (this.unloaded) return;
      this.setData({preview:null,notice:`已设为${purpose === 'cover' ? '整本书的封面' : group.label + (purpose === 'backdrop' ? '底图' : '插图')}，原图已保留`,noticeChapterId:''});
      await this.refresh();
    } catch(error) {
      if (!this.unloaded) this.setData({previewNotice:messageOf(error,'没有保存，请重新选择')});
    } finally { if (!this.unloaded) this.setData({savingPlacement:false}); }
  },
  closePreview() {
    if (!this.data.savingPlacement && !this.data.savingBackdrop && !this.data.removingId && !this.data.submitting) this.setData({ preview: null, previewNotice: "" });
  },
  keepPreviewOpen() {},
  onPlacementChange(event: { detail: { value: string } }) {
    if (this.data.savingPlacement || this.data.removingId || this.data.submitting) return;
    const index = Number(event.detail.value);
    if (Number.isInteger(index) && this.data.placementOptions[index]) this.setData({ placementIndex: index });
  },
  async savePlacement(event: { currentTarget?: { dataset?: { remove?: boolean | string } } } = {}) {
    const image = this.data.preview, point = this.data.placementOptions[this.data.placementIndex];
    const remove = event.currentTarget?.dataset?.remove === true || event.currentTarget?.dataset?.remove === 'true';
    if (!image || image.isBackdrop || (!remove && ((!this.data.memoryId && !point) || !image.referenceReady)) || this.data.savingPlacement || this.data.savingBackdrop || this.data.removingId || this.data.submitting) return;
    ++this.refreshId;
    this.setData({ savingPlacement: true, previewNotice: '' });
    try {
      if (this.data.memoryId) await storyImageApi.selectMemoryImage(this.data.memoryId, image.imageId, remove);
      else await saveChapterIllustration({ ...(this.data.storyId ? { storyId: this.data.storyId } : { memberId: this.data.memberId }),
        chapterId: image.chapterId, imageId: image.imageId, after: point?.after || null, remove });
      if (this.unloaded) return;
      await this.refresh();
      const latest = this.data.groups.find(group => group.id === image.chapterId)?.images.find(item => item.imageId === image.imageId);
      if (latest) this.updatePreviewImage(latest, image.chapterId);
      this.setData({ previewNotice: this.data.memoryId ? (remove ? '已从这段记忆移除，原图仍保留' : '已加入这段记忆，返回就能看到') : remove ? '已从正文移除，原图仍保留' : '位置已保存，回到书稿就能看到' });
    } catch (error) {
      // Refresh the paragraph choices after a stale anchor/version, without silently choosing a different position.
      await this.refresh().catch(() => undefined);
      if (!this.unloaded) {
        const latest = this.data.groups.find(group => group.id === image.chapterId)?.images.find(item => item.imageId === image.imageId);
        if (latest) this.updatePreviewImage(latest, image.chapterId);
        this.setData({ placementIndex: -1, previewNotice: messageOf(error, '没有保存，请重试') });
      }
    } finally { if (!this.unloaded) this.setData({ savingPlacement: false }); }
  },
  updatePreviewImage(image: ImageCard, chapterId: string) {
    if (!this.roomState) return;
    if (this.data.memoryId) {
      this.setData({preview:{...image, chapterId}, placementOptions:[], placementIndex:0});
      return;
    }
    const current = currentManuscript(this.roomState, this.data.storyId || this.data.memberId);
    const chapter = current.draft && chaptersOf(current.draft, current.sourceFingerprint).find(item => item.id === chapterId);
    const content = chapter?.content || [];
    if (this.data.storyId && chapter?.layout) {
      this.setData({preview:{...image,chapterId},placementOptions:[{label:'放入文章后，可以直接拖动图片调整位置',after:null,block:0,offset:0}],placementIndex:0});
      return;
    }
    const options = illustrationPoints(content, image.imageId);
    const anchor = image.inText ? illustrationAnchor(content, image.imageId) : null;
    this.setData({ preview: { ...image, chapterId }, placementOptions: options,
      placementIndex: options.findIndex(item => JSON.stringify(item.after) === JSON.stringify(anchor)) });
  },
  async usePreviewBackdrop() {
    const image = this.data.preview;
    if (!image || !image.isBackdrop) return;
    await this.setBackdrop({ currentTarget: { dataset: { chapter: image.chapterId, image: image.inUse ? '' : image.imageId } } });
    const latest = this.data.groups.find(group => group.id === image.chapterId)?.images.find(item => item.imageId === image.imageId);
    if (!this.unloaded && latest) this.setData({ preview: { ...latest, chapterId: image.chapterId }, previewNotice: this.data.notice });
  },
  async redrawPreview() {
    const image = this.data.preview;
    if (image?.referenceReady) await this.generate({ currentTarget: { dataset: { id: image.chapterId, purpose: 'illustration', reference: image.imageId } } });
    if (!this.unloaded) this.setData({ previewNotice: this.data.notice });
  },
  async deletePreview() {
    const image = this.data.preview;
    if (!image || this.data.savingPlacement || this.data.savingBackdrop || this.data.removingId || this.data.submitting) return;
    await this.remove({ currentTarget: { dataset: { id: image.imageId } } });
    if (!this.unloaded) {
      const retained = this.data.groups.some(group => group.images.some(item => item.imageId === image.imageId));
      this.setData({ ...(retained ? {} : { preview: null }), previewNotice: this.data.notice });
    }
  },
  insertIntoBook(event: { currentTarget: { dataset: { id: string; chapter: string; url: string } } }) {
    const { id: imageId, chapter: chapterId, url } = event.currentTarget.dataset;
    const group = this.data.groups.find(item => item.id === chapterId);
    const image = group?.images.find(item => item.imageId === imageId);
    if (!image || image.isBackdrop || chapterId !== this.data.focusChapterId || !url) {
      wx.showToast({ title: "请从对应章节的书稿页插入", icon: "none" });
      return;
    }
    const channel = this.getOpenerEventChannel();
    channel.emit?.("insertStoryImage", { imageId, chapterId, url });
    wx.navigateBack();
  },
  remove(event: { currentTarget: { dataset: { id: string } } }) {
    const imageId = event.currentTarget.dataset.id;
    if (!imageId || this.data.removingId || this.data.savingPlacement || this.data.savingBackdrop || this.data.submitting) return Promise.resolve();
    const usedBy = this.data.groups.find(group => group.backdropImageId === imageId);
    const usedInText = this.data.groups.find(group => group.images.some(image => image.imageId === imageId && image.inText));
    if (usedInText) return new Promise<void>(resolve => wx.showModal({
      title: "先从正文移除",
      content: `这张插图正在${usedInText.label}的正文里使用。请先在大图下点「从正文移除」，再删除原图。`,
      showCancel: false,
      success: () => resolve(), fail: () => resolve(),
    }));
    this.setData({ removingId: imageId });
    return new Promise<void>(resolve => wx.showModal({
      title: "删掉这张图？",
      content: (usedBy ? "它正在用作" + usedBy.label + "的底图，删掉后这一章就没有底图了。" : "") + "删掉后找不回来；已经产生的供应商用量和费用不会撤回。",
      confirmText: "删除",
      success: async result => {
        if (result.confirm) {
          this.setData({ removingId: imageId, notice: "", noticeChapterId: "" });
          try {
            // Unlink first, so a chapter never points at a picture that is already gone.
            if (usedBy) await saveChapterBackdrop({ ...(this.data.storyId ? { storyId: this.data.storyId } : { memberId: this.data.memberId }), chapterId: usedBy.id, imageId: "" });
            await storyImageApi.removeStoryImage(imageId,this.data.storyId || this.data.memberId);
            if (!this.unloaded) {
              this.setData({ notice: "已删除" });
              await this.refresh();
            }
          } catch (error) {
            if (!this.unloaded) this.setData({ notice: messageOf(error, "没删掉，请稍后再试") });
          } finally {
            if (!this.unloaded) this.setData({ removingId: "" });
          }
        }
        if (!this.unloaded) this.setData({ removingId: "" });
        resolve();
      },
      fail: () => { if (!this.unloaded) this.setData({ removingId: "" }); resolve(); },
    }));
  },
  retryLoad() {
    this.setData({ loading: true, loadError: "" });
    this.onShow();
  },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
