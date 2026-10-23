/**
 * Line modules: one non-empty line is one text module (chapter-package contract 1.0.0).
 * Pure functions only. No storage, no network. Mini-program copy of the web shared/lineModules.ts; both run against tests/fixtures/line-modules/cases.json.
 */
export type LineModule = { id: string; text: string };

export const splitLines = (text: string): string[] =>
  text.replace(/\r\n?/g, "\n").split("\n").filter(line => line.trim() !== "");

/**
 * Re-bind ids after an edit. Common leading and trailing lines keep their ids;
 * the changed middle is paired by position, extra lines get new ids, removed ids are dropped.
 */
export function reconcileLines(
  prev: readonly LineModule[],
  next: string,
  newId: () => string
): LineModule[] {
  const lines = splitLines(next);
  let head = 0;
  while (head < prev.length && head < lines.length && prev[head].text === lines[head]) head++;
  let tail = 0;
  while (
    tail < prev.length - head &&
    tail < lines.length - head &&
    prev[prev.length - 1 - tail].text === lines[lines.length - 1 - tail]
  )
    tail++;
  const midPrev = prev.slice(head, prev.length - tail);
  const out: LineModule[] = prev.slice(0, head).map(m => ({ ...m }));
  for (let i = head; i < lines.length - tail; i++) {
    const old = midPrev[i - head];
    out.push({ id: old ? old.id : newId(), text: lines[i] });
  }
  for (let i = tail; i > 0; i--) out.push({ ...prev[prev.length - i] });
  return out;
}

/** Index (among non-empty lines) of the line holding the cursor; a blank line belongs to the previous line. */
export function locateLine(text: string, cursor: number): number | null {
  const raw = text.split("\n");
  let start = 0;
  let index = -1;
  for (const line of raw) {
    const end = start + line.length;
    if (line.trim() !== "") {
      index++;
      if (cursor >= start && cursor <= end) return index;
    } else if (cursor >= start && cursor <= end) {
      return index >= 0 ? index : null;
    }
    start = end + 1;
  }
  return index >= 0 && cursor > start ? index : null;
}

export type LinePosition = {
  chapterId: string;
  blockId: string;
  index: number;
  total: number;
  prevText: string;
  text: string;
  nextText: string;
};

export function linePosition(
  chapterId: string,
  modules: readonly LineModule[],
  index: number | null
): LinePosition | null {
  if (index === null || index < 0 || index >= modules.length) return null;
  const m = modules[index];
  return {
    chapterId,
    blockId: m.id,
    index,
    total: modules.length,
    prevText: modules[index - 1]?.text ?? "",
    text: m.text,
    nextText: modules[index + 1]?.text ?? "",
  };
}

export type LineContextLayer = "current" | "near" | "chapter" | "titles";
export type LineContext = {
  included: LineContextLayer[];
  current: string;
  near?: { before: string[]; after: string[] };
  chapter?: string[];
  titles?: string[];
};

/** Trim by character budget in the order current line, nearby lines (2 each side), chapter, book titles. */
export function trimLineContext(input: {
  lines: readonly string[];
  index: number;
  titles?: readonly string[];
  limit: number;
}): LineContext {
  const { lines, index, limit } = input;
  const len = (xs: readonly string[]) => xs.reduce((n, s) => n + s.length, 0);
  const current = lines[index] ?? "";
  const before = lines.slice(Math.max(0, index - 2), index);
  const after = lines.slice(index + 1, index + 3);
  const titles = input.titles ?? [];
  const out: LineContext = { included: ["current"], current };
  if (len([current]) > limit) return out;
  const nearCost = len(before) + len(after) + current.length;
  if (nearCost > limit) return out;
  out.included.push("near");
  out.near = { before, after };
  const chapterCost = len(lines);
  if (chapterCost > limit) return out;
  out.included.push("chapter");
  out.chapter = [...lines];
  if (chapterCost + len(titles) > limit) return out;
  out.included.push("titles");
  out.titles = [...titles];
  return out;
}
