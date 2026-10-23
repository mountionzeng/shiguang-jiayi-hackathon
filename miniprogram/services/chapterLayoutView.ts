import type { ManuscriptChapter } from "../domain/biography";
import type { PackageLayout } from "../domain/chapterPackage";

export type ChapterLayoutViewModule = {
  id: string;
  kind: "text" | "image";
  style: string;
  text?: string;
  imagePath?: string;
  fontSize?: number;
  alignment?: "start" | "center";
};

export type ChapterLayoutViewPage = { id: string; height: number; modules: ChapterLayoutViewModule[] };

/** Convert stored 900×1200 module geometry to a responsive, read-only page view. */
export function chapterLayoutView(chapter: ManuscriptChapter, viewportWidth: number, photoPaths: Record<string, string>): ChapterLayoutViewPage[] {
  const layout = chapter.layout as PackageLayout | undefined;
  if (!layout || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return [];
  const scale = Math.min(1, viewportWidth / layout.canvas.width);
  const blockText = new Map(chapter.content.filter(block => typeof block.text === "string")
    .map(block => [block.blockId || "", String(block.text).replace(/\r\n?/g, "\n").split("\n").filter(line => line.trim())] as const));
  const usedBlocks = new Set<string>();
  const pages = layout.pages.map((page, pageIndex) => ({
    id: `${chapter.id}-${pageIndex}`,
    height: layout.canvas.height * scale,
    modules: page.modules.flatMap<ChapterLayoutViewModule>(module => {
      const rect = module.rect;
      const common = `left:${rect.x * scale}px;top:${rect.y * scale}px;width:${rect.width * scale}px;height:${rect.height * scale}px;`;
      if (module.kind === "image") {
        const photoId = chapter.packageAssets?.[module.assetId]?.photoId ?? chapter.content.find(block => block.photoId?.endsWith(module.assetId.slice(6)))?.photoId;
        const imagePath = photoId ? photoPaths[photoId] : undefined;
        return imagePath ? [{ id: module.id, kind: "image" as const, style: common, imagePath }] : [];
      }
      if ("chapterTitle" in module.bind && module.bind.chapterTitle) return [{ id: module.id, kind: "text" as const, style: common,
        text: chapter.title, fontSize: module.fontSize * scale, alignment: module.alignment }];
      if (!("blockId" in module.bind)) return [];
      const blockId = module.bind.blockId;
      const lines = blockText.get(blockId);
      if (!lines?.length) return [];
      usedBlocks.add(blockId);
      return [{ id: module.id, kind: "text" as const, style: common,
        text: lines.join("\n"), fontSize: module.fontSize * scale, alignment: module.alignment }];
    }),
  }));
  const remaining = chapter.content.flatMap(block => typeof block.text === "string" && !usedBlocks.has(block.blockId || "")
    ? block.text.replace(/\r\n?/g, "\n").split("\n").filter(line => line.trim()) : []);
  if (remaining.length) pages.push({
    id: `${chapter.id}-unplaced`, height: Math.max(120, remaining.length * 44 * scale),
    modules: remaining.map((text, index) => ({ id: `unplaced-${index}`, kind: "text" as const,
      style: `left:${30 * scale}px;top:${index * 44 * scale}px;width:${840 * scale}px;height:${40 * scale}px;`,
      text, fontSize: 30 * scale, alignment: "start" as const })),
  });
  return pages;
}
