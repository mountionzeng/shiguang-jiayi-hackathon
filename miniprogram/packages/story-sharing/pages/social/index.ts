import { measurePerformance, startPerformanceMeasure } from '../../../../services/performanceLog';
import { loadSendSnapshot, selectSendText, SendChapter, SendScope, SendSnapshot, SendVersion, takeStagedSendSnapshot } from '../../../../services/bookSend';
import { cachedAccountScope } from '../../../../services/cloudRoomStorage';
import { storyCoverApi, ShareCoverCandidate } from '../../../../services/storyCoverService';
import { bookExportApi, bookExportSelection, memoryBookExportSelection, BookExportSelection, BookExportDescriptor } from '../../../../services/bookExport';
import { renderBookImages, removeImageFiles } from '../../../../services/bookImageRenderer';
import { ImageLayoutMode, ImageFontSize } from '../../../../services/bookImageLayout';
import { sharingHome, storySharing, invitationPath } from '../../../../services/storySharing';
import { memoryExportApi, MemoryExportSource } from '../../../../services/memoryExport';

const saveImageToAlbum = (filePath: string, timeoutMs = 15000) => new Promise<void>((resolve, reject) => {
  let settled = false;
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback();
  };
  const timer = setTimeout(() => finish(() => reject(new Error('相册保存没有响应，请再试一次'))), timeoutMs);
  wx.saveImageToPhotosAlbum({
    filePath,
    success: () => finish(resolve),
    fail: error => finish(() => reject(error)),
  });
});

Page({
  data: {
    loading: false, checking: false, exportBusy: false, albumSaving: false, sharingIndex: -1, exportAvailable: false, capabilityKnown: false,
    layout: 'pages' as ImageLayoutMode, fontSize: 32 as ImageFontSize, canvasHeight: 1080,
    includeMemoryPhotos: true, memoryPhotoCount: 0,
    imagePaths: [] as string[], savedIndices: [] as number[], renderProgress: '', coverImageCount: 0,
    notice: '', title: '', coverUrl: '', coverNotice: '',
    sourceKind: 'story' as 'story' | 'memory',
    destination: 'social' as 'family' | 'social',
    inviteeName: '', invitationBusy: false, familyInviteAvailable: false, familyInviteNotice: '',
    familyCardImageUrl: '', familyShareReady: false,
    coverCandidates: [] as ShareCoverCandidate[], selectedCoverImageIds: [] as string[],
    // 0 = 自动：按字号自然分页。默认自动，避免整本书一进来就因张数不匹配而失败。
    textImageCountOptions: ['自动', ...Array.from({ length: 12 }, (_, index) => String(index + 1))],
    targetTextImageCount: 0,
    scope: 'chapters' as SendScope, chapters: [] as Array<SendChapter & { checked: boolean }>,
    textChapterIndex: 0, selectedText: '', editorReady: false,
    selectedCount: 0, characterCount: 0, preview: false, previewChapters: [] as SendChapter[],
  },
  expected: undefined as SendVersion | undefined,
  expectedMemory: undefined as { memoryId: string; revisionId?: string } | undefined,
  snapshot: undefined as SendSnapshot | undefined,
  memorySource: undefined as MemoryExportSource | undefined,
  editor: undefined as WechatMiniprogram.EditorContext | undefined,
  epoch: 0, hidden: true, editorSeed: 0, genEpoch: 0,
  regenerateTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  exportSelection: undefined as BookExportSelection | undefined,
  descriptor: undefined as BookExportDescriptor | undefined,
  renderTask: undefined as Promise<string[]> | undefined,
  returningFromCover: false,
  familyShare: undefined as { title: string; imageUrl: string; path: string } | undefined,
  albumSaveTimeoutMs: 15000,
  onLoad(options: { storyId?: string; revisionId?: string; version?: string; memoryId?: string; destination?: string } = {}) {
    this.setData({ destination: options.destination === 'family' ? 'family' : 'social' });
    const version = Number(options.version);
    if (options.memoryId) {
      this.expectedMemory = { memoryId: options.memoryId, ...(options.revisionId ? { revisionId: options.revisionId } : {}) };
      this.expected = undefined;
    } else if (options.storyId && options.revisionId && Number.isSafeInteger(version) && version >= 1) {
      this.expected = { storyId: options.storyId, revisionId: options.revisionId, version };
      this.expectedMemory = undefined;
    }
    wx.hideShareMenu();
  },
  onShow() {
    this.hidden = false;
    void (this.returningFromCover ? this.refreshAfterCover() : (this.expectedMemory ? this.refreshMemory() : this.refresh()));
  },
  onHide() {
    clearTimeout(this.regenerateTimer);
    this.hidden = true; this.epoch++; this.editorSeed++; this.snapshot = undefined; this.memorySource = undefined; this.resetImages();
    this.editor?.clear();
    this.editor = undefined;
    this.setData({ loading: false, checking: false, exportBusy: false, albumSaving: false, sharingIndex: -1, exportAvailable: false, capabilityKnown: false, title: '', coverUrl: '', coverNotice: '', sourceKind: 'story',
      inviteeName: '', invitationBusy: false, familyInviteAvailable: false, familyInviteNotice: '',
      coverCandidates: [], selectedCoverImageIds: [], coverImageCount: 0, chapters: [], selectedText: '',
      editorReady: false, preview: false, previewChapters: [], selectedCount: 0, characterCount: 0 });
  },
  onUnload() { this.onHide(); this.editor = undefined; this.expected = undefined; this.expectedMemory = undefined; },
  async refresh() {
    const epoch = ++this.epoch;
    const finishDisplay = startPerformanceMeasure('book.send-display');
    this.snapshot = undefined; this.resetImages();
    this.setData({ loading: true, exportAvailable: false, capabilityKnown: false, notice: '', title: '', sourceKind: 'story', chapters: [], coverUrl: '', coverNotice: '', selectedText: '',
      selectedCount: 0, characterCount: 0, preview: false, previewChapters: [], editorReady: false, textChapterIndex: 0 });
    try {
      if (!this.expected) throw new Error('请从书稿目录的“发送”重新进入');
      const staged = takeStagedSendSnapshot(this.expected, cachedAccountScope());
      // Paint the text just seen in the owner page, but keep all actions blocked
      // until both identity checks and the current saved-version read succeed.
      if (staged) this.setData({ title: staged.title, chapters: staged.chapters.map(chapter => ({ ...chapter, checked: false })) }, () => {
        if (!this.hidden && epoch === this.epoch) finishDisplay('ok', { route: 'local' });
      });
      const snapshot = await loadSendSnapshot(this.expected);
      if (this.hidden || epoch !== this.epoch) return;
      if (staged && snapshot.accountScope !== staged.accountScope) throw new Error('账号已切换，请重新进入发送');
      this.snapshot = snapshot;
      this.setData({ title: snapshot.title, chapters: snapshot.chapters.map(chapter => ({ ...chapter, checked: false })) }, () => {
        if (!staged && !this.hidden && epoch === this.epoch) finishDisplay('ok', { route: 'cloud' });
      });
      this.updateSelection(); this.seedEditor();
      void this.checkExportCapability(epoch);
      if (this.data.destination === 'family') void this.checkFamilyInvitationCapability(epoch);
      void this.loadShareCoverCandidates(snapshot, epoch);
      // Cover arrival updates only the image. It must never reset the selected text.
      if (snapshot.coverImageId) void this.resolveCover(snapshot, epoch);
    } catch (error) {
      if (!this.hidden && epoch === this.epoch) this.setData({ title: '', chapters: [], notice: error instanceof Error ? error.message : '书稿暂时无法读取，请重试' });
    } finally {
      if (!this.hidden && epoch === this.epoch) this.setData({ loading: false });
    }
  },
  async refreshMemory() {
    const epoch = ++this.epoch;
    this.snapshot = undefined; this.memorySource = undefined; this.resetImages();
    this.setData({ loading: true, exportAvailable: false, capabilityKnown: false, notice: '', title: '', sourceKind: 'memory',
      memoryPhotoCount: 0, chapters: [], coverUrl: '', coverNotice: '', selectedText: '', selectedCount: 0, characterCount: 0,
      preview: false, previewChapters: [], editorReady: false, textChapterIndex: 0 });
    try {
      if (!this.expectedMemory) throw new Error('请从记忆页面重新进入发送');
      const result = await memoryExportApi.resolveSource(this.expectedMemory);
      if (this.hidden || epoch !== this.epoch) return;
      this.memorySource = result.source;
      const chapter = this.memoryChapter(result.source);
      this.setData({ memoryPhotoCount: result.source.photoIds?.length || 0, title: result.source.title || '一段记忆', chapters: [{ ...chapter, checked: true }] });
      this.updateSelection();
      void this.checkExportCapability(epoch);
    } catch (error) {
      if (!this.hidden && epoch === this.epoch) this.setData({ notice: error instanceof Error ? error.message : '记忆暂时无法读取，请重试' });
    } finally {
      if (!this.hidden && epoch === this.epoch) this.setData({ loading: false });
    }
  },
  memoryChapter(source: MemoryExportSource): SendChapter {
    return {
      id: 'memory-' + source.memoryId,
      title: source.title || '一段记忆',
      text: source.text,
      characterCount: Array.from(source.text).length,
    };
  },
  async resolveCover(snapshot: SendSnapshot, epoch: number) {
    try {
      const url = await storyCoverApi.resolveUrl(snapshot.storyId, snapshot.coverImageId);
      if (!this.hidden && epoch === this.epoch) this.setData({ coverUrl: url, coverNotice: url ? '' : '已有封面暂未读到，可稍后重新加载' });
    } catch {
      if (!this.hidden && epoch === this.epoch) this.setData({ coverNotice: '已有封面暂未读到，可稍后重新加载' });
    }
  },
  async loadShareCoverCandidates(snapshot: SendSnapshot, epoch: number) {
    try {
      const result = await storyCoverApi.listShareCoverCandidates(snapshot.storyId);
      if (this.hidden || epoch !== this.epoch || this.snapshot !== snapshot) return;
      const candidates = result.candidates;
      const selected = snapshot.coverImageId && candidates.some(item => item.imageId === snapshot.coverImageId) ? [snapshot.coverImageId] : [];
      this.setData({ coverCandidates: candidates, selectedCoverImageIds: selected });
    } catch {
      if (!this.hidden && epoch === this.epoch && this.snapshot === snapshot) this.setData({ coverNotice: '封面候选暂未读到，可继续使用默认封面' });
    }
  },
  /** Cover selection increments the story version. Refresh the send snapshot with that new version on return. */
  async refreshAfterCover() {
    this.returningFromCover = false;
    const expected = this.expected;
    if (expected) {
      try {
        const source = await storyCoverApi.sources(expected.storyId);
        if (source.storyId === expected.storyId && source.revisionId && Number.isSafeInteger(source.version) && source.version >= 1) {
          this.expected = { storyId: expected.storyId, revisionId: source.revisionId, version: source.version };
        }
      } catch {
        // refresh below gives the person a normal retry path if the cover page is no longer available.
      }
    }
    await this.refresh();
  },
  makeCover() {
    if (this.busy() || this.data.sourceKind === 'memory' || !this.snapshot?.storyId) return;
    this.returningFromCover = true;
    wx.navigateTo({ url: "/pages/story-cover/story-cover?storyId=" + encodeURIComponent(this.snapshot.storyId) });
  },
  chooseScope(event: WechatMiniprogram.TouchEvent) {
    if (this.data.loading || this.busy()) return;
    const scope = event.currentTarget.dataset.scope as SendScope;
    if (!['book', 'chapters', 'text'].includes(scope)) return;
    if (this.data.destination === 'family' && scope === 'text') return;
    this.resetImages();
    this.setData({ scope, preview: false, previewChapters: [], notice: '' }); this.updateSelection();
  },
  chooseChapters(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) {
    if (this.data.loading || this.busy()) return;
    const ids = new Set(event.detail.value);
    this.resetImages();
    this.setData({ chapters: this.data.chapters.map(chapter => ({ ...chapter, checked: ids.has(chapter.id) })) });
    this.updateSelection();
  },
  chooseTextChapter(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.data.loading || this.busy()) return;
    const index = Number(event.detail.value);
    if (!Number.isInteger(index) || !this.data.chapters[index]) return;
    this.setData({ textChapterIndex: index, selectedText: '' }); this.updateSelection(); this.seedEditor();
  },
  onEditorReady() {
    const epoch = this.epoch;
    this.createSelectorQuery().select('#send-text-source').context(result => {
      if (this.hidden || epoch !== this.epoch) return;
      this.editor = result.context as WechatMiniprogram.EditorContext;
      this.seedEditor();
    }).exec();
  },
  seedEditor() {
    const editor = this.editor;
    const text = this.snapshot?.chapters[this.data.textChapterIndex]?.text;
    const seed = ++this.editorSeed;
    this.setData({ editorReady: false });
    if (!editor || text === undefined || this.hidden) return;
    editor.setContents({ delta: { ops: [{ insert: text.endsWith('\n') ? text : text + '\n' }] }, success: () => {
      if (!this.hidden && seed === this.editorSeed) this.setData({ editorReady: true });
    }, fail: () => {
      if (!this.hidden && seed === this.editorSeed) this.setData({ notice: '原文选择器未打开，请重新加载' });
    } });
  },
  captureSelection() {
    if (!this.editor || !this.data.editorReady || this.busy()) return;
    const epoch = this.epoch, seed = this.editorSeed;
    this.editor.getSelectionText({ success: result => {
      if (this.hidden || epoch !== this.epoch || seed !== this.editorSeed) return;
      const chapter = this.snapshot?.chapters[this.data.textChapterIndex];
      const raw = result.text || '';
      // The native editor requires a terminal newline; it is not part of an excerpt.
      const text = chapter && !chapter.text.endsWith('\n') && raw === chapter.text + '\n' ? chapter.text : raw;
      if (!text.trim() || !chapter?.text.includes(text)) {
        this.setData({ notice: '请先长按原文，选中想分享的一段文字' }); return;
      }
      this.setData({ selectedText: text, notice: '' }); this.updateSelection();
    }, fail: () => {
      if (!this.hidden && epoch === this.epoch && seed === this.editorSeed) this.setData({ notice: '没有读到选中文字，请重新长按选择' });
    } });
  },
  selected(): SendChapter[] {
    if (this.memorySource) return [this.memoryChapter(this.memorySource)];
    if (!this.snapshot) return [];
    return selectSendText(this.snapshot, { scope: this.data.scope,
      chapterIds: this.data.chapters.filter(chapter => chapter.checked).map(chapter => chapter.id),
      textChapterId: this.snapshot.chapters[this.data.textChapterIndex]?.id || '', text: this.data.selectedText });
  },
  updateSelection() {
    const selected = this.selected();
    this.setData({ selectedCount: selected.length, characterCount: selected.reduce((sum, chapter) => sum + chapter.characterCount, 0) });
  },
  async previewSelection() {
    if (this.data.loading || this.busy()) return;
    if (this.memorySource && this.expectedMemory) return this.previewMemorySelection();
    if (!this.snapshot || !this.expected) return;
    const epoch = this.epoch, snapshot = this.snapshot;
    const selected = this.selected();
    if (!selected.some(chapter => chapter.text.trim())) { this.setData({ notice: '请先选择要分享的文字' }); return; }
    this.setData({ checking: true, notice: '' });
    try {
      const fresh = await loadSendSnapshot(this.expected);
      if (this.hidden || epoch !== this.epoch) return;
      if (fresh.accountScope !== snapshot.accountScope || JSON.stringify(fresh) !== JSON.stringify(snapshot)) throw new Error('书稿或账号已有变化，请回到目录重新进入发送');
      this.setData({ preview: true, previewChapters: selected });
      this.autoGenerate();
    } catch (error) {
      if (!this.hidden && epoch === this.epoch) {
        this.snapshot = undefined; this.editorSeed++; this.editor?.clear(); this.editor = undefined;
        this.setData({ title: '', coverUrl: '', chapters: [], selectedText: '', editorReady: false, selectedCount: 0, characterCount: 0,
          preview: false, previewChapters: [], notice: error instanceof Error ? error.message : '未能确认当前版本，请重试' });
      }
    } finally {
      if (!this.hidden && epoch === this.epoch) this.setData({ checking: false });
    }
  },
  async previewMemorySelection() {
    const epoch = this.epoch, source = this.memorySource, expected = this.expectedMemory;
    if (!source || !expected) return;
    this.setData({ checking: true, notice: '' });
    try {
      const fresh = await memoryExportApi.recheckSource({ ...expected, expectedSourceVersion: source.sourceVersion });
      if (this.hidden || epoch !== this.epoch) return;
      if (JSON.stringify(fresh.source) !== JSON.stringify(source)) throw new Error('这段记忆已有变化，请重新进入发送');
      const selected = [this.memoryChapter(source)];
      this.setData({ preview: true, previewChapters: selected, selectedCount: 1, characterCount: selected[0].characterCount });
      this.autoGenerate();
    } catch (error) {
      if (!this.hidden && epoch === this.epoch) {
        this.memorySource = undefined; this.resetImages();
        this.setData({ title: '', coverUrl: '', coverNotice: '', chapters: [], selectedText: '', editorReady: false, selectedCount: 0,
          characterCount: 0, preview: false, previewChapters: [], notice: error instanceof Error ? error.message : '未能确认当前记忆，请重试' });
      }
    } finally {
      if (!this.hidden && epoch === this.epoch) this.setData({ checking: false });
    }
  },
  toggleMemoryPhotos() {
    if (this.busy()) return;
    this.resetImages();
    this.setData({ includeMemoryPhotos: !this.data.includeMemoryPhotos });
  },
  busy(): boolean { return this.data.checking || this.data.exportBusy || this.data.albumSaving || this.data.sharingIndex >= 0 || this.data.invitationBusy; },
  async checkFamilyInvitationCapability(epoch: number) {
    try {
      const caps = await storySharing.capabilities();
      if (this.hidden || this.epoch !== epoch) return;
      this.preparedInvitationAvailable = caps.preparedInvitation === true;
      const available = !!caps.familyId && caps.invitations === true && caps.copy === true;
      this.setData({ familyInviteAvailable: available, familyInviteNotice: available ? '' : '阅读邀请和收入自己的故事尚未开放。目前可以查看卡片预览，暂不能发出可加入的邀请。' });
    } catch {
      if (!this.hidden && this.epoch === epoch) this.setData({ familyInviteAvailable: false, familyInviteNotice: '暂时无法确认邀请是否可用，请重新进入。' });
    }
  },
  clearFamilyInvitation() {
    this.familyShare = undefined;
    this.setData({ familyShareReady: false });
  },
  preparedInvitationAvailable: false,
  enterInviteeName(event: WechatMiniprogram.Input) {
    if (this.data.invitationBusy) return;
    this.clearFamilyInvitation();
    this.setData({ inviteeName: event.detail.value });
  },
  async prepareFamilyInvitation() {
    if (this.hidden || this.busy() || this.data.familyShareReady || this.data.destination !== 'family' || !this.data.preview || !this.snapshot || !this.descriptor || !this.exportSelection || !this.data.imagePaths.length) return;
    if (this.data.scope === 'text') {
      this.setData({ familyInviteNotice: '阅读邀请按整章授权，请重新选择整章；选段图片可以从发送到社交媒体进入。' }); return;
    }
    const name = this.data.inviteeName.trim();
    if (!name) { this.setData({ familyInviteNotice: '请写下怎么称呼这位朋友或家人。' }); return; }
    const epoch = this.epoch, snapshot = this.snapshot, descriptor = this.descriptor, selection = this.exportSelection;
    const chapters = this.selected();
    if (descriptor.chapters.length !== chapters.length || descriptor.chapters.some((chapter, index) => chapter.id !== chapters[index].id || chapter.text !== chapters[index].text)) {
      this.setData({ familyInviteNotice: '所选章节与预览不一致，请重新生成图文预览。' }); return;
    }
    const chapterIds = descriptor.chapters.map(chapter => chapter.id);
    if (!chapterIds.length) return;
    const active = () => !this.hidden && this.epoch === epoch && this.snapshot === snapshot;
    this.clearFamilyInvitation();
    this.setData({ invitationBusy: true, familyInviteNotice: '正在核对内容和邀请权限…' });
    const finish = startPerformanceMeasure('invite.prepare');
    let outcome: 'ok' | 'error' = 'error';
    let creating = false;
    try {
      if (this.preparedInvitationAvailable && !('memoryId' in selection)) {
        creating = true;
        const invitation=await storySharing.prepare(selection,descriptor.id,snapshot.accountScope,name);
        if (!active()) return;
        if (invitation.descriptorId!==descriptor.id) throw new Error('图文预览已失效，请重新生成。');
        const imageUrl=invitation.imageUrl || sharingHome.imageUrl;
        this.familyShare={title:snapshot.title,imageUrl,path:invitationPath(invitation.token)};
        this.setData({familyShareReady:true,familyCardImageUrl:imageUrl,
          familyInviteNotice:'邀请已准备好，24 小时内有效。点下方按钮，在微信里选择这位亲友。'});
        outcome='ok';
        return;
      }
      // Each read independently authorizes on the server. Keep the final
      // account/version check after all reads, and drain failures before unlocking
      // retry so a late verifier cannot clear a subsequent attempt's snapshot.
      const [verified, capabilityResult, materialResult] = await Promise.allSettled([
        this.verifySnapshot(snapshot),
        storySharing.capabilities(),
        bookExportApi.material(selection, descriptor.id),
      ]);
      if (verified.status === 'rejected') throw verified.reason;
      if (!active()) return;
      if (capabilityResult.status === 'rejected') throw capabilityResult.reason;
      const caps = capabilityResult.value;
      if (!caps.invitations || !caps.copy || !caps.familyId) {
        this.setData({ familyInviteAvailable: false });
        throw new Error('阅读邀请和收入自己的故事尚未开放，暂不能发出可加入的邀请。');
      }
      if (materialResult.status === 'rejected') throw materialResult.reason;
      const material = materialResult.value;
      if (material.descriptor.id !== descriptor.id) throw new Error('图文预览已失效，请重新生成。');
      await this.verifySnapshot(snapshot); if (!active()) return;
      creating = true;
      const invitation = await storySharing.create(caps.familyId, snapshot.storyId, chapterIds, false, false, true, name);
      if (!active()) return;
      const imageUrl = material.coverUrls?.[0] || material.coverUrl || sharingHome.imageUrl;
      this.familyShare = { title: snapshot.title, imageUrl, path: invitationPath(invitation.token) };
      this.setData({ familyShareReady: true, familyCardImageUrl: imageUrl,
        familyInviteNotice: '邀请已准备好，24 小时内有效。点下方按钮，在微信里选择这位亲友。' });
      outcome = 'ok';
    } catch (error) {
      if (!this.hidden && this.epoch === epoch) this.setData({ familyInviteNotice: (error instanceof Error ? error.message : '暂时无法准备邀请。')
        + (creating ? ' 若结果未确认，请到“亲友阅读与权限”查看，避免重复生成。' : '') });
    } finally { finish(outcome); if (!this.hidden && this.epoch === epoch) this.setData({ invitationBusy: false }); }
  },
  async checkExportCapability(epoch: number) {
    try {
      const available = await bookExportApi.available(this.data.sourceKind);
      if (!this.hidden && epoch === this.epoch) { this.setData({ exportAvailable: available, capabilityKnown: true }); this.autoGenerate(); }
    } catch {
      if (!this.hidden && epoch === this.epoch) this.setData({ exportAvailable: false, capabilityKnown: true, notice: '暂时无法确认图片导出是否可用，请稍后重新加载' });
    }
  },
  /** 进入预览或改选封面/排版后，自动排出接收者会看到的最终图片。 */
  autoGenerate() {
    clearTimeout(this.regenerateTimer);
    this.regenerateTimer = setTimeout(() => {
      if (!this.hidden && this.data.preview && this.data.exportAvailable && !this.data.imagePaths.length && !this.busy()) void this.generateImages();
    }, 300);
  },
  /** 生成中改选封面/排版：停掉本次生成，让人可以马上换选项。 */
  stopGeneration() {
    if (!this.data.exportBusy) return;
    this.genEpoch++;
    this.setData({ exportBusy: false, renderProgress: '' });
  },
  /** 相册保存、分享和内容核对期间不能改；生成中可以改，改了就停止本次生成。 */
  lockedForChoice() { return this.data.checking || this.data.albumSaving || this.data.sharingIndex >= 0 || this.data.invitationBusy; },
  resetImages() {
    this.clearFamilyInvitation();
    removeImageFiles(this.data.imagePaths);
    this.exportSelection = undefined; this.descriptor = undefined;
    this.setData({ imagePaths: [], savedIndices: [], renderProgress: '', coverImageCount: 0, familyCardImageUrl: '' });
  },
  chooseShareCovers(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) {
    if (this.lockedForChoice()) return;
    this.stopGeneration();
    const selected = event.detail.value;
    const ids = selected.slice(0, 6);
    this.resetImages();
    this.setData({ selectedCoverImageIds: ids, notice: selected.length > 6 ? '本次最多选择 6 张封面' : '' }); this.autoGenerate();
  },
  chooseTextImageCount(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.lockedForChoice()) return;
    this.stopGeneration();
    const count = Number(event.detail.value);
    if (!Number.isSafeInteger(count) || count < 0 || count > 12) return;
    this.resetImages();
    this.setData({ targetTextImageCount: count, notice: '' }); this.autoGenerate();
  },
  chooseLayout(event: WechatMiniprogram.TouchEvent) {
    if (this.lockedForChoice()) return;
    this.stopGeneration();
    const layout = event.currentTarget.dataset.layout as ImageLayoutMode;
    if (layout !== 'pages' && layout !== 'long') return;
    this.resetImages(); this.setData({ layout, notice: '' }); this.autoGenerate();
  },
  chooseFont(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.lockedForChoice()) return;
    this.stopGeneration();
    const fontSize = [28, 32, 36][Number(event.detail.value)] as ImageFontSize;
    if (!fontSize) return;
    this.resetImages(); this.setData({ fontSize, notice: '' }); this.autoGenerate();
  },
  async verifySnapshot(snapshot: SendSnapshot) {
    try {
      if (!this.expected) throw new Error('请重新进入发送');
      const fresh = await loadSendSnapshot(this.expected);
      if (JSON.stringify(fresh) !== JSON.stringify(snapshot)) throw new Error('书稿或账号已有变化，请回到目录重新进入发送');
    } catch (error) {
      if (this.snapshot === snapshot) {
        this.snapshot = undefined; this.editorSeed++; this.editor?.clear(); this.editor = undefined; this.resetImages();
        this.setData({ title: '', coverUrl: '', chapters: [], selectedText: '', editorReady: false, selectedCount: 0,
          characterCount: 0, preview: false, previewChapters: [] });
      }
      throw error;
    }
  },
  async verifyMemorySource(source: MemoryExportSource) {
    try {
      if (!this.expectedMemory) throw new Error('请重新进入发送');
      const fresh = await memoryExportApi.recheckSource({ ...this.expectedMemory, expectedSourceVersion: source.sourceVersion });
      if (JSON.stringify(fresh.source) !== JSON.stringify(source)) throw new Error('这段记忆已有变化，请重新进入发送');
    } catch (error) {
      if (this.memorySource === source) {
        this.memorySource = undefined; this.resetImages();
        this.setData({ title: '', coverUrl: '', chapters: [], selectedText: '', editorReady: false, selectedCount: 0,
          characterCount: 0, preview: false, previewChapters: [] });
      }
      throw error;
    }
  },
  async generateImages() {
    if (this.busy() || !this.data.preview || !this.data.exportAvailable) return;
    const source = this.memorySource, snapshot = this.snapshot;
    if (!snapshot && !source) return;
    const epoch = this.epoch, gen = ++this.genEpoch;
    const active = () => !this.hidden && this.epoch === epoch && this.genEpoch === gen;
    this.resetImages(); this.setData({ exportBusy: true, notice: '', renderProgress: '正在核对导出权限…' });
    let paths: string[] = [];
    try {
      await this.renderTask?.catch(() => undefined);
      if (snapshot) await this.verifySnapshot(snapshot); else if (source) await this.verifyMemorySource(source);
      if (!active()) return;
      const selection = snapshot ? bookExportSelection(snapshot, { scope: this.data.scope,
        chapterIds: this.data.chapters.filter(c => c.checked).map(c => c.id),
        textChapterId: snapshot.chapters[this.data.textChapterIndex]?.id || '', text: this.data.selectedText }, {
        coverImageIds: this.data.selectedCoverImageIds,
        targetTextImageCount: this.data.targetTextImageCount,
      })
        : memoryBookExportSelection(source as MemoryExportSource, { targetTextImageCount: this.data.targetTextImageCount, includePhotos: this.data.includeMemoryPhotos });
      this.setData({ renderProgress: '正在准备所选内容…' });
      const preview = await bookExportApi.preview(selection); if (!active()) return;
      this.setData({ renderProgress: '正在读取封面和底图…' });
      const material = await bookExportApi.material(selection, preview.descriptor.id); if (!active()) return;
      const chosen = this.selected();
      if ((snapshot && (material.descriptor.storyId !== snapshot.storyId || material.descriptor.revisionId !== snapshot.revisionId ||
        material.descriptor.storyVersion !== snapshot.version)) ||
        (source && (material.descriptor.sourceKind !== 'memory' || material.descriptor.memoryId !== source.memoryId ||
          material.descriptor.sourceVersion !== source.sourceVersion)) ||
        material.descriptor.chapters.length !== chosen.length ||
        material.descriptor.chapters.some((chapter, i) => chapter.id !== chosen[i].id || chapter.text !== chosen[i].text)) {
        throw new Error('导出内容与所选版本不一致，请重新进入发送');
      }
      this.setData({ renderProgress: '正在排版图片…' });
      const task = measurePerformance('book.export-render', () => renderBookImages(material, this.data.layout, this.data.fontSize, this, active,
        (done, total) => { if (active()) this.setData({ renderProgress: '已生成 ' + done + ' / ' + total + ' 张' }); }));
      this.renderTask = task;
      try { paths = await task; } finally { if (this.renderTask === task) this.renderTask = undefined; }
      if (!active()) { removeImageFiles(paths); return; }
      this.setData({ renderProgress: '图片已排好，正在确认最新版本…' });
      const checked = await bookExportApi.material(selection, preview.descriptor.id);
      if (snapshot) await this.verifySnapshot(snapshot); else if (source) await this.verifyMemorySource(source);
      if (!active()) { removeImageFiles(paths); return; }
      if (checked.descriptor.id !== material.descriptor.id) throw new Error('预览已变化，请重新生成');
      this.descriptor = material.descriptor; this.exportSelection = selection;
      this.setData({ imagePaths: paths, savedIndices: [], coverImageCount: source ? material.descriptor.photoIds?.length || 0 : Math.max(1, material.descriptor.coverImageIds?.length || 0),
        familyCardImageUrl: snapshot ? checked.coverUrls?.[0] || checked.coverUrl || sharingHome.imageUrl : '',
        notice: this.data.destination === 'family' ? '预览已生成。确认卡片和章节后，再准备阅读邀请。' : '这就是对方会收到的样子。满意的话可以直接发送或保存。' });
    } catch (error) {
      removeImageFiles(paths);
      if (active()) this.setData({ notice: error instanceof Error ? error.message : '图片生成失败，请重试' });
    } finally {
      if (active()) this.setData({ exportBusy: false, renderProgress: '' });
    }
  },
  async saveImages() {
    if (this.busy() || (!this.snapshot && !this.memorySource) || !this.descriptor || !this.exportSelection || !this.data.imagePaths.length) return;
    const epoch = this.epoch, snapshot = this.snapshot, source = this.memorySource, descriptor = this.descriptor, selection = this.exportSelection;
    const active = () => !this.hidden && this.epoch === epoch;
    this.setData({ albumSaving: true, notice: '保存前正在核对版本和权限…' });
    let authorized = false;
    try {
      if (snapshot) await this.verifySnapshot(snapshot); else if (source) await this.verifyMemorySource(source);
      if (!active()) return;
      const material = await bookExportApi.material(selection, descriptor.id); if (!active()) return;
      if (material.descriptor.id !== descriptor.id) throw new Error('预览已失效，请重新生成');
      authorized = true;
      const paths = [...this.data.imagePaths], saved = new Set(this.data.savedIndices);
      for (let index = 0; index < paths.length; index++) {
        if (!active()) return;
        if (saved.has(index)) continue;
        await saveImageToAlbum(paths[index], this.albumSaveTimeoutMs);
        if (!active()) return;
        saved.add(index); this.setData({ savedIndices: [...saved], notice: '已保存 ' + saved.size + ' / ' + paths.length + ' 张' });
      }
      this.setData({ notice: '全部图片已保存到相册。你可以自行选择发布到哪里。' });
    } catch (error) {
      if (!active()) return;
      if (!authorized) this.resetImages();
      const reason = error instanceof Error ? error.message : String((error as { errMsg?: string })?.errMsg || '');
      this.setData({ notice: !authorized ? (reason || '导出权限未能确认，请重试')
        : '已保存 ' + this.data.savedIndices.length + ' 张，其余未完成。' + (/auth|deny|permission/i.test(reason)
          ? '请在小程序设置中允许保存到相册，再继续保存。' : /超时|没有响应|timeout/i.test(reason)
            ? '相册保存没有响应，请再试一次。' : '可以继续保存剩余图片。') });
    } finally { if (active()) this.setData({ albumSaving: false }); }
  },
  async shareImage(event: WechatMiniprogram.TouchEvent) {
    if (this.busy() || (!this.snapshot && !this.memorySource) || !this.descriptor || !this.exportSelection) return;
    const index = Number(event.currentTarget.dataset.index);
    const path = this.data.imagePaths[index];
    if (!Number.isSafeInteger(index) || !path) return;
    const epoch = this.epoch, snapshot = this.snapshot, source = this.memorySource, descriptor = this.descriptor, selection = this.exportSelection;
    const active = () => !this.hidden && this.epoch === epoch;
    this.setData({ sharingIndex: index, notice: '分享前正在核对版本和权限…' });
    try {
      if (snapshot) await this.verifySnapshot(snapshot); else if (source) await this.verifyMemorySource(source);
      if (!active()) return;
      const material = await bookExportApi.material(selection, descriptor.id); if (!active()) return;
      if (material.descriptor.id !== descriptor.id) throw new Error('预览已失效，请重新生成');
      const share = (wx as typeof wx & { showShareImageMenu?: (options: {
        path: string; success: () => void; fail: (error: unknown) => void;
      }) => void }).showShareImageMenu;
      if (typeof share !== 'function') throw new Error('当前微信版本暂不支持直接发送图片，请先保存到相册');
      await new Promise<void>((resolve, reject) => share({ path, success: resolve, fail: reject }));
      if (active()) this.setData({ notice: '已打开微信分享菜单，可发送给朋友或分享到朋友圈。' });
    } catch (error) {
      if (!active()) return;
      const reason = error instanceof Error ? error.message : String((error as { errMsg?: string })?.errMsg || '');
      if (/cancel/i.test(reason)) this.setData({ notice: '已取消分享，图片仍保留在预览中。' });
      else {
        if (/权限|版本|更新|失效|撤销/.test(reason)) this.resetImages();
        this.setData({ notice: reason || '暂时无法打开微信分享，请先保存到相册' });
      }
    } finally { if (active()) this.setData({ sharingIndex: -1 }); }
  },
  backToSelection() { if (!this.busy()) { this.resetImages(); this.setData({ preview: false, previewChapters: [] }); } },
  goBack() { if (!this.busy()) wx.navigateBack(); },
  onShareAppMessage(): { title: string; imageUrl: string; path: string } {
    return !this.hidden && this.data.destination === 'family' && this.data.familyShareReady && this.data.preview
      && this.snapshot && this.data.imagePaths.length && this.familyShare ? this.familyShare : sharingHome;
  },
});
