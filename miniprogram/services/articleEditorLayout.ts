import type { ArticleChapter } from './articleModules';

type TextHeights = Record<string, { key: string; height: number }>;

/** Editing is a continuous scroll surface. Keep the stored print canvas intact,
 * but give every paragraph its natural height, including manually moved text. */
export function articleEditorPages(chapter: ArticleChapter, scale: number, paths: Record<string, string>, measured: TextHeights = {}) {
  return chapter.layout.pages.map((page, index) => {
    const modules = page.modules.map(module => {
      const text = module.kind === 'text' ? ('blockId' in module.bind
        ? chapter.content.find(block => block.blockId === ('blockId' in module.bind ? module.bind.blockId : ''))?.text || ''
        : chapter.title) : '';
      const width = module.rect.width * scale;
      const fontSize = module.kind === 'text' ? Math.max(12, module.fontSize * scale) : 0;
      const measurementKey = module.kind === 'text' ? JSON.stringify([chapter.id, text, width, fontSize]) : '';
      const measurement = measured[module.id];
      // Safe first paint until native textarea reports its actual wrapped height.
      const columns = Math.max(1, Math.floor((width - 2) / (fontSize || 1)));
      const rows = text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(Array.from(line).length / columns)), 0);
      const height = module.kind === 'text'
        ? Math.max(fontSize * 1.6, measurement?.key === measurementKey ? measurement.height : rows * fontSize * 1.6) + 8
        : module.rect.height * scale;
      return { ...module, text, width, height, top: module.rect.y * scale,
        blockId: module.kind === 'text' && 'blockId' in module.bind ? module.bind.blockId : '',
        path: module.kind === 'image' ? paths[chapter.packageAssets?.[module.assetId]?.photoId || ''] || '' : '',
        fontStyle: module.kind === 'text' ? `font-size:${fontSize}px;text-align:${module.alignment === 'center' ? 'center' : 'left'};` : '',
        measurementKey, style: '',
      };
    });
    // Move following modules by the change in the preceding module's height.
    // Side-by-side artwork keeps its horizontal placement; input never rewrites
    // native values or changes module IDs just to accommodate wrapping.
    const placed: typeof modules = [];
    for (const module of [...modules].sort((a, b) => a.rect.y - b.rect.y)) {
      for (const before of placed) {
        const overlapsX = module.rect.x < before.rect.x + before.rect.width && before.rect.x < module.rect.x + module.rect.width;
        if (!overlapsX || before.rect.y >= module.rect.y) continue;
        const gap = Math.max(24, module.rect.y - before.rect.y - before.rect.height) * scale;
        module.top = Math.max(module.top, before.top + before.height + gap);
      }
      module.style = `left:${module.rect.x * scale}px;top:${module.top}px;width:${module.width}px;height:${module.height}px;`;
      placed.push(module);
    }
    return { id: index, height: Math.max(220 * scale, ...modules.map(module => module.top + module.height + 36 * scale)), modules };
  });
}
