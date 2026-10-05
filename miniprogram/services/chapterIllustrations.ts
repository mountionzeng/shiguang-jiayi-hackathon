import { ManuscriptContent } from '../domain/biography';
import { storyImageReferenceId, validateContent } from './bookImages';
import { chaptersOf, draftWithChapters } from './chapters';
import { currentManuscript, makeRevision, saveManuscriptRevision } from './manuscript';
import { loadRoomStateRemoteFirst } from './roomRepository';
import { activeStory } from './storyBooks';
import { storyImageApi } from './storyImageService';

export interface IllustrationAnchor { text: string; occurrence: number; matches: number }
export interface IllustrationPoint { label: string; after: IllustrationAnchor | null; block: number; offset: number }

function mergeText(content: ManuscriptContent[]): ManuscriptContent[] {
  const result: ManuscriptContent[] = [];
  for (const item of content) {
    const last = result[result.length - 1];
    if (typeof item.text === 'string' && typeof last?.text === 'string') last.text += item.text;
    else result.push({ ...item });
  }
  return result;
}

/** Anchors describe actual paragraph text, never a stale paragraph index. */
export function illustrationPoints(content: ManuscriptContent[], excludeImageId?: string): IllustrationPoint[] {
  if (excludeImageId) content = mergeText(content.filter(item => item.photoId !== storyImageReferenceId(excludeImageId)));
  const rows: Array<{ text: string; block: number; offset: number }> = [];
  content.forEach((item, block) => {
    if (typeof item.text !== 'string') return;
    for (const match of item.text.matchAll(/[^\r\n]+(?:\r\n|\n|\r)*/g)) {
      const text = match[0].trim();
      if (text) rows.push({ text, block, offset: match.index! + match[0].length });
    }
  });
  const totals = new Map<string, number>(), seen = new Map<string, number>();
  rows.forEach(row => totals.set(row.text, (totals.get(row.text) || 0) + 1));
  return [{ label: '正文开头', after: null, block: 0, offset: 0 }, ...rows.map((row, index) => {
    const occurrence = seen.get(row.text) || 0; seen.set(row.text, occurrence + 1);
    return { label: `第 ${index + 1} 段后 · ${row.text.slice(0, 22)}`, after: { text: row.text, occurrence, matches: totals.get(row.text)! }, block: row.block, offset: row.offset };
  })];
}

export function illustrationAnchor(content: ManuscriptContent[], imageId: string): IllustrationAnchor | null {
  const index = content.findIndex(item => item.photoId === storyImageReferenceId(imageId));
  const preceding = illustrationPoints(content).filter(point => point.after && point.block < index);
  return preceding[preceding.length - 1]?.after || null;
}

/** Images live between text blocks in the existing manuscript; native edits retain their location. */
export function placeIllustration(content: ManuscriptContent[], imageId: string, after: IllustrationAnchor | null, remove = false): ManuscriptContent[] {
  const photoId = storyImageReferenceId(imageId);
  if (!photoId) throw new Error('插图引用无效');
  // Protected blocks require the source-aware editing protocol; never merge away provenance.
  if (content.some(item => item.blockId !== undefined || item.sourceIds !== undefined)) throw new Error('这段正文包含受保护来源，请在书稿编辑中调整插图');
  if (!remove && content.filter(item => item.photoId === photoId).length === 1 &&
      JSON.stringify(illustrationAnchor(content, imageId)) === JSON.stringify(after) &&
      illustrationPoints(content, imageId).some(item => JSON.stringify(item.after) === JSON.stringify(after))) return content.map(item => ({ ...item }));
  const next = mergeText(content.filter(item => item.photoId !== photoId));
  if (remove) return next;
  const point = illustrationPoints(next).find(item => JSON.stringify(item.after) === JSON.stringify(after));
  if (!point) throw new Error('目标段落已修改，请重新选择插图位置');
  if (!after) {
    const firstText = next.findIndex(item => typeof item.text === 'string');
    next.splice(firstText < 0 ? next.length : firstText, 0, { photoId });
  } else {
    const block = next[point.block], text = block.text!;
    next.splice(point.block, 1, ...[
      ...(point.offset ? [{ text: text.slice(0, point.offset) }] : []),
      { photoId },
      ...(point.offset < text.length ? [{ text: text.slice(point.offset) }] : []),
    ]);
  }
  validateContent(next);
  return next;
}

export async function saveChapterIllustration(input: {
  storyId?: string; memberId?: string; chapterId: string; imageId: string; after: IllustrationAnchor | null; remove?: boolean;
}) {
  const state = await loadRoomStateRemoteFirst(), bookId = input.storyId || input.memberId || '';
  const current = currentManuscript(state, bookId);
  if (!current.draft) throw new Error('请先保存书稿再选插图');
  const chapters = chaptersOf(current.draft, current.sourceFingerprint);
  const chapter = chapters.find(item => item.id === input.chapterId);
  if (!chapter) throw new Error('这一章已变化，请重新打开书稿');
  if (!input.remove) {
    const list = await storyImageApi.listStoryImages(bookId);
    if (!list.images.some(image => image.imageId === input.imageId && image.chapterId === input.chapterId && image.purpose === 'illustration' && image.moderation === 'pass')) {
      throw new Error('这张插图暂时不可用，请重新选图');
    }
  }
  const content = placeIllustration(chapter.content, input.imageId, input.after, input.remove);
  if (JSON.stringify(content) === JSON.stringify(chapter.content)) return state;
  const next = chapters.map(item => item.id === input.chapterId ? { ...item, content } : item);
  if (next.reduce((sum, item) => sum + item.content.filter(block => block.photoId).length, 0) > 9) throw new Error('一本书稿最多放 9 张照片（含 AI 插图）');
  const revision = makeRevision(input.memberId || '', draftWithChapters(current.draft, next), current.sourceFingerprint,
    'draft', input.remove ? '移除正文插图' : '调整正文插图');
  if (input.storyId) {
    revision.storyId = activeStory(state, input.storyId).id;
    revision.expectedStoryVersion = activeStory(state, input.storyId).version;
    revision.sourceRevisionId = current.revisionId || undefined;
  }
  return saveManuscriptRevision(revision, current.revisionId);
}
