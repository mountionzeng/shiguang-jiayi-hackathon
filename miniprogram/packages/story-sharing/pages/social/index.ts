import { loadSendSnapshot, selectSendText, SendChapter, SendScope, SendSnapshot, SendVersion } from '../../../../services/bookSend';
import { storyCoverApi } from '../../../../services/storyCoverService';
import { bookExportApi, bookExportSelection, BookExportSelection, BookExportDescriptor } from '../../../../services/bookExport';
import { renderBookImages, removeImageFiles } from '../../../../services/bookImageRenderer';
import { ImageLayoutMode, ImageFontSize } from '../../../../services/bookImageLayout';
import { sharingHome } from '../../../../services/storySharing';

Page({
  data: {
    loading: false, checking: false, exportBusy: false, albumSaving: false, exportAvailable: false, capabilityKnown: false,
    layout: 'pages' as ImageLayoutMode, fontSize: 32 as ImageFontSize, canvasHeight: 1080,
    imagePaths: [] as string[], savedIndices: [] as number[], renderProgress: '',
    notice: '', title: '', coverUrl: '', coverNotice: '',
    scope: 'chapters' as SendScope, chapters: [] as Array<SendChapter & { checked: boolean }>,
    textChapterIndex: 0, selectedText: '', editorReady: false,
    selectedCount: 0, characterCount: 0, preview: false, previewChapters: [] as SendChapter[],
  },
  expected: undefined as SendVersion | undefined,
  snapshot: undefined as SendSnapshot | undefined,
  editor: undefined as WechatMiniprogram.EditorContext | undefined,
  epoch: 0, hidden: true, editorSeed: 0,
  exportSelection: undefined as BookExportSelection | undefined,
  descriptor: undefined as BookExportDescriptor | undefined,
  renderTask: undefined as Promise<string[]> | undefined,
  onLoad(options: { storyId?: string; revisionId?: string; version?: string } = {}) {
    const version = Number(options.version);
    if (options.storyId && options.revisionId && Number.isSafeInteger(version) && version >= 1) {
      this.expected = { storyId: options.storyId, revisionId: options.revisionId, version };
    }
    wx.hideShareMenu();
  },
  onShow() { this.hidden = false; void this.refresh(); },
  onHide() {
    this.hidden = true; this.epoch++; this.editorSeed++; this.snapshot = undefined; this.resetImages();
    this.editor?.clear();
    this.editor = undefined;
    this.setData({ loading: false, checking: false, exportBusy: false, albumSaving: false, exportAvailable: false, capabilityKnown: false, title: '', coverUrl: '', coverNotice: '', chapters: [], selectedText: '',
      editorReady: false, preview: false, previewChapters: [], selectedCount: 0, characterCount: 0 });
  },
  onUnload() { this.onHide(); this.editor = undefined; this.expected = undefined; },
  async refresh() {
    const epoch = ++this.epoch;
    this.snapshot = undefined; this.resetImages();
    this.setData({ loading: true, exportAvailable: false, capabilityKnown: false, notice: '', title: '', chapters: [], coverUrl: '', coverNotice: '', selectedText: '',
      selectedCount: 0, characterCount: 0, preview: false, previewChapters: [], editorReady: false, textChapterIndex: 0 });
    try {
      if (!this.expected) throw new Error('请从书稿目录的“发送”重新进入');
      const snapshot = await loadSendSnapshot(this.expected);
      if (this.hidden || epoch !== this.epoch) return;
      this.snapshot = snapshot;
      this.setData({ title: snapshot.title, chapters: snapshot.chapters.map(chapter => ({ ...chapter, checked: false })) });
      this.updateSelection(); this.seedEditor();
      void this.checkExportCapability(epoch);
      // Cover arrival updates only the image. It must never reset the selected text.
      if (snapshot.coverImageId) void this.resolveCover(snapshot, epoch);
    } catch (error) {
      if (!this.hidden && epoch === this.epoch) this.setData({ notice: error instanceof Error ? error.message : '书稿暂时无法读取，请重试' });
    } finally {
      if (!this.hidden && epoch === this.epoch) this.setData({ loading: false });
    }
  },
  async resolveCover(snapshot: SendSnapshot, epoch: number) {
    try {
      const url = await storyCoverApi.resolveUrl(snapshot.storyId, snapshot.coverImageId);
      if (!this.hidden && epoch === this.epoch) this.setData({ coverUrl: url, coverNotice: url ? '' : '已有封面暂未读到，可稍后重新加载' });
    } catch {
      if (!this.hidden && epoch === this.epoch) this.setData({ coverNotice: '已有封面暂未读到，可稍后重新加载' });
    }
  },
  chooseScope(event: WechatMiniprogram.TouchEvent) {
    if (this.data.loading || this.busy()) return;
    const scope = event.currentTarget.dataset.scope as SendScope;
    if (!['book', 'chapters', 'text'].includes(scope)) return;
    this.resetImages();
    this.setData({ scope, preview: false, previewChapters: [], notice: '' }); this.updateSelection();
  },
  chooseChapters(event: WechatMiniprogram.CustomEvent<{ value: string[] }>) {
    if (this.busy()) return;
    const ids = new Set(event.detail.value);
    this.setData({ chapters: this.data.chapters.map(chapter => ({ ...chapter, checked: ids.has(chapter.id) })) });
    this.updateSelection();
  },
  chooseTextChapter(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.busy()) return;
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
    if (this.data.loading || this.busy() || !this.snapshot || !this.expected) return;
    const epoch = this.epoch, snapshot = this.snapshot;
    const selected = this.selected();
    if (!selected.some(chapter => chapter.text.trim())) { this.setData({ notice: '请先选择要分享的文字' }); return; }
    this.setData({ checking: true, notice: '' });
    try {
      const fresh = await loadSendSnapshot(this.expected);
      if (this.hidden || epoch !== this.epoch) return;
      if (fresh.accountScope !== snapshot.accountScope || JSON.stringify(fresh) !== JSON.stringify(snapshot)) throw new Error('书稿或账号已有变化，请回到目录重新进入发送');
      this.setData({ preview: true, previewChapters: selected });
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
  busy() { return this.data.checking || this.data.exportBusy || this.data.albumSaving; },
  async checkExportCapability(epoch: number) {
    try {
      const available = await bookExportApi.available();
      if (!this.hidden && epoch === this.epoch) this.setData({ exportAvailable: available, capabilityKnown: true });
    } catch {
      if (!this.hidden && epoch === this.epoch) this.setData({ exportAvailable: false, capabilityKnown: true, notice: '暂时无法确认图片导出是否可用，请稍后重新加载' });
    }
  },
  resetImages() {
    removeImageFiles(this.data.imagePaths);
    this.exportSelection = undefined; this.descriptor = undefined;
    this.setData({ imagePaths: [], savedIndices: [], renderProgress: '' });
  },
  chooseLayout(event: WechatMiniprogram.TouchEvent) {
    if (this.busy()) return;
    const layout = event.currentTarget.dataset.layout as ImageLayoutMode;
    if (layout !== 'pages' && layout !== 'long') return;
    this.resetImages(); this.setData({ layout, notice: '' });
  },
  chooseFont(event: WechatMiniprogram.CustomEvent<{ value: string }>) {
    if (this.busy()) return;
    const fontSize = [28, 32, 36][Number(event.detail.value)] as ImageFontSize;
    if (!fontSize) return;
    this.resetImages(); this.setData({ fontSize, notice: '' });
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
  async generateImages() {
    if (this.busy() || !this.snapshot || !this.data.preview || !this.data.exportAvailable) return;
    const snapshot = this.snapshot, epoch = this.epoch;
    const active = () => !this.hidden && this.epoch === epoch;
    this.resetImages(); this.setData({ exportBusy: true, notice: '', renderProgress: '正在核对导出权限…' });
    let paths: string[] = [];
    try {
      await this.renderTask?.catch(() => undefined);
      await this.verifySnapshot(snapshot); if (!active()) return;
      const selection = bookExportSelection(snapshot, { scope: this.data.scope,
        chapterIds: this.data.chapters.filter(c => c.checked).map(c => c.id),
        textChapterId: snapshot.chapters[this.data.textChapterIndex]?.id || '', text: this.data.selectedText });
      const preview = await bookExportApi.preview(selection); if (!active()) return;
      const material = await bookExportApi.material(selection, preview.descriptor.id); if (!active()) return;
      const chosen = this.selected();
      if (material.descriptor.storyId !== snapshot.storyId || material.descriptor.revisionId !== snapshot.revisionId ||
        material.descriptor.storyVersion !== snapshot.version || material.descriptor.chapters.length !== chosen.length ||
        material.descriptor.chapters.some((chapter, i) => chapter.id !== chosen[i].id || chapter.text !== chosen[i].text)) {
        throw new Error('导出内容与所选版本不一致，请重新进入发送');
      }
      const task = renderBookImages(material, this.data.layout, this.data.fontSize, this, active,
        (done, total) => { if (active()) this.setData({ renderProgress: '已生成 ' + done + ' / ' + total + ' 张' }); });
      this.renderTask = task;
      try { paths = await task; } finally { if (this.renderTask === task) this.renderTask = undefined; }
      if (!active()) { removeImageFiles(paths); return; }
      const checked = await bookExportApi.material(selection, preview.descriptor.id);
      await this.verifySnapshot(snapshot);
      if (!active()) { removeImageFiles(paths); return; }
      if (checked.descriptor.id !== material.descriptor.id) throw new Error('预览已变化，请重新生成');
      this.descriptor = material.descriptor; this.exportSelection = selection;
      this.setData({ imagePaths: paths, savedIndices: [], notice: '请检查下面的全部图片，再保存到相册。' });
    } catch (error) {
      removeImageFiles(paths);
      if (active()) this.setData({ notice: error instanceof Error ? error.message : '图片生成失败，请重试' });
    } finally {
      if (active()) this.setData({ exportBusy: false, renderProgress: '' });
    }
  },
  async saveImages() {
    if (this.busy() || !this.snapshot || !this.descriptor || !this.exportSelection || !this.data.imagePaths.length) return;
    const epoch = this.epoch, snapshot = this.snapshot, descriptor = this.descriptor, selection = this.exportSelection;
    const active = () => !this.hidden && this.epoch === epoch;
    this.setData({ albumSaving: true, notice: '保存前正在核对版本和权限…' });
    let authorized = false;
    try {
      await this.verifySnapshot(snapshot); if (!active()) return;
      const material = await bookExportApi.material(selection, descriptor.id); if (!active()) return;
      if (material.descriptor.id !== descriptor.id) throw new Error('预览已失效，请重新生成');
      authorized = true;
      const paths = [...this.data.imagePaths], saved = new Set(this.data.savedIndices);
      for (let index = 0; index < paths.length; index++) {
        if (!active()) return;
        if (saved.has(index)) continue;
        await new Promise<void>((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath: paths[index], success: () => resolve(), fail: reject }));
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
          ? '请在小程序设置中允许保存到相册，再继续保存。' : '可以继续保存剩余图片。') });
    } finally { if (active()) this.setData({ albumSaving: false }); }
  },
  backToSelection() { if (!this.busy()) { this.resetImages(); this.setData({ preview: false, previewChapters: [] }); } },
  goBack() { if (!this.busy()) wx.navigateBack(); },
  onShareAppMessage() { return sharingHome; },
});
