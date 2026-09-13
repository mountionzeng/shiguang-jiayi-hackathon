import { chapterLabel, chaptersOf } from "../../services/chapters";
import { currentManuscript } from "../../services/manuscript";
import { loadCurrentMemberRemoteFirst, loadRoomStateRemoteFirst } from "../../services/roomRepository";
import {
  formatBytes, isActiveJob, moderationLabel, nextPollDelayMs, StoryImage, StoryImageJob, StoryImageServiceError, storyImageApi,
} from "../../services/storyImageService";

interface ImageCard { imageId: string; url: string; sizeLabel: string; moderationLabel: string }
interface JobRow { jobId: string; message: string; active: boolean }
interface ChapterGroup { id: string; label: string; title: string; images: ImageCard[]; pending: JobRow[] }

const card = (image: StoryImage): ImageCard => ({
  imageId: image.imageId, url: image.url, sizeLabel: formatBytes(image.bytes), moderationLabel: moderationLabel(image.moderation),
});
const jobRow = (job: StoryImageJob): JobRow => ({ jobId: job.jobId, message: job.message, active: isActiveJob(job) });
const messageOf = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

/**
 * 这本书的图：按章节列出生成过的配图，可以给一章配图、看大图、删除，并显示占用的空间。
 * 配图只根据已保存的章节文字来画；正在画的图在页面打开时轮询，离开页面就停。
 */
Page({
  data: {
    memberId: "", bookTitle: "", focusChapterId: "",
    groups: [] as ChapterGroup[], otherImages: [] as ImageCard[],
    usageLabel: "", limitsLabel: "", loading: true, loadError: "", notice: "",
    submittingChapterId: "", removingId: "",
  },
  unloaded: false,
  hidden: false,
  activeJobIds: [] as string[],
  pollStartedAt: 0,
  pollTimer: undefined as ReturnType<typeof setTimeout> | undefined,

  onLoad(options: { chapterId?: string } = {}) {
    this.unloaded = false;
    if (!options.chapterId) return;
    try {
      this.setData({ focusChapterId: decodeURIComponent(options.chapterId) });
    } catch {
      // 参数坏了就不高亮任何一章。
    }
  },
  onShow() {
    this.hidden = false;
    void this.refresh().catch(error => this.setData({ loading: false, loadError: messageOf(error, "配图暂时没加载出来，请重试。") }));
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
    const member = await loadCurrentMemberRemoteFirst(state);
    const current = currentManuscript(state, member.id);
    const chapters = current.draft ? chaptersOf(current.draft, current.sourceFingerprint) : [];
    const list = await storyImageApi.listStoryImages(member.id);
    if (this.unloaded) return;
    const known = new Set(chapters.map(chapter => chapter.id));
    this.activeJobIds = list.pending.filter(isActiveJob).map(job => job.jobId);
    if (!this.activeJobIds.length) this.pollStartedAt = 0;
    this.setData({
      memberId: member.id,
      bookTitle: current.draft?.title ?? "",
      groups: chapters.map((chapter, index) => ({
        id: chapter.id, label: chapterLabel(index + 1), title: chapter.title,
        images: list.images.filter(image => image.chapterId === chapter.id).map(card),
        pending: list.pending.filter(job => job.chapterId === chapter.id).map(jobRow),
      })),
      // A chapter can be deleted after it got pictures; its pictures stay manageable here.
      otherImages: list.images.filter(image => !known.has(image.chapterId)).map(card),
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
        const { job } = await storyImageApi.checkImageJob(jobId);
        if (!isActiveJob(job)) changed = true;
      } catch (error) {
        this.setData({ notice: messageOf(error, "暂时查不到进度，稍后会再看一次") });
      }
    }
    if (this.unloaded || this.hidden) return;
    if (changed) {
      await this.refresh().catch(error => this.setData({ notice: messageOf(error, "配图暂时没加载出来，请重试。") }));
    } else {
      this.schedulePoll();
    }
  },
  async generate(event: { currentTarget: { dataset: { id: string } } }) {
    const chapterId = event.currentTarget.dataset.id;
    if (this.data.submittingChapterId || !chapterId) return;
    this.setData({ submittingChapterId: chapterId, notice: "" });
    try {
      const job = await storyImageApi.submitIllustration({ memberId: this.data.memberId, chapterId });
      if (this.unloaded) return;
      this.setData({ notice: job.message });
      await this.refresh();
    } catch (error) {
      if (this.unloaded) return;
      this.setData({ notice: messageOf(error, "配图没成功，请稍后再试") });
      if (error instanceof StoryImageServiceError && error.code === "TIMEOUT") {
        await this.refresh().catch(() => undefined);
      }
    } finally {
      if (!this.unloaded) this.setData({ submittingChapterId: "" });
    }
  },
  previewImage(event: { currentTarget: { dataset: { url: string } } }) {
    const url = event.currentTarget.dataset.url;
    if (!url) return;
    const urls = this.data.groups.flatMap(group => group.images).concat(this.data.otherImages).map(image => image.url).filter(Boolean);
    wx.previewImage({ current: url, urls });
  },
  remove(event: { currentTarget: { dataset: { id: string } } }) {
    const imageId = event.currentTarget.dataset.id;
    if (!imageId || this.data.removingId) return Promise.resolve();
    return new Promise<void>(resolve => wx.showModal({
      title: "删掉这张图？",
      content: "删掉后找不回来；这张图用掉的名额不会返还。",
      confirmText: "删除",
      success: async result => {
        if (result.confirm) {
          this.setData({ removingId: imageId, notice: "" });
          try {
            await storyImageApi.removeStoryImage(imageId);
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
  onShareAppMessage() { return { title: "拾光Ai｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光Ai｜把重要的故事慢慢写下来" }; },
});
