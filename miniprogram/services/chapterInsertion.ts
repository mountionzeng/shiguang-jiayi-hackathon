import { ManuscriptContent } from "../domain/biography";

export interface ChapterInsertionPoint {
  id: string;
  label: string;
  contentIndex: number;
  offset: number;
}

/** Keep offsets in the original blocks: paragraph splitting must not move photos or normalize old text. */
export function chapterInsertionPoints(content: ManuscriptContent[]): ChapterInsertionPoint[] {
  const points: ChapterInsertionPoint[] = [{ id: "start", label: "章节开头", contentIndex: 0, offset: 0 }];
  let paragraph = 0;
  content.forEach((item, contentIndex) => {
    if (typeof item.text !== "string") return;
    const pattern = /[^\r\n]+(?:\r?\n)*/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(item.text))) {
      if (!match[0].trim()) continue;
      paragraph += 1;
      const offset = match.index + match[0].length;
      points.push({ id: `${contentIndex}:${offset}`, label: `第 ${paragraph} 段后：${match[0].trim().slice(0, 28)}`, contentIndex, offset });
    }
  });
  points.push({ id: "end", label: "章节末尾", contentIndex: content.length, offset: 0 });
  return points;
}

export function insertChapterText(content: ManuscriptContent[], pointId: string, text: string): ManuscriptContent[] {
  const point = chapterInsertionPoints(content).find(item => item.id === pointId);
  if (!point) throw new Error("插入位置已变动，请重新选择");
  const added = text.trim();
  if (!added) throw new Error("请写下要插入的文字");
  const next = content.map(item => ({ ...item }));
  if (pointId === "start") return [{ text: added + "\n\n" }, ...next];
  if (pointId === "end") return [...next, { text: "\n\n" + added + "\n" }];
  const block = next[point.contentIndex];
  if (typeof block.text !== "string") throw new Error("插入位置已变动，请重新选择");
  // Existing characters, formatting delimiters and image order all survive unchanged.
  const before = block.text.slice(0, point.offset);
  const after = block.text.slice(point.offset);
  const parts: ManuscriptContent[] = [];
  if (before) parts.push({ ...block, text: before });
  parts.push({ text: (before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n") + added + "\n\n" });
  if (after) parts.push({ ...block, text: after });
  next.splice(point.contentIndex, 1, ...parts);
  return next;
}
