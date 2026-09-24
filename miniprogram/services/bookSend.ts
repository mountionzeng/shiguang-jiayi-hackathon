import { FamilyRoomState } from '../domain/biography';
import { chaptersOf, chapterLabel } from './chapters';
import { currentManuscript } from './manuscript';
import { chapterDraftScope } from './chapterDraft';
import { loadRoomStateRemoteFirst } from './roomRepository';

export type SendScope = 'book' | 'chapters' | 'text';
export interface SendVersion { storyId: string; revisionId: string; version: number }
export interface SendChapter { id: string; title: string; text: string; characterCount: number }
export interface SendSnapshot extends SendVersion {
  accountScope: string;
  title: string;
  coverImageId: string;
  chapters: SendChapter[];
}
export interface SendSelection { scope: SendScope; chapterIds: string[]; textChapterId: string; text: string }

/** Private owner preparation only; this is not an authorization to publish sources. */
export function snapshotFromState(state: FamilyRoomState, expected: SendVersion, accountScope: string): SendSnapshot {
  const story = state.stories?.find(item => item.id === expected.storyId && !item.deletedAt);
  if (!story || !accountScope) throw new Error('这本书暂时无法读取，请回到书架重试');
  if (story.sourcePolicyRequired) throw new Error('亲友故事副本不能在这里转发，请使用原有授权入口');
  const current = currentManuscript(state, story.id);
  if (!current.draft || !current.revisionId) throw new Error('请先保存这本书，再准备发送');
  if (current.revisionId !== expected.revisionId || story.version !== expected.version) {
    throw new Error('书稿已有更新，请回到目录重新进入发送');
  }
  return {
    ...expected, accountScope, title: current.draft.title, coverImageId: story.coverImageId || '',
    chapters: chaptersOf(current.draft, current.sourceFingerprint).map((chapter, index) => {
      const text = chapter.content.map(block => typeof block.text === 'string' ? block.text : '\n').join('');
      return { id: chapter.id, title: chapterLabel(index + 1) + (chapter.title ? ' · ' + chapter.title : ''), text, characterCount: Array.from(text).length };
    }),
  };
}

export async function loadSendSnapshot(expected: SendVersion): Promise<SendSnapshot> {
  const before = await chapterDraftScope();
  const state = await loadRoomStateRemoteFirst();
  if (before !== await chapterDraftScope()) throw new Error('账号已切换，请重新进入发送');
  return snapshotFromState(state, expected, before);
}

export function selectSendText(snapshot: SendSnapshot, selection: SendSelection): SendChapter[] {
  if (selection.scope === 'book') return snapshot.chapters.map(chapter => ({ ...chapter }));
  if (selection.scope === 'chapters') {
    if (selection.chapterIds.some(id => !snapshot.chapters.some(chapter => chapter.id === id))) throw new Error('章节已经变化，请重新选择');
    return snapshot.chapters.filter(chapter => selection.chapterIds.includes(chapter.id)).map(chapter => ({ ...chapter }));
  }
  if (selection.scope !== 'text') throw new Error('请选择分享范围');
  const chapter = snapshot.chapters.find(item => item.id === selection.textChapterId);
  if (!selection.text.trim()) return [];
  if (!chapter || !chapter.text.includes(selection.text)) throw new Error('选段必须来自当前已保存的章节原文');
  return [{ ...chapter, text: selection.text, characterCount: Array.from(selection.text).length }];
}
