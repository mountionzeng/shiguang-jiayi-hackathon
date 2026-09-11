import { BiographyDraft, FamilyRoomState, ManuscriptContent, ManuscriptRevision } from "../domain/biography";
import { loadRoomStateRemoteFirst, usesCloudStorage } from "./roomRepository";
import { saveCloudManuscriptRevision } from "./cloudRoomStorage";
import { saveRoomState } from "./roomStorage";
import { contentFromDelta, contentToDelta } from "./bookImages";
import { addChapter, copyChapter, draftWithChapters, validateManuscriptDraft } from "./chapters";

/** Photo references in reading order, including markers left inside older text-only drafts. */
export function manuscriptPhotoIds(draft: BiographyDraft): string[] {
  const content = draft.content ?? [{ text: draft.paragraphs.join("\n\n") }];
  return contentFromDelta(contentToDelta(content, {}), {}).flatMap(item => item.photoId ? [item.photoId] : []);
}

/**
 * An AI candidate replaces only the wording. The user's own title and every photo
 * reference stay; photos keep their order after the new text.
 */
export function adoptCandidateDraft(current: BiographyDraft | undefined, candidate: BiographyDraft) {
  if (!current) return { draft: candidate, keptPhotoIds: [] as string[], newChapter: false };
  if (current.chapters?.length) {
    // A chaptered book never has its chapters replaced wholesale: the AI text becomes a new last chapter.
    const chapters = addChapter(current.chapters);
    const added = chapters[chapters.length - 1];
    added.content = [{ text: candidate.paragraphs.join("\n\n") + "\n" }];
    added.generationMode = candidate.generationMode;
    added.generatedAt = candidate.generatedAt;
    return { draft: draftWithChapters({ ...candidate, title: current.title }, chapters), keptPhotoIds: [] as string[], newChapter: true };
  }
  const keptPhotoIds = manuscriptPhotoIds(current);
  const content: ManuscriptContent[] = [{ text: candidate.paragraphs.join("\n\n") + "\n" }];
  for (const photoId of keptPhotoIds) content.push({ photoId }, { text: "\n" });
  return {
    draft: { ...candidate, title: current.title.trim() || candidate.title, content },
    keptPhotoIds,
    newChapter: false,
  };
}

function revisionContent(revision: ManuscriptRevision) {
  // Database serializers may reorder object keys.
  const { draft } = revision;
  return JSON.stringify([revision.id, revision.memberId, revision.kind, revision.label,
    revision.savedAt, revision.sourceFingerprint, draft.title, draft.paragraphs,
    draft.sourceCount, draft.generatedAt, draft.generationMode, draft.content ?? null,
    draft.chapters?.map(chapter => [chapter.id, chapter.title, chapter.memoryIds, chapter.content,
      chapter.handEdited ?? null, chapter.generationMode ?? null, chapter.generatedAt ?? null]) ?? null]);
}

export function manuscriptHistory(state: FamilyRoomState, memberId: string) {
  return (state.manuscriptRevisions ?? []).filter(item => item.memberId === memberId)
    .slice().sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.id.localeCompare(a.id));
}

export function currentManuscript(state: FamilyRoomState, memberId: string): {
  draft?: BiographyDraft; sourceFingerprint: string; revisionId: string;
} {
  const latest = manuscriptHistory(state, memberId)[0];
  if (latest) return { draft: latest.draft, sourceFingerprint: latest.sourceFingerprint, revisionId: latest.id.startsWith("legacy-") ? "" : latest.id };
  return {
    draft: state.personalDrafts?.[memberId] ?? state.legacyPersonalDrafts?.[memberId],
    sourceFingerprint: "",
    revisionId: "",
  };
}

export function makeRevision(memberId: string, draft: BiographyDraft, sourceFingerprint: string,
  kind: ManuscriptRevision["kind"], label: string): ManuscriptRevision {
  return {
    id: `revision-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    memberId, kind, label, sourceFingerprint, savedAt: new Date().toISOString(),
    draft: {
      ...draft, paragraphs: [...draft.paragraphs],
      ...(draft.content ? { content: draft.content.map(item => ({ ...item })) } : {}),
      ...(draft.chapters ? { chapters: draft.chapters.map(copyChapter) } : {}),
    },
  };
}

export async function saveManuscriptRevision(revision: ManuscriptRevision, expectedRevisionId: string) {
  const state = await loadRoomStateRemoteFirst();
  if (!state.members.some(member => member.id === revision.memberId && member.kind !== "person")) throw new Error("请先选择记录档案");
  validateManuscriptDraft(revision.draft);
  const existing = state.manuscriptRevisions?.find(item => item.id === revision.id);
  if (existing) {
    if (revisionContent(existing) !== revisionContent(revision)) throw new Error("保存编号冲突，请重新打开书稿");
    return state; // An acknowledgement lost after a successful write is safe to retry.
  }
  const current = currentManuscript(state, revision.memberId);
  if (current.revisionId !== expectedRevisionId) throw new Error("已有更新的书稿，请先退出编辑并重新加载");
  const history = manuscriptHistory(state, revision.memberId);
  if (history[0] && revision.savedAt <= history[0].savedAt) {
    revision.savedAt = new Date(new Date(history[0].savedAt).getTime() + 1).toISOString();
  }
  // Preserve the legacy generated text before the first edit/AI adoption.
  const legacy = !history.length && current.draft
    ? { ...makeRevision(revision.memberId, current.draft, "", "version", "原有书稿"), id: `legacy-${revision.memberId}`, savedAt: "1970-01-01T00:00:00.000Z" }
    : undefined;
  if (usesCloudStorage()) {
    if (legacy) await saveCloudManuscriptRevision(legacy);
    await saveCloudManuscriptRevision(revision);
  } else {
    saveRoomState({ ...state, manuscriptRevisions: [...(state.manuscriptRevisions ?? []), ...(legacy ? [legacy] : []), revision] });
  }
  return { ...state, manuscriptRevisions: [...(state.manuscriptRevisions ?? []), ...(legacy ? [legacy] : []), revision] };
}
