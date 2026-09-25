import { saveChapterBackdrop } from "../../services/chapterBackdrop";
import { chapterLabel, chaptersOf } from "../../services/chapters";
import { isRecordingProfile } from "../../domain/biography";
import { currentManuscript } from "../../services/manuscript";
import { loadCurrentMemberRemoteFirst, loadRoomStateRemoteFirst } from "../../services/roomRepository";
import {
  formatBytes, isActiveJob, moderationLabel, nextPollDelayMs, qualityLabel, StoryImage, StoryImageJob, StoryImagePurpose,
  StoryImageServiceError, storyImageApi,
} from "../../services/storyImageService";
import { logLoadError } from "../../services/loadErrorLog";
import { isStoryImageReference, storyImageMatchesReference } from "../../services/bookImages";
import { activeStory } from "../../services/storyBooks";

interface ImageCard {
  imageId: string; url: string; sizeLabel: string; purposeLabel: string;
  isBackdrop: boolean; referenceReady: boolean; inUse: boolean; inText: boolean; moderationLabel: string; qualityLabel: string; qualityFlawed: boolean;
}
interface JobRow { jobId: string; message: string; active: boolean; purposeLabel: string }
interface ChapterGroup {
  id: string; label: string; title: string; backdropImageId: string; backdropMissing: boolean;
  images: ImageCard[]; pending: JobRow[];
}

const PURPOSE_LABELS: Record<string, string> = { illustration: "插图", backdrop: "底图", cover: "封面" };

const card = (image: StoryImage, backdropImageId = "", textImageReferences = new Set<string>()): ImageCard => ({
  imageId: image.imageId, url: image.url, sizeLabel: formatBytes(image.bytes),
  purposeLabel: PURPOSE_LABELS[image.purpose] ?? "配图",
  isBackdrop: image.purpose === "backdrop", referenceReady: image.purpose === "illustration" && image.moderation === "pass",
  inUse: !!backdropImageId && image.imageId === backdropImageId,
  inText: Array.from(textImageReferences).some(reference => storyImageMatchesReference(image.imageId, reference)),
  moderationLabel: moderationLabel(image.moderation), qualityLabel: qualityLabel(image), qualityFlawed: image.quality === "flawed",
});
const jobRow = (job: StoryImageJob): JobRow => ({
  jobId: job.jobId, message: job.message, active: isActiveJob(job), purposeLabel: PURPOSE_LABELS[job.purpose] ?? "配图",
});
const messageOf = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

/**
 * 这本书的图：按章节列出插图和底图，可以给一章配图、选本章底图、看大图、删除，并显示占用的空间。
 * 配图以本章为画面主体，只从其他章节取人物连续性线索；正在画的图在页面打开时轮询，离开页面就停。
 */
Page({
  data: {
    storyId: "", memberId: "", bookTitle: "", focusChapterId: "",
    groups: [] as ChapterGroup[], otherImages: [] as ImageCard[],
    usageLabel: "", limitsLabel: "", loading: true, loadError: "", notice: "", noticeChapterId: "",
    submitting: "", removingId: "", savingBackdrop: false,
    artDirections: {} as Record<string, string>,
  },
  unloaded: false,
  hidden: false,
  activeJobIds: [] as string[],
  pollStartedAt: 0,
  pollTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  requestedMemberId: "",
  requestedStoryId: "",

  onLoad(options: { storyId?: string; memberId?: string; chapterId?: string } = {}) {
    this.unloaded = false;
    if (options.memberId) {
      try { this.requestedMemberId = decodeURIComponent(options.memberId); } catch { this.requestedMemberId = ""; }
    }
    if (options.storyId) {
      try { this.requestedStoryId = decodeURIComponent(options.storyId); } catch { this.requestedStoryId = ""; }
    }
    if (!options.chapterId) return;
    try {
      this.setData({ focusChapterId: decodeURIComponent(options.chapterId) });
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
  async refresh() {
    const state = await loadRoomStateRemoteFirst();
    const story = this.requestedStoryId ? activeStory(state, this.requestedStoryId) : undefined;
    const member = story ? undefined : (this.requestedMemberId
      ? state.members.find(item => item.id === this.requestedMemberId && isRecordingProfile(item))
      : await loadCurrentMemberRemoteFirst(state));
    const bookId = story?.id || member?.id || "";
    if (!bookId) throw new Error("这本书已不可用，请重新选择");
    const current = currentManuscript(state, bookId);
    const chapters = current.draft ? chaptersOf(current.draft, current.sourceFingerprint) : [];
    const list = await storyImageApi.listStoryImages(bookId);
    if (this.unloaded) return;
    const known = new Set(chapters.map(chapter => chapter.id));
    const listed = new Set(list.images.map(image => image.imageId));
    this.activeJobIds = list.pending.filter(isActiveJob).map(job => job.jobId);
    if (!this.activeJobIds.length) this.pollStartedAt = 0;
    this.setData({
      storyId: story?.id || "", memberId: member?.id || this.requestedMemberId,
      bookTitle: current.draft?.title ?? story?.bookTitle ?? story?.title ?? "",
      groups: chapters.map((chapter, index) => {
        const backdropImageId = chapter.backdropImageId ?? "";
        const textImageReferences = new Set(chapter.content.flatMap(item => item.photoId && isStoryImageReference(item.photoId) ? [item.photoId] : []));
        return {
          id: chapter.id, label: chapterLabel(index + 1), title: chapter.title, backdropImageId,
          // The chosen picture was deleted or failed the platform check.
          backdropMissing: !!backdropImageId && !listed.has(backdropImageId),
          images: list.images.filter(image => image.chapterId === chapter.id).map(image => card(image, backdropImageId, textImageReferences)),
          pending: list.pending.filter(job => job.chapterId === chapter.id).map(jobRow),
        };
      }),
      // A chapter can be deleted after it got pictures; its pictures stay manageable here.
      otherImages: list.images.filter(image => image.purpose !== "cover" && !known.has(image.chapterId)).map(image => card(image)),
      usageLabel: `共 ${list.usage.count} 张 · ${formatBytes(list.usage.bytes)}`,
      limitsLabel: `每天最多画 ${list.limits.daily} 张，这本书最多 ${list.limits.book} 张；没画成的不算。`,
      loading: false,
      loadError: "",
    });
    this.schedulePoll();
  },
  clearPoll() {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  },
  schedulePoll() {
    this.clearPoll();
    if (this.unloaded || this.hidden || !this.activeJobIds.length) return;
    if (!this.pollStartedAt) this.pollStartedAt = Date.now();
    this.pollTimer = setTimeout(() => { void this.pollOnce(); }, nextPollDelayMs(Date.now() - this.pollStartedAt));
  },
  async pollOnce() {
    this.pollTimer = undefined;
    if (this.unloaded || this.hidden) return;
    let changed = false;
    for (const jobId of this.activeJobIds) {
      try {
        const { job } = await storyImageApi.checkImageJob(jobId,this.data.storyId || this.data.memberId);
        if (!this.unloaded && !this.hidden && job.chapterId === this.data.noticeChapterId) this.setData({ notice: job.message });
        if (!isActiveJob(job)) changed = true;
      } catch (error) {
        this.setData({ notice: messageOf(error, "暂时查不到进度，稍后会再看一次"), noticeChapterId: "" });
      }
    }
    if (this.unloaded || this.hidden) return;
    if (changed) {
      await this.refresh().catch(error => { logLoadError("story-images", error); this.setData({ notice: messageOf(error, "配图暂时没加载出来，请重试。"), noticeChapterId: "" }); });
    } else {
      this.schedulePoll();
    }
  },
  async generate(event: { currentTarget: { dataset: { id: string; purpose?: string; reference?: string } } }) {
    const chapterId = event.currentTarget.dataset.id;
    const referenceImageId = event.currentTarget.dataset.reference;
    const purpose: StoryImagePurpose = event.currentTarget.dataset.purpose === "backdrop" ? "backdrop" : "illustration";
    if (this.data.submitting || this.data.savingBackdrop || !chapterId) return;
    this.setData({
      submitting: [chapterId, purpose, referenceImageId].filter(Boolean).join(":"),
      notice: "正在读取这一章，准备配图…", noticeChapterId: chapterId,
    });
    try {
      const job = await storyImageApi.submitChapterImage({
        ...(this.data.storyId ? { storyId: this.data.storyId } : { memberId: this.data.memberId }), chapterId, purpose,
        ...(referenceImageId ? { referenceImageId } : {}),
        ...(this.data.artDirections[chapterId]?.trim() ? { artDirection: this.data.artDirections[chapterId].trim() } : {}),
      });
      if (this.unloaded) return;
      this.setData({ notice: job.message });
      await this.refresh();
    } catch (error) {
      if (this.unloaded) return;
      this.setData({ notice: messageOf(error, "配图没成功，请稍后再试") });
      if (error instanceof StoryImageServiceError && error.code === "TIMEOUT") {
        await this.refresh().catch((error) => logLoadError("story-images", error));
      }
    } finally {
      if (!this.unloaded) this.setData({ submitting: "" });
    }
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
    if (this.data.savingBackdrop || !chapterId) return;
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
    if (!url) return;
    const urls = this.data.groups.flatMap(group => group.images).concat(this.data.otherImages).map(image => image.url).filter(Boolean);
    wx.previewImage({ current: url, urls });
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
    if (!imageId || this.data.removingId) return Promise.resolve();
    const usedBy = this.data.groups.find(group => group.backdropImageId === imageId);
    const usedInText = this.data.groups.find(group => group.images.some(image => image.imageId === imageId && image.inText));
    if (usedInText) return new Promise<void>(resolve => wx.showModal({
      title: "先从正文移除",
      content: `这张插图正在${usedInText.label}的正文里使用。请回到书稿删除图片并保存后，再来删除原图。`,
      showCancel: false,
      success: () => resolve(), fail: () => resolve(),
    }));
    return new Promise<void>(resolve => wx.showModal({
      title: "删掉这张图？",
      content: (usedBy ? "它正在用作" + usedBy.label + "的底图，删掉后这一章就没有底图了。" : "") + "删掉后找不回来；这张图用掉的名额不会返还。",
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
        resolve();
      },
      fail: () => resolve(),
    }));
  },
  retryLoad() {
    this.setData({ loading: true, loadError: "" });
    this.onShow();
  },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
