import { BiographyDraft, ManuscriptChapter, ManuscriptContent, MemoryContribution } from "../domain/biography";
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
