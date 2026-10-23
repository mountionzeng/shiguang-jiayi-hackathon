import { locateLine, splitLines, trimLineContext } from "../domain/lineModules";

const LIMIT = 3000;

/** 选区下标落在哪一行；图片等嵌入物在 delta 里占一位，纯文本里没有，所以下标越界时返回 null。 */
export function lineIndexFromRange(plain: string, rangeIndex: number): number | null {
  const text = plain.replace(/\r\n?/g, "\n");
  if (!Number.isInteger(rangeIndex) || rangeIndex < 0 || rangeIndex > text.length) return null;
  return locateLine(text, rangeIndex);
}

/** 没有可靠下标时，用选中的文字找行：只有唯一匹配才认。 */
export function lineIndexFromSelection(plain: string, selected: string): number | null {
  const picked = splitLines(selected);
  if (!picked.length) return null;
  const lines = splitLines(plain);
  const hits = lines.map((line, i) => (line.includes(picked[0]) ? i : -1)).filter(i => i >= 0);
  return hits.length === 1 ? hits[0] : null;
}

/** 交给小忆的引用文字：当前行及位置，全文仍由原来的上下文提供。 */
export function lineContextText(plain: string, index: number | null): string {
  const lines = splitLines(plain);
  if (index === null || !lines[index]) return "";
  const ctx = trimLineContext({ lines, index, limit: LIMIT });
  return [
    `【用户停在第 ${index + 1} 行（共 ${lines.length} 行）：${ctx.current}】`,
    ctx.near?.before.length ? `前面：${ctx.near.before.join(" / ")}` : "",
    ctx.near?.after.length ? `后面：${ctx.near.after.join(" / ")}` : "",
  ].filter(Boolean).join("\n");
}

/** 显示用：每个文字块里的每个非空行单独成段。只用于显示，不改存储的数据。 */
export function displayLines<T extends { text?: string }>(items: readonly T[]): Array<{ text: string }> {
  const out: Array<{ text: string }> = [];
  for (const item of items) for (const line of splitLines(String(item.text ?? ""))) out.push({ text: line });
  return out;
}
