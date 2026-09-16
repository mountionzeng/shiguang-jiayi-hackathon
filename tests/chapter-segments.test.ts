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
  canProposeSelectionRewrite,
  chapterAiExportPrefix,
  chapterAiLabel,
  chapterHasNewSegment,
  chapterPlainText,
  finalizePendingRevision,
  hasUnwrittenSegments,
  pendingEditCount,
  pendingRevisionResolved,
  proposeMemorySegmentInsert,
  proposeSelectionRewrite,
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

test("chapterPlainText 跳过图片，把文本块按顺序拼起来，供前端计算选段偏移", () => {
  const withPhoto: ManuscriptChapter = {
    id: "c1", title: "", memoryIds: [],
    content: [{ text: "第一段。" }, { photoId: "photo-1" }, { text: "第二段。" }],
  };
  assert.equal(chapterPlainText(withPhoto), "第一段。第二段。");
});

test("选中一段文字改写：先只提一对待确认修订，不直接改正文；确认后原地替换", () => {
  const target = chapter("chapter-1", "灶台", "我羞耻的原因是因为那不是真正的我。");
  const text = chapterPlainText(target);
  const start = text.indexOf("因为那不是真正的我");
  const end = start + "因为那不是真正的我".length;
  assert.ok(canProposeSelectionRewrite(target, start, end));

  const proposed = proposeSelectionRewrite([target], "chapter-1", start, end, "因为我一直在保护自己");
  const proposedChapter = proposed.find(item => item.id === "chapter-1")!;
  assert.equal(proposedChapter.content.map(item => item.text).join(""), target.content[0].text, "正文还没变");
  assert.equal(pendingEditCount(proposed), 2, "一条删除、一条插入");

  const edits = proposedChapter.pendingRevision!.edits;
  const del = edits.find(edit => edit.kind === "delete")!;
  const ins = edits.find(edit => edit.kind === "insert")!;
  assert.equal(del.text, "因为那不是真正的我");
  assert.equal(del.source, "ai");
  assert.deepEqual(del.anchor, { start, end });
  assert.equal(ins.text, "因为我一直在保护自己");
  assert.deepEqual(ins.anchor, { start: end, end });

  const accepted = resolvePendingEdit(resolvePendingEdit(proposed, "chapter-1", del.id, "accept"), "chapter-1", ins.id, "accept");
  const [finalized] = finalizePendingRevision(accepted, "chapter-1");
  assert.equal(finalized.content.map(item => item.text).join(""), "我羞耻的原因是因为我一直在保护自己。");
  assert.equal(finalized.containsAiText, true);
  assert.equal(finalized.handEdited, undefined, "确认/不要本身不算手改");
  assert.equal(finalized.pendingRevision, undefined);
});

test("只接受删除、不接受插入：原文被拿掉，不留下新字", () => {
  const target = chapter("chapter-1", "灶台", "ABCDEF");
  const proposed = proposeSelectionRewrite([target], "chapter-1", 1, 3, "XY");
  const edits = proposed[0].pendingRevision!.edits;
  const del = edits.find(edit => edit.kind === "delete")!;
  const ins = edits.find(edit => edit.kind === "insert")!;
  const resolved = resolvePendingEdit(resolvePendingEdit(proposed, "chapter-1", del.id, "accept"), "chapter-1", ins.id, "reject");
  const [finalized] = finalizePendingRevision(resolved, "chapter-1");
  assert.equal(finalized.content.map(item => item.text).join(""), "ADEF");
});

test("跨图片或跨两个文本块的选段不生成修订", () => {
  const withPhoto: ManuscriptChapter = {
    id: "chapter-1", title: "", memoryIds: [],
    content: [{ text: "前段" }, { photoId: "photo-1" }, { text: "后段" }],
  };
  assert.equal(canProposeSelectionRewrite(withPhoto, 0, 4), false, "跨过了图片");
  const untouched = proposeSelectionRewrite([withPhoto], "chapter-1", 0, 4, "改写");
  assert.equal(untouched[0].pendingRevision, undefined);

  const twoBlocks: ManuscriptChapter = {
    id: "chapter-2", title: "", memoryIds: [],
    content: [{ text: "第一块" }, { text: "第二块" }],
  };
  assert.equal(canProposeSelectionRewrite(twoBlocks, 1, 4), false, "跨了两个文本块");
});

test("同一章两处独立的选段改写互不干扰，即使都在同一个文本块里", () => {
  const target = chapter("chapter-1", "", "ABCDEFGHIJ");
  const first = proposeSelectionRewrite([target], "chapter-1", 1, 3, "xy"); // BC -> xy
  const both = proposeSelectionRewrite(first, "chapter-1", 6, 8, "ZZ"); // GH -> ZZ
  const acceptAll = both[0].pendingRevision!.edits.reduce(
    (chapters, edit) => resolvePendingEdit(chapters, "chapter-1", edit.id, "accept"), both);
  const [finalized] = finalizePendingRevision(acceptAll, "chapter-1");
  assert.equal(finalized.content.map(item => item.text).join(""), "AxyDEFZZIJ");
});
