import { BiographyDraft, ChapterEdit, ChapterEditStatus, ManuscriptChapter, ManuscriptContent, memorySegmentCount, memorySegments, MemoryContribution } from "../domain/biography";
import { contentFromDelta, contentToDelta, validateContent } from "./bookImages";

const CHAPTER_ID = /^chapter-[a-z0-9-]{1,60}$/;
const DIGITS = "零一二三四五六七八九";
export const MAX_CHAPTERS = 30;
export const MAX_BOOK_TEXT = 20000;
/** A chapter backdrop points at a picture stored by the storyImages cloud function. */
export const CHAPTER_BACKDROP_ID = /^family_[0-9A-Za-z_-]{1,120}_img_req-[0-9a-z-]{8,60}$/;

export function chapterLabel(position: number) {
  const tens = Math.floor(position / 10);
  const ones = position % 10;
  const number = position < 10 ? DIGITS[position]
    : (tens > 1 ? DIGITS[tens] : "") + "十" + (ones ? DIGITS[ones] : "");
  return "第" + number + "章";
}

export function newChapterId() {
  return "chapter-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export function copyChapter(chapter: ManuscriptChapter): ManuscriptChapter {
  return { ...chapter, memoryIds: [...chapter.memoryIds], content: chapter.content.map(item => ({ ...item })) };
}

/** Memory ids a version was built from, read from its source fingerprint. */
export function memoryIdsFromFingerprint(sourceFingerprint: string): string[] {
  try {
    const sources: unknown = JSON.parse(sourceFingerprint).sources;
    return Array.isArray(sources) ? sources.flatMap(item => typeof item?.id === "string" ? [item.id] : []) : [];
  } catch { return []; }
}

/**
 * Chapters of a version. A flat (older) book reads as a single first chapter holding
 * its content unchanged, photos included; nothing is written until the user saves.
 */
export function chaptersOf(draft: BiographyDraft, sourceFingerprint = ""): ManuscriptChapter[] {
  if (Array.isArray(draft.chapters) && draft.chapters.length) return draft.chapters.map(copyChapter);
  // Older text-only drafts may still carry photo markers inside their paragraphs.
  const content = contentFromDelta(contentToDelta(draft.content ?? [{ text: draft.paragraphs.join("\n\n") + "\n" }], {}), {});
  return [{ id: "chapter-1", title: "", memoryIds: memoryIdsFromFingerprint(sourceFingerprint), content }];
}

/** The whole book as one flattened text/photo sequence, with a heading line per chapter. */
export function flattenChapters(chapters: ManuscriptChapter[]) {
  const content: ManuscriptContent[] = [];
  chapters.forEach((chapter, index) => {
    const name = chapter.title.trim();
    content.push({ text: (index ? "\n" : "") + chapterLabel(index + 1) + (name ? "　" + name : "") + "\n\n" });
    content.push(...chapter.content.map(item => ({ ...item })));
    const last = content[content.length - 1];
    if (typeof last.text !== "string" || !last.text.endsWith("\n")) content.push({ text: "\n" });
  });
  const paragraphs = content.map(item => item.text ?? "").join("").split(/\n\s*\n/).map(text => text.trim()).filter(Boolean);
  return { content, paragraphs };
}

export function draftWithChapters(base: BiographyDraft, chapters: ManuscriptChapter[]): BiographyDraft {
  return { ...base, chapters: chapters.map(copyChapter), ...flattenChapters(chapters) };
}

/** Adds a chapter at the end. A memory lives in one chapter, so the listed memories move here. */
export function addChapter(chapters: ManuscriptChapter[], title = "", memoryIds: string[] = [], id = newChapterId()): ManuscriptChapter[] {
  if (chapters.length >= MAX_CHAPTERS) throw new Error("一本书稿最多 " + MAX_CHAPTERS + " 章");
  const moving = new Set(memoryIds);
  return [
    ...chapters.map(chapter => ({ ...copyChapter(chapter), memoryIds: chapter.memoryIds.filter(memoryId => !moving.has(memoryId)) })),
    { id, title: title.trim().slice(0, 40), memoryIds: [...moving], content: [] },
  ];
}

/** Removing a chapter only affects the next version; its memories become unassigned. */
export function removeChapter(chapters: ManuscriptChapter[], id: string): ManuscriptChapter[] {
  if (chapters.length <= 1) throw new Error("至少要保留一章");
  return chapters.filter(chapter => chapter.id !== id).map(copyChapter);
}

export function moveChapter(chapters: ManuscriptChapter[], id: string, offset: number): ManuscriptChapter[] {
  const next = chapters.map(copyChapter);
  const from = next.findIndex(chapter => chapter.id === id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Puts a memory into one chapter (or none, with an empty chapter id); text is not touched. */
export function assignMemory(chapters: ManuscriptChapter[], memoryId: string, chapterId: string): ManuscriptChapter[] {
  return chapters.map(chapter => {
    const memoryIds = chapter.memoryIds.filter(id => id !== memoryId);
    if (chapter.id === chapterId) memoryIds.push(memoryId);
    return { ...copyChapter(chapter), memoryIds };
  });
}

/**
 * Adds a memory to one chapter without removing it from any other — a story's memory
 * can sit in several chapters at once (用户 2026-09-14 定). Every other chapter is
 * copied unchanged; adding it again is a no-op.
 */
export function addMemoryToChapter(chapters: ManuscriptChapter[], memoryId: string, chapterId: string): ManuscriptChapter[] {
  return chapters.map(chapter => {
    if (chapter.id !== chapterId || chapter.memoryIds.includes(memoryId)) return copyChapter(chapter);
    return { ...copyChapter(chapter), memoryIds: [...chapter.memoryIds, memoryId] };
  });
}

/** Removes a memory from one chapter only; it stays in every other chapter it was placed in. */
export function removeMemoryFromChapter(chapters: ManuscriptChapter[], memoryId: string, chapterId: string): ManuscriptChapter[] {
  return chapters.map(chapter => {
    if (chapter.id !== chapterId) return copyChapter(chapter);
    return { ...copyChapter(chapter), memoryIds: chapter.memoryIds.filter(id => id !== memoryId) };
  });
}

/** Puts a memory into one chapter and appends its original text once, preserving existing text and photos. */
export function placeMemoryInChapter(
  chapters: ManuscriptChapter[],
  memory: Pick<MemoryContribution, "id" | "text">,
  chapterId: string,
): ManuscriptChapter[] {
  const target = chapters.find(chapter => chapter.id === chapterId);
  const next = assignMemory(chapters, memory.id, chapterId);
  const memoryText = memory.text.trim();
  if (!target || !memoryText) return next;

  return next.map(chapter => {
    if (chapter.id !== chapterId) return chapter;
    const existingText = chapter.content.map(item => item.text ?? "").join("");
    if (existingText.includes(memoryText)) return chapter;
    const last = chapter.content[chapter.content.length - 1];
    const separator = !last ? "" : typeof last.text !== "string" ? "\n"
      : last.text.endsWith("\n\n") ? "" : last.text.endsWith("\n") ? "\n" : "\n\n";
    return {
      ...chapter,
      content: [...chapter.content.map(item => ({ ...item })), { text: separator + memoryText + "\n" }],
      handEdited: true,
    };
  });
}

/**
 * 「这一章有没有新的一段没写进」：只对已经用过这条记忆的章节才有意义——还没被任何
 * 章节引用的记忆走「还没放进书稿」那一套，不是这里说的「新段」。
 */
export function chapterHasNewSegment(chapter: ManuscriptChapter, memory: MemoryContribution): boolean {
  if (!chapter.memoryIds.includes(memory.id)) return false;
  return memorySegmentCount(memory) > (chapter.memorySegmentCounts?.[memory.id] ?? 0);
}

/** 这个故事（这一组章节）里，有没有任何一章还欠着这条记忆的新段。 */
export function hasUnwrittenSegments(chapters: ManuscriptChapter[], memory: MemoryContribution): boolean {
  return chapters.some(chapter => chapterHasNewSegment(chapter, memory));
}

function newEditId(now = new Date()): string {
  return `edit-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 写进（阶段 1）：不直接改正文，只给这一章提一条「待确认」的新增——水位之后还没写进的
 * 那些段，原文拼在一起，标为用户原话（不标 AI）。用户 2026-09-15 定：自己讲的话接上去
 * 也要点一下确认，跟 AI 改的一视同仁，只是框里不写「AI 生成」。
 *
 * 已有其它待确认修订时，追加到同一批里，不打断正在确认的流程。这条记忆当时有几段
 * 记在这条修订上，确认时不用重新查记忆就能更新水位。
 *
 * 阶段 2（AI 整章重新整理，产出「建议删除」的修订）还没做，见 docs/2026-09-15-memory-segments-plan.md。
 */
export function proposeMemorySegmentInsert(
  chapters: ManuscriptChapter[],
  memory: MemoryContribution,
  chapterId: string,
  now = new Date(),
): ManuscriptChapter[] {
  const target = chapters.find(chapter => chapter.id === chapterId);
  if (!target) return chapters.map(copyChapter);
  const segments = memorySegments(memory);
  const watermark = target.memorySegmentCounts?.[memory.id] ?? 0;
  const newText = segments.slice(watermark).map(item => item.text.trim()).filter(Boolean).join("\n").trim();
  if (!newText) return chapters.map(copyChapter);

  const edit: ChapterEdit = {
    id: newEditId(now),
    kind: "insert",
    text: newText,
    source: "memory",
    memoryId: memory.id,
    memorySegmentCountAtProposal: segments.length,
    status: "pending",
  };
  return chapters.map(chapter => {
    if (chapter.id !== chapterId) return copyChapter(chapter);
    return {
      ...copyChapter(chapter),
      pendingRevision: {
        createdAt: chapter.pendingRevision?.createdAt ?? now.toISOString(),
        edits: [...(chapter.pendingRevision?.edits ?? []), edit],
      },
    };
  });
}

/** 逐条确认/不要一处待确认修订；不改任何文字，只改这一条的状态。 */
export function resolvePendingEdit(
  chapters: ManuscriptChapter[],
  chapterId: string,
  editId: string,
  decision: "accept" | "reject",
): ManuscriptChapter[] {
  return chapters.map(chapter => {
    if (chapter.id !== chapterId || !chapter.pendingRevision) return copyChapter(chapter);
    const status: ChapterEditStatus = decision === "accept" ? "accepted" : "rejected";
    const edits = chapter.pendingRevision.edits.map(edit => edit.id === editId ? { ...edit, status } : edit);
    return { ...copyChapter(chapter), pendingRevision: { ...chapter.pendingRevision, edits } };
  });
}

/** 还有没确认/不要的修订吗——只有全部处理完，才能生成新版本。 */
export function pendingRevisionResolved(chapter: ManuscriptChapter): boolean {
  return !chapter.pendingRevision || chapter.pendingRevision.edits.every(edit => edit.status !== "pending");
}

/** 底部「还有 N 处等你确认」的数字。 */
export function pendingEditCount(chapters: ManuscriptChapter[]): number {
  return chapters.reduce((total, chapter) =>
    total + (chapter.pendingRevision?.edits.filter(edit => edit.status === "pending").length ?? 0), 0);
}

/**
 * 全部确认完，生成这一章的正式内容：接受的新增按提出的顺序接到正文末尾（老段落已经
 * 在正文里的不重复加），更新对应记忆的水位和 memoryIds（一条记忆可以同时在好几章，
 * 只更新这一章）；被「不要」的什么都不改。确认/不要本身不算手改，不碰 `handEdited`；
 * 接受了任何一处 AI 来源的新增，标 `containsAiText`。
 */
export function finalizePendingRevision(chapters: ManuscriptChapter[], chapterId: string): ManuscriptChapter[] {
  return chapters.map(chapter => {
    if (chapter.id !== chapterId) return copyChapter(chapter);
    if (!chapter.pendingRevision) return copyChapter(chapter);
    if (!pendingRevisionResolved(chapter)) throw new Error("还有没确认的修订，请先逐条确认");

    let content = chapter.content.map(item => ({ ...item }));
    const memoryIds = [...chapter.memoryIds];
    const memorySegmentCounts = { ...chapter.memorySegmentCounts };
    let containsAiText = Boolean(chapter.containsAiText);

    for (const edit of chapter.pendingRevision.edits) {
      if (edit.status !== "accepted" || edit.kind !== "insert") continue;
      const last = content[content.length - 1];
      const separator = !last ? "" : typeof last.text !== "string" ? "\n"
        : last.text.endsWith("\n\n") ? "" : last.text.endsWith("\n") ? "\n" : "\n\n";
      content = [...content, { text: separator + edit.text + "\n" }];
      if (edit.source === "ai") containsAiText = true;
      if (edit.memoryId) {
        if (!memoryIds.includes(edit.memoryId)) memoryIds.push(edit.memoryId);
        if (edit.memorySegmentCountAtProposal !== undefined) {
          memorySegmentCounts[edit.memoryId] = Math.max(memorySegmentCounts[edit.memoryId] ?? 0, edit.memorySegmentCountAtProposal);
        }
      }
    }

    const next: ManuscriptChapter = { ...copyChapter(chapter), content, memoryIds, memorySegmentCounts };
    delete next.pendingRevision;
    if (containsAiText) next.containsAiText = true;
    return next;
  });
}

/** 标识文字：小标签用（不带书名号），复制/导出场景用 chapterAiExportPrefix。 */
export function chapterAiLabel(chapter: ManuscriptChapter): "" | "文字 AI 生成" | "文字 AI 生成 · 已由你修改" {
  if (!chapter.containsAiText && chapter.generationMode !== "cloud-ai") return "";
  return chapter.handEdited ? "文字 AI 生成 · 已由你修改" : "文字 AI 生成";
}

/** 复制/导出这一章文字时，按《人工智能生成合成内容标识办法》加的显式前缀；没有 AI 文字时不加。 */
export function chapterAiExportPrefix(chapter: ManuscriptChapter): string {
  const label = chapterAiLabel(chapter);
  return label ? `【${label}】` : "";
}

export function unassignedMemoryIds(chapters: ManuscriptChapter[], memoryIds: string[]) {
  const used = new Set(chapters.flatMap(chapter => chapter.memoryIds));
  return memoryIds.filter(id => !used.has(id));
}

/** Replaces one chapter's name and/or text; every other chapter is copied unchanged. */
export function updateChapter(chapters: ManuscriptChapter[], id: string, patch: { title?: string; content?: ManuscriptContent[] }): ManuscriptChapter[] {
  return chapters.map(chapter => {
    if (chapter.id !== id) return copyChapter(chapter);
    const next = copyChapter(chapter);
    if (patch.title !== undefined) next.title = patch.title.trim().slice(0, 40);
    if (patch.content && JSON.stringify(patch.content) !== JSON.stringify(chapter.content)) {
      next.content = patch.content.map(item => ({ ...item }));
      next.handEdited = true;
    }
    return next;
  });
}

const TEMPLATE_TITLES = /^(被记住的日常|我记得的那一天)$/;

/** Chapter name from an AI title: drop a "第X章｜" prefix and the generators' template names. */
export function organizedChapterTitle(aiTitle: string) {
  const name = aiTitle.replace(/^第[一二三四五六七八九十百零〇\d]+章\s*[｜|:：·—-]?\s*/, "").trim();
  return TEMPLATE_TITLES.test(name) ? "" : name.slice(0, 40);
}

/**
 * Writes an organized text into one chapter (or a new one). Only that chapter's text
 * changes: its photos stay after the new text in their order, the chosen memories move
 * into it, and every other chapter is copied unchanged.
 */
export function applyOrganized(chapters: ManuscriptChapter[], targetId: string, organized: BiographyDraft, memoryIds: string[]) {
  const creating = !chapters.some(chapter => chapter.id === targetId);
  let next = creating ? addChapter(chapters, organizedChapterTitle(organized.title), memoryIds) : chapters.map(copyChapter);
  const chapterId = creating ? next[next.length - 1].id : targetId;
  for (const memoryId of memoryIds) next = assignMemory(next, memoryId, chapterId);
  let keptPhotoIds: string[] = [];
  next = next.map(chapter => {
    if (chapter.id !== chapterId) return chapter;
    keptPhotoIds = chapter.content.flatMap(item => item.photoId ? [item.photoId] : []);
    const content: ManuscriptContent[] = [{ text: organized.paragraphs.join("\n\n") + "\n" }];
    for (const photoId of keptPhotoIds) content.push({ photoId }, { text: "\n" });
    const written = { ...chapter, title: chapter.title || organizedChapterTitle(organized.title), content, generationMode: organized.generationMode, generatedAt: organized.generatedAt };
    delete written.handEdited;
    return written;
  });
  return { chapters: next, chapterId, keptPhotoIds };
}

const MAX_PENDING_EDITS = 60;
/** 一处修订可能是好几段记忆拼起来的，上限和整本书正文一样宽松，只是防止异常数据。 */
const MAX_EDIT_TEXT = MAX_BOOK_TEXT;

function validatePendingRevision(pendingRevision: unknown): void {
  if (!pendingRevision || typeof pendingRevision !== "object") throw new Error("待确认修订格式无效");
  const { createdAt, edits } = pendingRevision as { createdAt?: unknown; edits?: unknown };
  if (typeof createdAt !== "string") throw new Error("待确认修订格式无效");
  if (!Array.isArray(edits) || edits.length > MAX_PENDING_EDITS) throw new Error("待确认修订太多，请先处理完再继续");
  const ids = new Set<string>();
  for (const edit of edits as ChapterEdit[]) {
    if (!edit || typeof edit.id !== "string" || ids.has(edit.id)) throw new Error("待确认修订格式无效");
    ids.add(edit.id);
    if (edit.kind !== "insert" && edit.kind !== "delete") throw new Error("待确认修订格式无效");
    if (typeof edit.text !== "string" || edit.text.length > MAX_EDIT_TEXT) throw new Error("单处修订最多 " + MAX_EDIT_TEXT + " 字");
    if (edit.source !== "ai" && edit.source !== "memory") throw new Error("待确认修订格式无效");
    if (edit.status !== "pending" && edit.status !== "accepted" && edit.status !== "rejected") throw new Error("待确认修订格式无效");
  }
}

export function validateChapters(chapters: unknown) {
  if (!Array.isArray(chapters) || !chapters.length || chapters.length > MAX_CHAPTERS) throw new Error("一本书稿最多 " + MAX_CHAPTERS + " 章");
  const ids = new Set<string>();
  const all: ManuscriptContent[] = [];
  for (const chapter of chapters as ManuscriptChapter[]) {
    if (!chapter || typeof chapter.id !== "string" || !CHAPTER_ID.test(chapter.id) || ids.has(chapter.id)) throw new Error("章节编号无效，请重新打开书稿");
    ids.add(chapter.id);
    if (typeof chapter.title !== "string" || chapter.title.length > 40) throw new Error("章节标题最多 40 字");
    if (chapter.backdropImageId !== undefined &&
      (typeof chapter.backdropImageId !== "string" || !CHAPTER_BACKDROP_ID.test(chapter.backdropImageId))) throw new Error("章节底图引用无效");
    if (!Array.isArray(chapter.memoryIds) || chapter.memoryIds.length > 500 ||
      !chapter.memoryIds.every(id => typeof id === "string" && id.length <= 120)) throw new Error("章节里的记忆列表无效");
    if (!Array.isArray(chapter.content)) throw new Error("图文内容格式无效");
    all.push(...chapter.content);
    if (chapter.pendingRevision !== undefined) validatePendingRevision(chapter.pendingRevision);
    if (chapter.containsAiText !== undefined && typeof chapter.containsAiText !== "boolean") throw new Error("章节标记无效");
  }
  // Limits count each chapter once. The flattened copy for older clients is derived, not counted again.
  validateContent(all);
  if (all.reduce((total, item) => total + (item.text?.length ?? 0), 0) > MAX_BOOK_TEXT) throw new Error("正文最多 " + MAX_BOOK_TEXT + " 字");
}

export function validateManuscriptDraft(draft: BiographyDraft) {
  if (!draft.chapters) {
    validateContent(draft.content);
    if (!draft.title.trim() || !draft.paragraphs.some(text => text.trim())) throw new Error("书稿标题和正文不能为空");
    if (draft.title.length > 80 || draft.paragraphs.join("\n").length > MAX_BOOK_TEXT) throw new Error("书稿标题最多 80 字，正文最多 20000 字");
    return;
  }
  if (!draft.title.trim()) throw new Error("书稿标题不能为空");
  if (draft.title.length > 80) throw new Error("书稿标题最多 80 字");
  validateChapters(draft.chapters);
  const flat = flattenChapters(draft.chapters);
  if (JSON.stringify(flat.content) !== JSON.stringify(draft.content) || JSON.stringify(flat.paragraphs) !== JSON.stringify(draft.paragraphs)) {
    throw new Error("章节和全文不一致，请重新打开书稿");
  }
}
