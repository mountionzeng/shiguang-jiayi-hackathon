import assert from "node:assert/strict";
import test from "node:test";

import {
  appendMemorySegment,
  ChapterEdit,
  createContribution,
  ManuscriptChapter,
  MemoryContribution,
} from "../miniprogram/domain/biography";
import {
  chapterAiExportPrefix,
  chapterAiLabel,
  chapterHasNewSegment,
  finalizePendingRevision,
  hasUnwrittenSegments,
  pendingEditCount,
  pendingRevisionResolved,
  proposeMemorySegmentInsert,
  resolvePendingEdit,
} from "../miniprogram/services/chapters";

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

function firstEdit(chapters: ManuscriptChapter[], chapterId: string): ChapterEdit {
  const target = chapters.find(item => item.id === chapterId)!;
  return target.pendingRevision!.edits[target.pendingRevision!.edits.length - 1];
}

test("a chapter that never used the memory has no new-segment badge, even after it grows", () => {
  const grown = appendMemorySegment(memory(), "又想起一件事。", "continue", undefined, new Date("2026-09-08T00:00:00.000Z"));
  const untouched = chapter("chapter-1", "灶台", "别的内容\n");
  assert.equal(chapterHasNewSegment(untouched, grown), false, "还没放进书稿的记忆走「未写入」那一套，不是「有新段」");
  assert.equal(hasUnwrittenSegments([untouched], grown), false);
});

test("写进先只提一条待确认的新增，不直接改正文；全部确认完才更新水位和正文", () => {
  const one = memory();
  const written = chapter("chapter-1", "灶台", "灶台边总有一股柴火味。\n", {
    memoryIds: [one.id],
    memorySegmentCounts: { [one.id]: 1 },
  });
  const grown = appendMemorySegment(one, "外公总会提前十分钟出门。", "continue", undefined, new Date("2026-09-08T00:00:00.000Z"));

  const proposed = proposeMemorySegmentInsert([written], grown, "chapter-1");
  const target = proposed.find(item => item.id === "chapter-1")!;
  assert.equal(target.content.map(item => item.text).join(""), "灶台边总有一股柴火味。\n", "正文还没变");
  assert.equal(target.memorySegmentCounts?.[one.id], 1, "水位还没变");
  assert.equal(pendingEditCount(proposed), 1);
  assert.equal(pendingRevisionResolved(target), false);

  const edit = firstEdit(proposed, "chapter-1");
  assert.equal(edit.source, "memory", "用户自己讲的原话，不标 AI");
  assert.equal(edit.text, "外公总会提前十分钟出门。");
  assert.equal(edit.memoryId, one.id);
  assert.equal(edit.memorySegmentCountAtProposal, 2);
  assert.equal(edit.status, "pending");

  assert.throws(() => finalizePendingRevision(proposed, "chapter-1"), /还有没确认的修订/);

  const accepted = resolvePendingEdit(proposed, "chapter-1", edit.id, "accept");
  assert.equal(pendingRevisionResolved(accepted.find(item => item.id === "chapter-1")!), true);
  assert.equal(pendingEditCount(accepted), 0);

  const [finalized] = finalizePendingRevision(accepted, "chapter-1");
  assert.match(finalized.content.map(item => item.text).join(""), /外公总会提前十分钟出门。/);
  assert.doesNotMatch(finalized.content.map(item => item.text).join(""), /(灶台边总有一股柴火味。){2}/, "老段落没有重复出现");
  assert.deepEqual(finalized.memorySegmentCounts, { [one.id]: 2 });
  assert.equal(finalized.pendingRevision, undefined, "确认完，待确认字段清空");
  assert.equal(finalized.handEdited, undefined, "确认/不要本身不算手改");
  assert.equal(finalized.containsAiText, undefined, "用户原话不算 AI 文字");
  assert.equal(chapterHasNewSegment(finalized, grown), false, "写进以后水位追平，不再提示");
});

test("点「不要」以后，正文和水位都不变，这条记忆仍然算「有新段没写进」", () => {
  const one = memory();
  const written = chapter("chapter-1", "灶台", "灶台边总有一股柴火味。\n", {
    memoryIds: [one.id],
    memorySegmentCounts: { [one.id]: 1 },
  });
  const grown = appendMemorySegment(one, "外公总会提前十分钟出门。", "continue", undefined, new Date("2026-09-08T00:00:00.000Z"));

  const proposed = proposeMemorySegmentInsert([written], grown, "chapter-1");
  const edit = firstEdit(proposed, "chapter-1");
  const declined = resolvePendingEdit(proposed, "chapter-1", edit.id, "reject");
  const [finalized] = finalizePendingRevision(declined, "chapter-1");

  assert.equal(finalized.content.map(item => item.text).join(""), "灶台边总有一股柴火味。\n");
  assert.deepEqual(finalized.memorySegmentCounts, { [one.id]: 1 });
  assert.equal(chapterHasNewSegment(finalized, grown), true, "水位没追上，还是有新段没写进");
});

test("proposeMemorySegmentInsert puts the memory into a chapter that had not used it, without touching other chapters", () => {
  const one = memory();
  const fresh = chapter("chapter-2", "新的一章", "");
  const untouched = chapter("chapter-3", "别的一章", "跟这段记忆无关\n");
  const proposed = proposeMemorySegmentInsert([fresh, untouched], one, "chapter-2");
  const [updatedFresh, updatedOther] = proposed;
  assert.equal(pendingEditCount(proposed), 1);
  assert.deepEqual(updatedFresh.memoryIds, [], "还没确认，memoryIds 先不变");
  assert.deepEqual(updatedOther, untouched, "别的章节原样不动");

  const [finalized] = finalizePendingRevision(
    resolvePendingEdit(proposed, "chapter-2", firstEdit(proposed, "chapter-2").id, "accept"),
    "chapter-2",
  );
  assert.deepEqual(finalized.memoryIds, [one.id]);
});

test("一段记忆同时提到好几章：各章各自的待确认修订和水位互不影响", () => {
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

  const proposed = proposeMemorySegmentInsert([first, second], grown, "chapter-1");
  assert.equal(pendingEditCount(proposed), 1, "第二章水位已经追平，不会再提待确认");
  const [, updatedSecond] = proposed;
  assert.deepEqual(updatedSecond, second, "只对目标章提修订");
  assert.equal(chapterHasNewSegment(updatedSecond, grown), false);
});

test("AI 来源的新增被接受后，章节标为含 AI 文字；被「不要」的不标", () => {
  const withAi = chapter("chapter-1", "灶台", "原有正文\n", {
    pendingRevision: {
      createdAt: "2026-09-15T00:00:00.000Z",
      edits: [{ id: "edit-1", kind: "insert", text: "AI 补写的一段。", source: "ai", status: "pending" }],
    },
  });
  const accepted = resolvePendingEdit([withAi], "chapter-1", "edit-1", "accept");
  const [finalized] = finalizePendingRevision(accepted, "chapter-1");
  assert.equal(finalized.containsAiText, true);
  assert.match(finalized.content.map(item => item.text).join(""), /AI 补写的一段。/);

  const declinedAi = chapter("chapter-2", "灶台", "原有正文\n", {
    pendingRevision: {
      createdAt: "2026-09-15T00:00:00.000Z",
      edits: [{ id: "edit-2", kind: "insert", text: "AI 补写的一段。", source: "ai", status: "pending" }],
    },
  });
  const rejected = resolvePendingEdit([declinedAi], "chapter-2", "edit-2", "reject");
  const [finalizedRejected] = finalizePendingRevision(rejected, "chapter-2");
  assert.equal(finalizedRejected.containsAiText, undefined, "AI 内容全部不要，不标含 AI");
});

test("chapterAiLabel / chapterAiExportPrefix：没有 AI 文字不标，含 AI 且手改过要带「已由你修改」", () => {
  assert.equal(chapterAiLabel(chapter("c1", "", "")), "");
  assert.equal(chapterAiExportPrefix(chapter("c1", "", "")), "");

  const aiOnly = chapter("c2", "", "", { containsAiText: true });
  assert.equal(chapterAiLabel(aiOnly), "文字 AI 生成");
  assert.equal(chapterAiExportPrefix(aiOnly), "【文字 AI 生成】");

  const aiAndEdited = chapter("c3", "", "", { containsAiText: true, handEdited: true });
  assert.equal(chapterAiLabel(aiAndEdited), "文字 AI 生成 · 已由你修改");
  assert.equal(chapterAiExportPrefix(aiAndEdited), "【文字 AI 生成 · 已由你修改】");

  // 整章由 AI 生成（generationMode）也算含 AI 文字，即使 containsAiText 还没被这条流程设置过。
  const fullyGenerated = chapter("c4", "", "", { generationMode: "cloud-ai" });
  assert.equal(chapterAiLabel(fullyGenerated), "文字 AI 生成");
});
