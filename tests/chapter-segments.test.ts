import assert from "node:assert/strict";
import test from "node:test";

import {
  appendMemorySegment,
  createContribution,
  ManuscriptChapter,
  MemoryContribution,
} from "../miniprogram/domain/biography";
import { appendNewMemorySegments, chapterHasNewSegment, hasUnwrittenSegments } from "../miniprogram/services/chapters";

function chapter(id: string, title: string, text: string, overrides: Partial<ManuscriptChapter> = {}): ManuscriptChapter {
  return { id, title, memoryIds: [], content: [{ text }], ...overrides };
}

function memory(overrides: Partial<Parameters<typeof createContribution>[0]> = {}): MemoryContribution {
  return createContribution({
    id: "memory-1",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "灶台边总有一股柴火味。",
    now: new Date("2026-09-01T00:00:00.000Z"),
    scope: "personal",
    visibility: "private",
    ...overrides,
  });
}

test("a chapter that never used the memory has no new-segment badge, even after it grows", () => {
  const grown = appendMemorySegment(memory(), "又想起一件事。", "continue", undefined, new Date("2026-09-08T00:00:00.000Z"));
  const untouched = chapter("chapter-1", "灶台", "别的内容\n");
  assert.equal(chapterHasNewSegment(untouched, grown), false, "还没放进书稿的记忆走「未写入」那一套，不是「有新段」");
  assert.equal(hasUnwrittenSegments([untouched], grown), false);
});

test("a chapter that wrote the memory in shows a new-segment badge once it grows, then clears after writing in", () => {
  const one = memory();
  const written = chapter("chapter-1", "灶台", "灶台边总有一股柴火味。\n", {
    memoryIds: [one.id],
    memorySegmentCounts: { [one.id]: 1 },
  });
  assert.equal(chapterHasNewSegment(written, one), false, "段数没变，没有新段");

  const grown = appendMemorySegment(one, "外公总会提前十分钟出门。", "continue", undefined, new Date("2026-09-08T00:00:00.000Z"));
  assert.equal(chapterHasNewSegment(written, grown), true);
  assert.equal(hasUnwrittenSegments([written], grown), true);

  const [updated] = appendNewMemorySegments([written], grown, "chapter-1");
  assert.match(updated.content.map(item => item.text).join(""), /外公总会提前十分钟出门。/);
  assert.doesNotMatch(updated.content.map(item => item.text).join(""), /(灶台边总有一股柴火味。){2}/, "老段落没有重复出现");
  assert.deepEqual(updated.memorySegmentCounts, { [one.id]: 2 });
  assert.equal(chapterHasNewSegment(updated, grown), false, "写进以后水位追平，不再提示");
  assert.equal(updated.handEdited, true);
});

test("appendNewMemorySegments puts the memory into a chapter that had not used it, without touching other chapters", () => {
  const one = memory();
  const fresh = chapter("chapter-2", "新的一章", "");
  const untouched = chapter("chapter-3", "别的一章", "跟这段记忆无关\n");
  const [updatedFresh, updatedOther] = appendNewMemorySegments([fresh, untouched], one, "chapter-2");
  assert.deepEqual(updatedFresh.memoryIds, [one.id]);
  assert.match(updatedFresh.content.map(item => item.text).join(""), /灶台边总有一股柴火味。/);
  assert.deepEqual(updatedOther, untouched, "别的章节原样不动");
});

test("a memory in several chapters keeps each chapter's watermark independent", () => {
  const one = memory();
  const grown = appendMemorySegment(one, "外公总会提前十分钟出门。", "continue", undefined, new Date("2026-09-08T00:00:00.000Z"));
  const first = chapter("chapter-1", "相识", "灶台边总有一股柴火味。\n", {
    memoryIds: [one.id],
    memorySegmentCounts: { [one.id]: 1 },
  });
  const second = chapter("chapter-2", "婚礼", "灶台边总有一股柴火味。\n", {
    memoryIds: [one.id],
    memorySegmentCounts: { [one.id]: 2 }, // 假装这一章已经写过新段了
  });

  const [updatedFirst, updatedSecond] = appendNewMemorySegments([first, second], grown, "chapter-1");
  assert.deepEqual(updatedFirst.memorySegmentCounts, { [one.id]: 2 });
  assert.deepEqual(updatedSecond, second, "只更新目标章，另一章的水位不受影响");
  assert.equal(chapterHasNewSegment(updatedSecond, grown), false);
});
