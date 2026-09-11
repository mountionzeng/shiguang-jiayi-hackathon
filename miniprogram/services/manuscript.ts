import { BiographyDraft, FamilyRoomState, ManuscriptRevision } from "../domain/biography";
import { loadRoomStateRemoteFirst, usesCloudStorage } from "./roomRepository";
import { saveCloudManuscriptRevision } from "./cloudRoomStorage";
import { saveRoomState } from "./roomStorage";
import { validateContent } from "./bookImages";

function revisionContent(revision: ManuscriptRevision) {
  // Database serializers may reorder object keys.
  const { draft } = revision;
  return JSON.stringify([revision.id, revision.memberId, revision.kind, revision.label,
    revision.savedAt, revision.sourceFingerprint, draft.title, draft.paragraphs,
    draft.sourceCount, draft.generatedAt, draft.generationMode, draft.content ?? null]);
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
    draft: { ...draft, paragraphs: [...draft.paragraphs], ...(draft.content ? { content: draft.content.map(item => ({ ...item })) } : {}) },
  };
}

export async function saveManuscriptRevision(revision: ManuscriptRevision, expectedRevisionId: string) {
  const state = await loadRoomStateRemoteFirst();
  validateContent(revision.draft.content);
  if (!state.members.some(member => member.id === revision.memberId && member.kind !== "person")) throw new Error("请先选择记录档案");
  if (!revision.draft.title.trim() || !revision.draft.paragraphs.some(text => text.trim())) throw new Error("书稿标题和正文不能为空");
  if (revision.draft.title.length > 80 || revision.draft.paragraphs.join("\n").length > 20000) throw new Error("书稿标题最多 80 字，正文最多 20000 字");
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
