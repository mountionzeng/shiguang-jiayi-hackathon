import { FamilyRoomState, ManuscriptChapter } from "../domain/biography";
import { CHAPTER_BACKDROP_ID, chaptersOf, copyChapter, draftWithChapters } from "./chapters";
import { currentManuscript, makeRevision, saveManuscriptRevision } from "./manuscript";
import { loadRoomStateRemoteFirst } from "./roomRepository";

/** Sets (or, with an empty id, clears) one chapter's backdrop; text, name and every other chapter stay as they are. */
export function withChapterBackdrop(chapters: ManuscriptChapter[], chapterId: string, imageId: string): ManuscriptChapter[] {
  if (!chapters.some(chapter => chapter.id === chapterId)) throw new Error("没找到这一章，请重新打开书稿");
  if (imageId && !CHAPTER_BACKDROP_ID.test(imageId)) throw new Error("章节底图引用无效");
  return chapters.map(chapter => {
    const next = copyChapter(chapter);
    if (chapter.id !== chapterId) return next;
    if (imageId) next.backdropImageId = imageId;
    else delete next.backdropImageId;
    return next;
  });
}

/**
 * Saves the choice as a new version, so restoring an older version also restores its backdrop.
 * Choosing the backdrop a chapter already has saves nothing.
 */
export async function saveChapterBackdrop(input: { memberId: string; chapterId: string; imageId: string }): Promise<FamilyRoomState> {
  const state = await loadRoomStateRemoteFirst();
  const current = currentManuscript(state, input.memberId);
  if (!current.draft) throw new Error("这本书还没有保存过，先保存书稿再选底图");
  const chapters = chaptersOf(current.draft, current.sourceFingerprint);
  const chapter = chapters.find(item => item.id === input.chapterId);
  if (!chapter) throw new Error("没找到这一章，请重新打开书稿");
  if ((chapter.backdropImageId ?? "") === input.imageId) return state;
  const next = withChapterBackdrop(chapters, input.chapterId, input.imageId);
  const revision = makeRevision(input.memberId, draftWithChapters(current.draft, next), current.sourceFingerprint,
    "draft", input.imageId ? "设置本章底图" : "不用本章底图");
  return saveManuscriptRevision(revision, current.revisionId);
}
