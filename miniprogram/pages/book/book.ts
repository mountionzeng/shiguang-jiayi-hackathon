import { BiographyDraft, ManuscriptContent, ManuscriptRevision, personalBookContributions, personalBookSourceFingerprint } from "../../domain/biography";
import { BiographyFallbackReason, generateBiographyWithStatus } from "../../services/biographyService";
import { loadCurrentMemberRemoteFirst, loadRoomStateRemoteFirst, roomDataModeLabel } from "../../services/roomRepository";
import { adoptCandidateDraft, currentManuscript, makeRevision, manuscriptHistory, saveManuscriptRevision } from "../../services/manuscript";
import { contentFromDelta, contentToDelta, readLocalPhoto, saveLocalPhoto, validateContent } from "../../services/bookImages";

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

Page({
  data: {
    protagonistName: "", memberId: "", sources: [] as Array<{ id: string; text: string; byline: string }>,
    sourceCount: 0, draft: null as BiographyDraft | null,
    generating: false, saving: false, isCloudDraft: false, modeLabel: "", modeNote: "",
    stale: false, showSources: false, editing: false, editTitle: "", editBody: "",
    candidate: null as BiographyDraft | null, candidateFingerprint: "", candidateNote: "", candidatePhotoCount: 0,
    history: [] as ManuscriptRevision[], showHistory: false,
    previewVersion: null as ManuscriptRevision | null,
    loadError: "", storageLabel: "", versionName: "", saveNotice: "",
    keyboardHeight: 0, viewportHeight: 0, panel: "", moreOpen: false, editorKeys: [0], pickingPhoto: false, editorReady: false,
    previewBlocks: [] as Array<{ text?: string; path?: string }>,
  },
  // Native inputs own their live value/cursor. Do not echo the document on each keystroke.
  titleBuffer: "",
  bodyBuffer: "",
  contentBuffer: [] as ManuscriptContent[],
  photoPaths: {} as Record<string, string>,
  imageIds: {} as Record<string, string>,
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

  onLoad() {
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
    if (!this.data.editing && !this.data.candidate && !this.data.saving && !this.data.pickingPhoto) {
      void this.refresh().catch(() => this.setData({ loadError: "书稿暂时加载失败，请重试。已有内容不会被清空。" }));
    }
  },
  async refresh(nextState?: Awaited<ReturnType<typeof loadRoomStateRemoteFirst>>) {
    const refreshId = ++this.refreshId;
    const state = nextState ?? await loadRoomStateRemoteFirst();
    const member = await loadCurrentMemberRemoteFirst(state);
    const qualified = personalBookContributions(state.contributions, member.id);
    const current = currentManuscript(state, member.id);
    if ((this.data.editing && !this.data.saving) || this.data.pickingPhoto || this.unloaded) return;
    const body = current.draft?.paragraphs.join("\n\n") ?? "";
    // Recover photo references also when an older draft contains textual markers.
    const content = contentFromDelta(contentToDelta(current.draft?.content ?? [{ text: body + "\n" }], {}), {});
    const photoPaths: Record<string, string> = {};
    const imageIds: Record<string, string> = {};
    for (const item of content) {
      if (item.photoId) {
        const path = await readLocalPhoto(item.photoId);
        if (path) { photoPaths[item.photoId] = path; imageIds[path] = item.photoId; }
      }
    }
    if (this.unloaded || refreshId !== this.refreshId || (this.data.editing && !this.data.saving) || this.data.pickingPhoto) return;
    this.revisionId = current.revisionId;
    this.sourceFingerprint = current.sourceFingerprint;
    this.titleBuffer = current.draft?.title ?? "";
    this.bodyBuffer = body;
    this.contentBuffer = content;
    this.photoPaths = photoPaths;
    this.imageIds = imageIds;
    this.setData({
      editTitle: this.titleBuffer, editBody: this.bodyBuffer,
      protagonistName: member.name, memberId: member.id,
      sources: qualified.map(item => ({ id: item.id, text: item.text, byline: member.name + " · 亲自讲述" })),
      sourceCount: qualified.length, draft: current.draft ?? null,
      isCloudDraft: current.draft?.generationMode === "cloud-ai",
      modeLabel: "当前书稿", modeNote: "可以直接编辑。新增记忆不会自动改动这份正文。",
      stale: !!current.draft && current.sourceFingerprint !== personalBookSourceFingerprint(state, member.id),
      history: manuscriptHistory(state, member.id), storageLabel: roomDataModeLabel(), loadError: "",
    });
    this.seedEditor();
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
    if (!this.data.draft || this.data.panel || this.data.saving || this.data.generating || this.data.pickingPhoto) return;
    if (!this.editorContext || !this.data.editorReady) { wx.showToast({ title: "编辑器还没准备好，请稍候", icon: "none" }); return; }
    this.setData({ pickingPhoto: true, saveNotice: "" });
    try {
      await this.collectEditor();
      if (this.contentBuffer.filter(item => item.photoId).length >= 9) throw new Error("一篇书稿最多放 9 张照片");
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
  toggleSources() {
    if (this.canLeaveEditor()) this.setData({ panel: "sources", showSources: true });
  },
  toggleHistory() {
    if (this.canLeaveEditor()) this.setData({ panel: "history", showHistory: true, previewVersion: null });
  },
  closePanel() { if (!this.data.saving) this.setData({ panel: "", showHistory: false, showSources: false, previewVersion: null }); },
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
      case "generate":
        if (this.data.candidate) this.setData({ panel: "candidate" });
        else void this.generateChapter();
        break;
      case "sources": this.toggleSources(); break;
      case "record": this.startInterview(); break;
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
  cancelEdit() {
    if (this.data.saving) return;
    wx.showModal({ title: "放弃未保存的修改？", content: "已保存的书稿和历史版本不会改变。", success: result => {
      if (result.confirm) {
        this.pendingSave = undefined;
        this.titleBuffer = this.data.draft?.title ?? "";
        this.bodyBuffer = this.data.draft?.paragraphs.join("\n\n") ?? "";
        this.contentBuffer = this.data.draft?.content?.map(item => ({ ...item })) ?? [{ text: this.bodyBuffer + "\n" }];
        this.editorContext = undefined;
        // Explicit discard remounts native fields, even if the original bound value is unchanged.
        this.setData({
          editing: false, editTitle: this.titleBuffer, editBody: this.bodyBuffer,
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
      this.setData({ editing: false, saveNotice: kind === "draft" ? "修改已保存" : "版本已保存，旧版仍然保留" });
      wx.disableAlertBeforeUnload();
      return true;
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "暂未确认保存，请重试；当前文字仍保留" });
      return false;
    } finally { this.setData({ saving: false }); }
  },
  async saveEdits() {
    if (!this.data.draft || this.data.saving || this.data.pickingPhoto || this.collecting) return;
    this.collecting = true;
    try {
      await this.collectEditor();
      validateContent(this.contentBuffer);
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "无法读取完整图文，请重试；尚未覆盖已保存内容" });
      return;
    } finally { this.collecting = false; }
    const title = this.titleBuffer.trim();
    const paragraphs = this.bodyBuffer.split(/\n\s*\n/).map(text => text.trim()).filter(Boolean);
    if (!title || !paragraphs.length) { this.setData({ saveNotice: "请填写标题和正文" }); return; }
    await this.persist({ ...this.data.draft, title, paragraphs, content: this.editorContext ? this.contentBuffer : [{ text: this.bodyBuffer }] }, this.sourceFingerprint, "draft", "编辑存档");
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
  async generateChapter() {
    if (this.data.generating || this.data.saving || this.data.editing) return;
    this.setData({ generating: true, saveNotice: "" });
    try {
      const state = await loadRoomStateRemoteFirst();
      const member = await loadCurrentMemberRemoteFirst(state);
      if (!personalBookContributions(state.contributions, member.id).length) throw new Error("先记录一段经历，再请 AI 整理");
      const fingerprint = personalBookSourceFingerprint(state, member.id);
      const { draft: candidate, fallbackReason } = await generateBiographyWithStatus(state, member);
      const latest = await loadRoomStateRemoteFirst();
      if (fingerprint !== personalBookSourceFingerprint(latest, member.id)) throw new Error("素材刚刚变了，请重新整理");
      this.setData({
        candidate, candidateFingerprint: fingerprint, panel: "candidate",
        candidateNote: fallbackReason ? "这次没有用上在线 AI（" + FALLBACK_REASONS[fallbackReason] + "），下面只是把原话按顺序排在一起的本地演示稿。" : "",
        candidatePhotoCount: adoptCandidateDraft(this.data.draft ?? undefined, candidate).keptPhotoIds.length,
      });
    } catch (error) {
      this.setData({ saveNotice: error instanceof Error ? error.message : "整理失败，请重试" });
    } finally { this.setData({ generating: false }); }
  },
  async adoptCandidate() {
    if (!this.data.candidate || !this.canLeaveEditor()) return;
    try {
      const latest = await loadRoomStateRemoteFirst();
      if (this.data.candidateFingerprint !== personalBookSourceFingerprint(latest, this.data.memberId)) throw new Error("素材已变化，请重新生成候选稿");
      const { draft, keptPhotoIds } = adoptCandidateDraft(this.data.draft ?? undefined, this.data.candidate);
      if (await this.persist(draft, this.data.candidateFingerprint, "version", "采用 AI 整理稿")) {
        this.setData({
          candidate: null, panel: "",
          saveNotice: "已采用新整理稿，标题没变" + (keptPhotoIds.length ? "，原来的 " + keptPhotoIds.length + " 张照片放在正文最后" : "") + "。旧版仍在历史版本里。",
        });
      }
    } catch (error) { this.setData({ saveNotice: error instanceof Error ? error.message : "采用失败，请重试" }); }
  },
  discardCandidate() {
    if (!this.data.saving) {
      this.pendingSave = undefined;
      this.setData({ candidate: null, panel: "" });
      this.onShow();
    }
  },
  startInterview() { wx.navigateTo({ url: "/pages/interview/interview" }); },
  goHome() {
    if (!this.canLeaveEditor()) return;
    wx.reLaunch({ url: "/pages/index/index" });
  },
});
