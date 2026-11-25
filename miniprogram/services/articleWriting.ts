import type { ArticleChapter } from './articleModules';
import type { SentenceEdit } from './articleSentenceEdit';

interface Paragraph {
  start: number;
  end: number;
  blockId: string;
  blockStart: number;
  blockEnd: number;
  editable: boolean;
  selected: boolean;
}
export interface ArticleWritingContext {
  chapterId: string;
  title: string;
  revisionId: string;
  version: number;
  paragraphs: Paragraph[];
  chosen?: number;
  recent?: { target: number; start: number; end: number; draft: string };
}
export type ArticleWritingDecision =
  | { kind: 'edit'; target: number; start: number; end: number; replacement: string }
  | { kind: 'clarify'; targets: number[] }
  | { kind: 'draft'; label: string };
export interface ArticleWritingChoice {
  key: string;
  blockId: string;
  offset: number;
  paragraph: string;
  excerpt: string;
}
export interface ArticleWritingChoices {
  chapterId: string;
  revisionId: string;
  request: string;
  items: ArticleWritingChoice[];
  chosen?: number;
}

export function articleWritingSnapshot(chapter: ArticleChapter, revisionId: string, version: number, selectedBlockId = '') {
  const blocks = chapter.content.filter(block => typeof block.text === 'string');
  const fullLength = blocks.reduce((sum, block) => sum + block.text!.length + 1, 0);
  const fullParagraphs = blocks.reduce((sum, block) => sum + block.text!.split('\n').filter(line => line.trim()).length, 0);
  const useSelection = fullLength > 40001 || fullParagraphs > 1600;
  if (useSelection && !selectedBlockId) throw new Error('这一章超过当前对话容量。请先点一下要改的文字，再发给小忆。');
  const paragraphs: Paragraph[] = [];
  const sources: string[] = [];
  let sourceLength = 0;
  let locked = false;
  for (const block of blocks) {
    const blockStart = sourceLength;
    const include = !useSelection || block.blockId === selectedBlockId;
    const value = block.text!;
    let offset = 0;
    for (const line of value.split('\n')) {
      const clean = line.trim();
      const label = clean.replace(/^#{1,6}\s+/, '').replace(/^\*\*|\*\*$/g, '').trim();
      const alternative = /^(?:给.{1,24}的微信|微信(?:版)?|朋友圈(?:版)?|wechat(?: message)?|social post)(?:\s*[（(][^）)]*[）)])?$/i.test(label);
      const heading = alternative || /^#{1,6}\s/.test(clean) || /^(?:书稿|manuscript)(?:\s*[（(][^）)]*[）)])?$/i.test(label);
      if (heading) locked = alternative;
      if (include && clean) {
        const start = blockStart + offset + line.indexOf(clean);
        paragraphs.push({ start, end: start + clean.length, blockStart, blockEnd: blockStart + value.length,
          blockId: block.blockId, editable: !heading && !locked, selected: block.blockId === selectedBlockId });
      }
      offset += line.length + 1;
    }
    if (include) {
      sources.push(value);
      sourceLength += value.length + 1;
    }
  }
  if (paragraphs.length > 1600) throw new Error('这一章的段落太多。请先点一下要改的文字，再发给小忆。');
  const context: ArticleWritingContext = { chapterId: chapter.id, title: chapter.title, revisionId, version, paragraphs };
  return { source: sources.join('\n'), context };
}

export function recentArticleEdit(source: string, context: ArticleWritingContext, edit?: SentenceEdit) {
  if (!edit || edit.chapterId !== context.chapterId || !['pending', 'accepted'].includes(edit.status)) return;
  if (edit.status === 'pending' && edit.revisionId !== context.revisionId) return;
  const expected = edit.status === 'accepted'
    ? edit.source.slice(0, edit.start) + edit.after + edit.source.slice(edit.start + edit.before.length) : edit.source;
  const quote = edit.status === 'accepted' ? edit.after : edit.before;
  const target = context.paragraphs.findIndex(p => p.editable && p.blockId === edit.blockId &&
    source.slice(p.blockStart, p.blockEnd) === expected &&
    p.blockStart + edit.start >= p.start && p.blockStart + edit.start + quote.length <= p.end);
  if (target < 0) return;
  const p = context.paragraphs[target];
  const start = p.blockStart + edit.start - p.start;
  return { target, start, end: start + quote.length, draft: edit.after };
}

export function articleWritingPayload(context: ArticleWritingContext) {
  return { chapterId: context.chapterId, title: context.title, revisionId: context.revisionId, version: context.version,
    paragraphs: context.paragraphs.map(({start, end, editable, selected}) => ({start, end, editable, selected})),
    ...(context.chosen === undefined ? {} : { chosen: context.chosen }),
    ...(context.recent ? { recent: context.recent } : {}),
  };
}

export function articleWritingResult(source: string, context: ArticleWritingContext, request: string, decision?: ArticleWritingDecision):
  { sentenceEdit: SentenceEdit } | { writingChoices: ArticleWritingChoices } | undefined {
  if (decision?.kind === 'edit') {
    const {target, start, end, replacement} = decision;
    const p = context.paragraphs[target];
    if (!p?.editable || (context.chosen !== undefined && target !== context.chosen) ||
        !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > p.end - p.start ||
        typeof replacement !== 'string' || !replacement.trim() || replacement.length > 4000 || /[\r\n]/.test(replacement)) return;
    const before = source.slice(p.start + start, p.start + end);
    if (before === replacement) return;
    return { sentenceEdit: { chapterId:context.chapterId, revisionId:context.revisionId, blockId:p.blockId,
      source:source.slice(p.blockStart, p.blockEnd), start:p.start + start - p.blockStart,
      before, after:replacement, status:'pending' } };
  }
  if (decision?.kind === 'clarify' && Array.isArray(decision.targets) && decision.targets.length === 2 &&
      decision.targets[0] !== decision.targets[1] && context.chosen === undefined) {
    const items: ArticleWritingChoice[] = [];
    for (const target of decision.targets) {
      const p = context.paragraphs[target];
      if (!p?.editable) return;
      const paragraph = source.slice(p.start, p.end);
      const excerpt = paragraph.length <= 120 ? paragraph : paragraph.slice(0, 90) + '…' + paragraph.slice(-30);
      items.push({ key:String(target), blockId:p.blockId, offset:p.start - p.blockStart, paragraph, excerpt });
    }
    return { writingChoices: { chapterId:context.chapterId, revisionId:context.revisionId, request, items } };
  }
}
