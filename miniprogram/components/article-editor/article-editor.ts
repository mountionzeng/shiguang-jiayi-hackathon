import type { ManuscriptChapter } from '../../domain/biography';
import { articleChapter, changeArticleText, moveArticleModule, removeArticleModule, type ArticleChapter } from '../../services/articleModules';
Component({
  properties: { backdrop: {type:String,value:''}, chapter: { type: Object, value: {} }, paths: { type: Object, value: {} as Record<string,string> }, width: { type: Number, value: 320 } },
  data: { imageSelection: undefined as Promise<{ start: number; end: number } | null> | undefined, current: null as ArticleChapter | null, gesture: null as {id:string;resize:boolean;x:number;y:number;chapter:ArticleChapter} | null, pages: [] as any[], selected: '', focused: '', focusRequest: '', cursor: 0, scale: 1, note: '' },
  observers: {
    'chapter, paths, width': function(chapter: ManuscriptChapter, _paths: Record<string, string>, width: number) {
      if (!chapter) return;
      try {
        // Saving the same chapter updates the parent property. Keep the native
        // textarea mounted so that this acknowledgement cannot steal its caret.
        const current = this.data.current as ArticleChapter | null;
        const scale = Math.max(0.1, width / 900);
        if (current?.id === chapter.id && JSON.stringify(current) === JSON.stringify(chapter) && this.data.scale === scale) {
          this.syncGeometry(); return;
        }
        this.data.current = articleChapter(chapter);
        this.setData({ scale }); this.render();
      }
      catch (error) { this.setData({ note: error instanceof Error ? error.message : '文章暂时无法打开' }); }
    },
  },
  methods: {
    pageModels() {
      const chapter = this.data.current as ArticleChapter | undefined; if (!chapter) return;
      const scale = this.data.scale;
      return chapter.layout.pages.map((page, index) => ({ id: index, height: Math.max(220, ...page.modules.map(module => module.rect.y + module.rect.height + 36)) * scale,
        modules: page.modules.map(module => ({ ...module,
          style: `left:${module.rect.x * scale}px;top:${module.rect.y * scale}px;width:${module.rect.width * scale}px;height:${module.rect.height * scale}px;`,
          text: module.kind === 'text' ? ('blockId' in module.bind ? chapter.content.find(block => block.blockId === ('blockId' in module.bind ? module.bind.blockId : ''))?.text || '' : chapter.title) : '',
          blockId: module.kind === 'text' && 'blockId' in module.bind ? module.bind.blockId : '',
          path: module.kind === 'image' ? this.properties.paths[chapter.packageAssets?.[module.assetId]?.photoId || ''] || '' : '',
          fontStyle: module.kind === 'text' ? `font-size:${Math.max(12, module.fontSize * scale)}px;text-align:${module.alignment === 'center' ? 'center' : 'left'};` : '',
        })),
      }));
    },
    render() {
      const pages = this.pageModels();
      if (pages) this.setData({ pages });
    },
    syncGeometry() {
      const pages = this.pageModels();
      if (!pages || pages.length !== this.data.pages.length || pages.some((page: any, index: number) =>
        page.modules.map((module: any) => module.id).join('|') !== this.data.pages[index].modules.map((module: any) => module.id).join('|'))) {
        this.render(); return false;
      }
      const patch: Record<string, number | string> = {};
      pages.forEach((page: any, pageIndex: number) => {
        if (page.height !== this.data.pages[pageIndex].height) patch[`pages[${pageIndex}].height`] = page.height;
        page.modules.forEach((module: any, moduleIndex: number) => {
          const previous = this.data.pages[pageIndex].modules[moduleIndex];
          if (module.style !== previous.style) patch[`pages[${pageIndex}].modules[${moduleIndex}].style`] = module.style;
          if (module.fontStyle !== previous.fontStyle) patch[`pages[${pageIndex}].modules[${moduleIndex}].fontStyle`] = module.fontStyle;
          if (module.path !== previous.path) patch[`pages[${pageIndex}].modules[${moduleIndex}].path`] = module.path;
        });
      });
      if (Object.keys(patch).length) this.setData(patch);
      return true;
    },
    select(event: WechatMiniprogram.TouchEvent) {
      const { id, block } = event.currentTarget.dataset;
      // Let the native textarea honor the tap's exact caret location. Only a
      // newly created paragraph after Return uses a programmatic focus request.
      this.setData({ selected: id, focused: block || '' });
      this.triggerEvent('selectmodule', { id });
    },
    clear() { this.setData({ selected: '', focused: '', focusRequest: '' }); },
    change(event: WechatMiniprogram.Input) {
      try {
        const before = this.data.current!;
        const changed = changeArticleText(before, event.currentTarget.dataset.block, event.detail.value);
        this.data.current = changed.chapter;
        const module = changed.chapter.layout.pages.flatMap(page => page.modules).find(m => m.kind === 'text' && 'blockId' in m.bind && m.bind.blockId === changed.focused);
        const normalized = event.detail.value.replace(/\r\n?/g, '\n');
        const lines = normalized.split('\n');
        const lastLineStart = normalized.lastIndexOf('\n') + 1;
        const cursor = Math.max(0, Math.min(lines[lines.length - 1].length,
          (event.detail.cursor ?? normalized.length) - lastLineStart));
        this.data.cursor = cursor;
        const structureChanged = before.content.length !== changed.chapter.content.length || before.layout.pages.length !== changed.chapter.layout.pages.length ||
          before.layout.pages.some((page, index) => page.modules.map(item => item.id).join('|') !== changed.chapter.layout.pages[index]?.modules.map(item => item.id).join('|'));
        this.setData({ focused: changed.focused, selected: module?.id || '', note: '',
          ...(structureChanged ? { focusRequest: changed.focused, cursor } : {}) });
        if (structureChanged) this.render(); else this.syncGeometry();
        this.publish();
      } catch (error) { this.setData({ note: error instanceof Error ? error.message : '没有写入，请重试' }); }
    },
    finishEditing(event: WechatMiniprogram.TouchEvent) {
      const blockId = event.currentTarget.dataset.block;
      if (blockId === this.data.focusRequest) this.setData({ focusRequest: '' });
      this.render();
    },
    publish() { this.triggerEvent('change', { chapter: this.data.current! }); },
    start(event: WechatMiniprogram.TouchEvent) {
      const touch = event.touches[0]; if (!touch) return;
      this.data.gesture = { id: event.currentTarget.dataset.id, resize: event.currentTarget.dataset.resize === true || event.currentTarget.dataset.resize === 'true', x: touch.clientX, y: touch.clientY, chapter: this.data.current! };
      this.setData({ selected: event.currentTarget.dataset.id, focused: '', focusRequest: '' });
    },
    move(event: WechatMiniprogram.TouchEvent) {
      const touch = event.touches[0], gesture = this.data.gesture; if (!touch || !gesture) return;
      this.data.current = moveArticleModule(gesture.chapter, gesture.id, (touch.clientX - gesture.x) / this.data.scale, (touch.clientY - gesture.y) / this.data.scale, gesture.resize);
      this.render();
    },
    end() { if (!this.data.gesture) return; this.data.gesture = null; this.publish(); },
    async remove() {
      const result = await new Promise<WechatMiniprogram.ShowModalSuccessCallbackResult>(resolve => wx.showModal({ title: '删除这一块？', content: '保存后仍可在历史版本中找回。', confirmText: '删除', success: resolve }));
      if (!result.confirm) return;
      this.data.current = removeArticleModule(this.data.current!, this.data.selected); this.clear(); this.render(); this.publish();
    },
    captureImageSelection() {
      this.data.imageSelection = new Promise<{ start: number; end: number } | null>(resolve => {
        if (!this.data.focused || !wx.getSelectedTextRange) { resolve(null); return; }
        wx.getSelectedTextRange({ success: resolve, fail: () => resolve(null) });
      });
    },
    async addImage() {
      const chapter = this.data.current;
      const module = chapter?.layout.pages.flatMap(page => page.modules).find(item => item.id === this.data.selected);
      const blockId = module?.kind === 'text' && 'blockId' in module.bind ? module.bind.blockId : '';
      let text = chapter?.content.find(item => item.blockId === blockId)?.text || '';
      const range = await this.data.imageSelection;
      this.data.imageSelection = undefined;
      if (range && range.end > range.start) text = text.slice(range.start, range.end);
      this.triggerEvent('addimage', { blockId, text });
    },
  },
});
