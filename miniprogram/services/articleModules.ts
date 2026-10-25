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
  const chapter: ArticleChapter = { ...copy, content: copy.content.map((block, index) => ({ ...block,
    blockId: block.blockId || chapterPackageBlockId(['article-existing', input.id, index]),
  })), layout: clone(input.layout as PackageLayout || { canvas: { width: 900, height: 1200 }, settings: {
    fontId: 'default', style: 'plain', texture: 'none', textureSeed: 1, includeCover: false, bodyTextureAssetId: null,
  }, pages: [{ label: '1', modules: [] }] }) };
  for (const block of chapter.content) if (typeof block.text === 'string') block.text = block.text.replace(/\n$/, '');
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
  if (!chapter.content.some(block => typeof block.text === 'string')) { const id = freshId(); chapter.content.push({ blockId: id, text: '' }); place(chapter, textModule(id, { x: 48, y: 48, width: 804, height: 130 })); }
  return chapter;
}
export function changeArticleText(input: ArticleChapter, blockId: string, value: string) {
  const next = clone(input), index = next.content.findIndex(block => block.blockId === blockId);
  if (index < 0) throw new Error('找不到这段文字');
  const original = next.content[index];
  if (typeof original.text !== 'string') throw new Error('这不是文字模块');
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  next.content[index] = { ...original, text: lines[0] };
  let focused = blockId;
  for (const [offset, line] of lines.slice(1).entries()) {
    focused = freshId();
    next.content.splice(index + offset + 1, 0, { blockId: focused, text: line, parentBlockId: original.parentBlockId || blockId });
    place(next, textModule(focused, { x: 48, y: 48, width: 804, height: 130 }));
  }
  return { chapter: next, focused };
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
export function addArticlePhoto(input: ArticleChapter, photoId: string): ArticleChapter {
  if (Object.keys(input.packageAssets || {}).length >= 12) throw new Error('一章最多十二张图片');
  const next = clone(input), id = freshId(), assetId = chapterPackageAssetId(photoId);
  next.content.push({ blockId: id, photoId });
  next.packageAssets = { ...next.packageAssets, [assetId]: { photoId, aiGenerated: false } };
  place(next, { id: `image-${id.slice(6)}`, kind: 'image', assetId, rect: { x: 48, y: 48, width: 804, height: 420 }, crop: { x: 0, y: 0, width: 1, height: 1 } });
  return next;
}
