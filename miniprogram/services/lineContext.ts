import { lineContextExcerpt, locateLine, splitLines } from "../domain/lineModules";

/** 选区下标落在哪一行；图片等嵌入物在 delta 里占一位，纯文本里没有，所以下标越界时返回 null。 */
export function lineIndexFromRange(plain: string, rangeIndex: number): number | null {
  return locateLine(plain, rangeIndex);
}

/** 没有可靠下标时，用选中的文字找行：只有唯一匹配才认。 */
export function lineIndexFromSelection(plain: string, selected: string): number | null {
  const text = plain.replace(/\r\n?/g, "\n");
  const picked = selected.replace(/\r\n?/g, "\n").trim();
  if (!picked) return null;
  const first = text.indexOf(picked);
  if (first < 0 || text.indexOf(picked, first + 1) >= 0) return null;
  return locateLine(text, first);
}

/** 交给小忆的有界引用：当前行、邻近行、章节全文、目录按优先级裁剪。 */
export function lineContextText(plain: string, index: number | null, titles: readonly string[] = []): string {
  const lines = splitLines(plain);
  if (index === null || !lines[index]) return "";
  const header = `【用户停在第 ${index + 1} 行（共 ${lines.length} 行）】\n`;
  // chatInterview's existing sourceText budget is 500; keep priority explicit before that boundary.
  return header + lineContextExcerpt({ lines, index, titles, limit: 500 - header.length });
}

/** 显示用：每个文字块里的每个非空行单独成段。只用于显示，不改存储的数据。 */
export function displayLines<T extends { text?: string }>(items: readonly T[]): Array<{ text: string }> {
  const out: Array<{ text: string }> = [];
  for (const item of items) for (const line of splitLines(String(item.text ?? ""))) out.push({ text: line });
  return out;
}
