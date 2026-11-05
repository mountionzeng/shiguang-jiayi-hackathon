import type { ManuscriptChapter, ManuscriptContent } from '../domain/biography';
import { chapterPackageBlockId, chapterPackageAssetId, type PackageLayout, type PackageLayoutModule, type Rect } from '../domain/chapterPackage';
export type ArticleBlock = ManuscriptContent & { blockId: string; parentBlockId?: string };
export type ArticleChapter = Omit<ManuscriptChapter, 'content' | 'layout'> & { content: ArticleBlock[]; layout: PackageLayout };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const freshId = () => chapterPackageBlockId(['article', Date.now(), Math.random()]);
export const textModule = (id: string, rect: Rect): PackageLayoutModule => ({ id: `text-${id.slice(6)}`, kind: 'text', bind: { blockId: id }, rect, fontSize: 48, contentWidth: rect.width, contentHeight: rect.height, alignment: 'start' });
function place(chapter: ArticleChapter, module: PackageLayoutModule) {
  let page = chapter.layout.pages[chapter.layout.pages.length - 1];
  let y = page.modules.reduce((bottom, item) => Math.max(bottom, item.rect.y + item.rect.height + 24), 48);
  if (y + module.rect.height > 1200) {
    if (chapter.layout.pages.length >= 9) throw new Error('最多九页，请另开一章');
    page = { label: String(chapter.layout.pages.length + 1), modules: [] }; chapter.layout.pages.push(page); y = 48;
  }
  module.rect.y = y; page.modules.push(module);
}
/** Stable IDs and the same 900×1200 geometry used by the website. */
export function articleChapter(input: ManuscriptChapter): ArticleChapter {
  const copy = clone(input);
  // Only legacy unkeyed blocks used a trailing newline as a serialization delimiter.
  for (const block of copy.content) {
    if (typeof block.text === 'string' && !block.blockId) block.text = block.text.replace(/\n$/, '');
  }
  const chapter: ArticleChapter = { ...copy, content: copy.content.map((block, index) => ({ ...block,
    blockId: block.blockId || chapterPackageBlockId(['article-existing', input.id, index]),
  })), layout: clone(input.layout as PackageLayout || { canvas: { width: 900, height: 1200 }, settings: {
    fontId: 'default', style: 'plain', texture: 'none', textureSeed: 1, includeCover: false, bodyTextureAssetId: null,
  }, pages: [{ label: '1', modules: [] }] }) };
  const bound = new Set(chapter.layout.pages.flatMap(page => page.modules.flatMap(m => m.kind === 'text' && 'blockId' in m.bind ? [m.bind.blockId] : [])));
  const images = new Set(chapter.layout.pages.flatMap(page => page.modules.flatMap(m => m.kind === 'image' ? [m.assetId] : [])));
  for (const block of chapter.content) {
    if (typeof block.text === 'string' && !bound.has(block.blockId)) {
      const height = Math.min(1000, Math.max(110, Math.ceil(block.text.length / 18) * 66));
      place(chapter, textModule(block.blockId, { x: 48, y: 48, width: 804, height }));
    } else if (block.photoId) {
      const assetId = Object.keys(chapter.packageAssets || {}).find(key => chapter.packageAssets![key].photoId === block.photoId) || chapterPackageAssetId(block.photoId);
      chapter.packageAssets = { ...chapter.packageAssets, [assetId]: chapter.packageAssets?.[assetId] || { photoId: block.photoId, aiGenerated: false } };
      if (!images.has(assetId)) place(chapter, { id: `image-${block.blockId.slice(6)}`, kind: 'image', assetId,
        rect: { x: 48, y: 48, width: 804, height: 420 }, crop: { x: 0, y: 0, width: 1, height: 1 } });
    }
  }
  if (!chapter.content.some(block => typeof block.text === 'string')) { const id = chapterPackageBlockId(['article-empty',input.id]); chapter.content.push({ blockId: id, text: '' }); place(chapter, textModule(id, { x: 48, y: 48, width: 804, height: 130 })); }
  return chapter;
}
export function changeArticleText(input: ArticleChapter, blockId: string, value: string, cursor?: number) {
  const next = clone(input), index = next.content.findIndex(block => block.blockId === blockId);
  if (index < 0) throw new Error('找不到这段文字');
  const original = next.content[index];
  if (typeof original.text !== 'string') throw new Error('这不是文字模块');
  const normalized = value.replace(/\r\n?/g, '\n');
  // A single inserted Return (including replacement of a selection) splits here.
  // Pasted multiline text and existing line breaks stay in their original block.
  const at = cursor === undefined ? -1 : cursor - 1;
  const prefix = normalized.slice(0, at), suffix = normalized.slice(at + 1);
  if (at >= 0 && normalized[at] === '\n' && original.text.startsWith(prefix) &&
      original.text.endsWith(suffix) && prefix.length + suffix.length <= original.text.length) {
    const id = freshId();
    next.content.splice(index, 1, { ...original, text: prefix },
      { ...original, blockId: id, parentBlockId: original.parentBlockId || blockId, text: suffix });
    const page = next.layout.pages.find(p => p.modules.some(m => m.kind === 'text' && 'blockId' in m.bind && m.bind.blockId === blockId));
    if (!page) throw new Error('找不到这段文字的排版');
    const position = page.modules.findIndex(m => m.kind === 'text' && 'blockId' in m.bind && m.bind.blockId === blockId);
    const source = page.modules[position];
    if (source.kind !== 'text') throw new Error('这不是文字模块');
    const rect = { ...source.rect, y: source.rect.y + source.rect.height + 24, height: 110 };
    // Insert beside the source in both content and layout order, never at book end.
    for (const item of page.modules.slice(position + 1)) {
      if (item.rect.y >= rect.y) item.rect.y += rect.height + 24;
    }
    page.modules.splice(position + 1, 0, { ...source, id: textModule(id, rect).id,
      bind: { blockId: id }, rect, contentHeight: rect.height });
    fitArticleText(next, blockId); fitArticleText(next, id);
    // Positioned layouts do not auto-flow; carry overflow to an adjacent page.
    for (let i = 0; i < next.layout.pages.length; i++) {
      const current = next.layout.pages[i];
      const overflow = current.modules.findIndex(m => m.rect.y + m.rect.height > 1200);
      if (overflow < 0) continue;
      if (next.layout.pages.length >= 9) throw new Error('最多九页，请另开一章');
      const tail = current.modules.splice(overflow);
      const top = Math.min(...tail.map(m => m.rect.y));
      for (const item of tail) item.rect.y = 48 + item.rect.y - top;
      next.layout.pages.splice(i + 1, 0, { label: '', modules: tail });
    }
    next.layout.pages.forEach((p, i) => { p.label = String(i + 1); });
    return { chapter: next, focused: id, split: true };
  }
  next.content[index] = { ...original, text: normalized };
  fitArticleText(next, blockId);
  return { chapter: next, focused: blockId, split: false };
}
export function moveArticleModule(input: ArticleChapter, id: string, dx: number, dy: number, resize = false): ArticleChapter {
  const next = clone(input);
  const module = next.layout.pages.flatMap(page => page.modules).find(item => item.id === id);
  if (!module) return next;
  const rect = module.rect;
  if (resize) {
    rect.width = Math.max(100, Math.min(900 - rect.x, rect.width + dx));
    rect.height = Math.max(80, Math.min(1200 - rect.y, rect.height + dy));
    if (module.kind === 'text') { module.contentWidth = rect.width; module.contentHeight = rect.height; }
  } else { rect.x = Math.max(0, Math.min(900 - rect.width, rect.x + dx)); rect.y = Math.max(0, Math.min(1200 - rect.height, rect.y + dy)); }
  module.positioned = true;
  return next;
}
export function removeArticleModule(input: ArticleChapter, id: string): ArticleChapter {
  const next = clone(input), module = next.layout.pages.flatMap(page => page.modules).find(item => item.id === id);
  if (!module) return next;
  next.layout.pages.forEach(page => { page.modules = page.modules.filter(item => item.id !== id); });
  if (module.kind === 'text' && 'blockId' in module.bind) {
    const blockId = module.bind.blockId;
    const stillUsed = next.layout.pages.some(page => page.modules.some(m => m.kind === 'text' && 'blockId' in m.bind && m.bind.blockId === blockId));
    if (!stillUsed) next.content = next.content.filter(block => block.blockId !== blockId);
  } else if (module.kind === 'image') {
    if (!next.layout.pages.some(page => page.modules.some(m => m.kind === 'image' && m.assetId === module.assetId))) {
      const photoId = next.packageAssets?.[module.assetId]?.photoId;
      next.content = next.content.filter(block => block.photoId !== photoId);
    }
  }
  return articleChapter(next);
}
export function addArticlePhoto(input: ArticleChapter, photoId: string, aiGenerated = false): ArticleChapter {
  if (Object.keys(input.packageAssets || {}).length >= 12) throw new Error('一章最多十二张图片');
  const next = clone(input), id = freshId(), assetId = chapterPackageAssetId(photoId);
  next.content.push({ blockId: id, photoId });
  next.packageAssets = { ...next.packageAssets, [assetId]: { photoId, aiGenerated } };
  place(next, { id: `image-${id.slice(6)}`, kind: 'image', assetId, rect: { x: 48, y: 48, width: 804, height: 420 }, crop: { x: 0, y: 0, width: 1, height: 1 } });
  return next;
}

/** Grow ordinary text modules with their content; keep deliberately positioned layouts. */
function fitArticleText(chapter: ArticleChapter, blockId: string) {
  const module = chapter.layout.pages.flatMap(page => page.modules).find(m => m.kind === 'text' && 'blockId' in m.bind && m.bind.blockId === blockId);
  if (!module || module.kind !== 'text' || module.positioned) return;
  // Persist print geometry; the editor keeps a separate continuous input surface.
  const manualLayout = chapter.layout.pages.some(page => page.modules.some(m => m.positioned || m.rect.x !== 48 || m.rect.width !== 804));
  if (manualLayout) return;
  const text = chapter.content.find(block => block.blockId === blockId)?.text || '';
  const charsPerRow = Math.max(1, Math.floor(module.rect.width / module.fontSize));
  const rows = text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerRow)), 0);
  const maxHeight = 1000;
  module.rect.height = Math.min(maxHeight, Math.max(110, Math.ceil(rows * module.fontSize * 1.6 + 16)));
  module.contentHeight = module.rect.height;
  const modules = chapter.layout.pages.flatMap(page => page.modules);
  chapter.layout.pages = [{label:'1',modules:[]}];
  for (const item of modules) place(chapter,item);
}
export function appendArticleText(input: ArticleChapter, text: string): ArticleChapter {
  let next = clone(input);
  for (const line of text.replace(/\r\n?/g,'\n').split('\n')) {
    const id=freshId();next.content.push({blockId:id,text:line});
    const height = Math.min(1000, Math.max(110, Math.ceil(line.length / 16) * 77 + 16));
    place(next,textModule(id,{x:48,y:48,width:804,height}));
  }
  return next;
}
