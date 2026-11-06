import { articleEditorPages } from '../../services/articleEditorLayout';
import type { ManuscriptChapter } from '../../domain/biography';
import { articleChapter, changeArticleText, moveArticleModule, removeArticleModule, mergeArticleTextModules, type ArticleChapter } from '../../services/articleModules';
Component({
  options: { multipleSlots: true },
  properties: { keyboardHeight: {type:Number,value:0}, adjustPosition: {type:Boolean,value:true}, backdrop: {type:String,value:''}, chapter: { type: Object, value: {} }, paths: { type: Object, value: {} as Record<string,string> }, width: { type: Number, value: 320 } },
  data: { mergeIds: [] as string[], mergeMenu: '', focusRequest: '', selectionCursor: -1, editingBlock: '', caretCursor: null as number | null, caretRequest: 0, caretMeasureText: '', caretMeasureStyle: '', textHeights: {} as Record<string, { key: string; height: number }>, imageSelection: undefined as Promise<{ start: number; end: number } | null> | undefined, current: null as ArticleChapter | null, gesture: null as {id:string;resize:boolean;x:number;y:number;chapter:ArticleChapter} | null, pages: [] as any[], selected: '', focused: '', scale: 1, note: '' },
  lifetimes: { detached() { this.data.editingBlock = ''; this.data.caretRequest++; } },
  observers: {
    keyboardHeight(height: number) {
      if (height > 0) this.revealCaret(); else this.data.caretRequest++;
    },
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
        if (current?.id !== chapter.id) {
          this.data.editingBlock = ''; this.data.caretCursor = null; this.data.caretRequest++;
          // Do not emit back into the parent while its chapter update is running.
          this.setData({mergeIds:[],mergeMenu:'',selected:'',focused:'',focusRequest:'',selectionCursor:-1});
        }
        this.data.textHeights = {};
        this.data.current = articleChapter(chapter);
        this.setData({ scale }); this.render();
      }
      catch (error) { this.setData({ note: error instanceof Error ? error.message : '文章暂时无法打开' }); }
    },
  },
  methods: {
    pageModels() {
      const chapter = this.data.current as ArticleChapter | undefined; if (!chapter) return;
      return articleEditorPages(chapter, this.data.scale, this.properties.paths, this.data.textHeights);
    },
    textLineChange(event: { currentTarget: { dataset: { id: string; measure: string } }; detail: { height: number } }) {
      const { id, measure } = event.currentTarget.dataset;
      const height = Number(event.detail.height);
      if (!Number.isFinite(height) || height <= 0) return;
      const module = this.pageModels()?.flatMap(page => page.modules).find(item => item.id === id);
      // Ignore measurements from an old chapter, width or text value.
      if (!module || module.measurementKey !== measure) return;
      this.data.textHeights ||= {};
      const previous = this.data.textHeights[id];
      if (previous?.key === measure && previous.height === height) return;
      this.data.textHeights[id] = { key: measure, height };
      this.syncGeometry();
    },
    render() {
      const pages = this.pageModels();
      if (pages) this.setData({ pages }, () => this.revealCaret());
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
          if (module.measurementKey !== previous.measurementKey) patch[`pages[${pageIndex}].modules[${moduleIndex}].measurementKey`] = module.measurementKey;
          if (module.path !== previous.path) patch[`pages[${pageIndex}].modules[${moduleIndex}].path`] = module.path;
        });
      });
      if (Object.keys(patch).length) this.setData(patch, () => this.revealCaret());
      else this.revealCaret();
      return true;
    },
    beginEditing(event: WechatMiniprogram.TextareaFocus) {
      if (this.data.mergeIds?.length) {this.dismissKeyboard(); wx.hideKeyboard(); return;}
      if (this.data.editingBlock !== event.currentTarget.dataset.block) this.data.caretCursor = null;
      const { block, id } = event.currentTarget.dataset;
      this.data.editingBlock = block;
      this.data.caretRequest++;
      // A Return focus request belongs only to its target. Native taps own later focus.
      this.setData({ selected: id, focused: block,
        ...(this.data.focusRequest && this.data.focusRequest !== block ? {focusRequest: '', selectionCursor: -1} : {}) });
      this.triggerEvent('selectmodule', {id});
      this.readCaret();
    },
    readCaret() {
      const blockId = this.data.editingBlock;
      if (!blockId) return;
      const request = ++this.data.caretRequest;
      const apply = (cursor: number) => {
        if (request !== this.data.caretRequest || blockId !== this.data.editingBlock) return;
        this.data.caretCursor = cursor; this.revealCaret();
      };
      // Reading the native range preserves a tap in the middle of a long paragraph.
      if (wx.getSelectedTextRange) wx.getSelectedTextRange({success: range => apply(range.end)});
    },
    revealCaret() {
      const blockId = this.data.editingBlock;
      if (!this.properties.keyboardHeight || !blockId || this.data.caretCursor === null) return;
      const chapter = this.data.current as ArticleChapter | null;
      const module = this.pageModels()?.flatMap(page => page.modules).find(item => item.blockId === blockId);
      if (!chapter || !module || module.kind !== 'text') return;
      const request = ++this.data.caretRequest;
      const cursor = Math.max(0, Math.min(module.text.length, this.data.caretCursor));
      this.setData({ caretMeasureText: module.text.slice(0, cursor) + '\u200b',
        caretMeasureStyle: `width:${module.width - 2}px;${module.fontStyle}` }, () => {
        if (request !== this.data.caretRequest) return;
        const query = this.createSelectorQuery();
        query.select(`#article-input-${module.id}`).boundingClientRect();
        query.select('#article-caret-measure').boundingClientRect();
        query.exec(results => {
          if (request !== this.data.caretRequest || !this.properties.keyboardHeight || chapter.id !== this.data.current?.id || blockId !== this.data.editingBlock) return;
          const [input, prefix] = results as Array<{top:number;height:number} | null>;
          if (!input || !prefix || !Number.isFinite(input.top) || !Number.isFinite(prefix.height)) return;
          const lineHeight = Math.max(12, module.fontSize * this.data.scale) * 1.6;
          const bottom = input.top + Math.max(lineHeight, prefix.height);
          this.triggerEvent('caret', {chapterId:chapter.id, top:bottom-lineHeight, bottom});
        });
      });
    },
    playAudio(event: WechatMiniprogram.TouchEvent) { const id=event.currentTarget.dataset.id;this.setData({selected:id});this.triggerEvent('selectmodule',{id});this.triggerEvent('playaudio',{id}); },
    select(event: WechatMiniprogram.TouchEvent) {
      const { id, block } = event.currentTarget.dataset;
      if (this.data.mergeIds?.length) {
        if (block) {
          const ids = this.data.mergeIds.includes(block) ? this.data.mergeIds.filter(value => value !== block)
            : [this.data.mergeIds[0], block];
          this.setData({mergeIds:ids,mergeMenu:ids.length === 2 ? id : ''});
          return;
        }
        this.clear();
      }
      // Tapping keeps the native selection; only splitting requests a new focus.
      this.setData({ selected: id, focused: block || '' });
      if (block === this.data.editingBlock) this.readCaret();
      this.triggerEvent('selectmodule', { id });
    },
    clear(options?: {preserveMerge?: boolean}) { if (options?.preserveMerge && this.data.mergeIds?.length) {this.dismissKeyboard();return;} this.triggerEvent('selectmodule',{id:''}); this.data.editingBlock = ''; this.data.caretCursor = null; this.data.caretRequest++; this.setData({ mergeIds: [], mergeMenu: '', selected: '', focused: '', focusRequest: '', selectionCursor: -1 }); },
    beginMerge(event: WechatMiniprogram.TouchEvent) {
      const {block} = event.currentTarget.dataset;
      if (!block) {this.select(event);return;}
      this.dismissKeyboard();
      this.setData({mergeIds:[block],mergeMenu:'',selected:'',note:''});
      this.triggerEvent('selectmodule',{id:''});
      wx.hideKeyboard();
    },
    mergeText() {
      try {
        const next = mergeArticleTextModules(this.data.current!, this.data.mergeIds);
        this.clear(); this.data.current = next; this.data.textHeights = {};
        this.render(); this.publish();
      } catch (error) {this.setData({note:error instanceof Error ? error.message : '没有合并，请重试'});}
    },
    change(event: WechatMiniprogram.Input) {
      try {
        const before = this.data.current!;
        const changed = changeArticleText(before, event.currentTarget.dataset.block, event.detail.value, event.detail.cursor);
        this.data.current = changed.chapter;
        const module = changed.chapter.layout.pages.flatMap(page => page.modules).find(m => m.kind === 'text' && 'blockId' in m.bind && m.bind.blockId === changed.focused);
        const normalized = event.detail.value.replace(/\r\n?/g, '\n');
        const cursor = Math.max(0, Math.min(normalized.length, event.detail.cursor ?? normalized.length));
        this.data.editingBlock = changed.focused;
        this.data.caretCursor = changed.split ? 0 : cursor;
        this.data.caretRequest++;
        this.setData({ focused: changed.focused, selected: module?.id || '', note: '' });
        if (changed.split) {
          const target = changed.focused;
          this.setData({ pages: this.pageModels(), focusRequest: '', selectionCursor: -1 }, () => {
            wx.nextTick(() => {
              if (this.data.current !== changed.chapter || this.data.editingBlock !== target) return;
              this.setData({ focusRequest: target, selectionCursor: 0 }, () => this.revealCaret());
            });
          });
        } else {
          if (this.data.selectionCursor !== -1) this.setData({ selectionCursor: -1 });
          this.syncGeometry();
        }
        this.publish();
        this.triggerEvent('selectmodule',{id:module?.id || ''});
      } catch (error) { this.setData({ note: error instanceof Error ? error.message : '没有写入，请重试' }); }
    },
    dismissKeyboard() {
      this.data.editingBlock = ''; this.data.caretCursor = null; this.data.caretRequest++;
      this.setData({ focusRequest: '', selectionCursor: -1, focused: '' });
    },
    confirmEditing() {
      // Done may precede blur, including while Return is waiting for nextTick.
      // Cancel our focus intent immediately; the native Done action closes the IME.
      this.dismissKeyboard();
    },
    finishEditing(event: WechatMiniprogram.TouchEvent) {
      const blockId = event.currentTarget.dataset.block;
      if (blockId === this.data.editingBlock) this.dismissKeyboard();
      // A late blur from the previous block must not rewrite the newly focused input.
      const text = this.data.current?.content.find(item => item.blockId === blockId)?.text;
      if (text === undefined) return;
      const patch: Record<string, string> = {};
      this.data.pages.forEach((page: any, pageIndex: number) => {
        page.modules.forEach((module: any, moduleIndex: number) => {
          if (module.blockId === blockId && module.text !== text)
            patch[`pages[${pageIndex}].modules[${moduleIndex}].text`] = text;
        });
      });
      if (Object.keys(patch).length) this.setData(patch);
    },
    publish() { this.triggerEvent('change', { chapter: this.data.current! }); },
    start(event: WechatMiniprogram.TouchEvent) {
      const touch = event.touches[0]; if (!touch) return;
      this.data.editingBlock = ''; this.data.caretCursor = null; this.data.caretRequest++;
      this.data.gesture = { id: event.currentTarget.dataset.id, resize: event.currentTarget.dataset.resize === true || event.currentTarget.dataset.resize === 'true', x: touch.clientX, y: touch.clientY, chapter: this.data.current! };
      this.setData({ selected: event.currentTarget.dataset.id, focused: '' });
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
