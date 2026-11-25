import { replaceArticleBlockText, type ArticleChapter } from './articleModules';

export interface SentenceEdit {
  chapterId: string;
  revisionId: string;
  blockId: string;
  source: string;
  start: number;
  before: string;
  after: string;
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
}

export interface SentenceReview {
  id: string;
  blockId: string;
  prefix: string;
  before: string;
  after: string;
  suffix: string;
}

const quoted = '“([^”]+)”|「([^」]+)」|『([^』]+)』|"([^"]+)"';
const replacement = new RegExp('^(?:请\\s*)?(?:只\\s*)?(?:把|将)\\s*(.+?)\\s*(?:改成|换成|替换为)\\s*(?:' + quoted + ')\\s*[。.]?$');
const englishReplacement = new RegExp('^(?:change|replace)\\s+(.+?)\\s+(?:to|with)\\s+(?:' + quoted + ')\\s*\\.?$', 'i');
const quotedTarget = new RegExp('^(?:' + quoted + ')$');
const sentenceEnd = /[。！？!?…]|\.(?=\s|$)/u;
const sentencePattern = /[^。！？!?…\n]+?(?:[。！？!?…]+|\.(?=\s|$))(?:[”’」』）)]+)?|[^。！？!?…\n]+/gu;

function sectionHeading(line: string): string {
  const title = line.trim().replace(/^#{1,6}\s+|^\*\*|\*\*$/g, '').replace(/[（(][^）)]*[）)]$/, '').trim();
  if (/^书稿$|^manuscript$/i.test(title)) return 'manuscript';
  if (/^#{1,6}\s/.test(line.trim()) || /^微信$|^朋友圈|^给.{1,24}的微信$|^wechat(?: message)?$/i.test(title)) return 'other';
  return '';
}

export function proposeSentenceEdit(text: string, chapter: ArticleChapter, revisionId: string, selectedBlockId = ''):
  SentenceEdit | 'unresolved' | undefined {
  const match = replacement.exec(text.trim()) || englishReplacement.exec(text.trim());
  if (!match) return undefined;
  const [, target, ...quotedAfter] = match;
  const after = quotedAfter.find(Boolean)?.trim() || '';
  if (!after || after.includes('\n') || after.length > 500) return 'unresolved';

  const blocks = chapter.content.filter(block => typeof block.text === 'string');
  const lines = blocks.flatMap(block => {
    let offset = 0;
    return block.text!.split('\n').map(value => {
      const line = { block, value, offset, heading: sectionHeading(value) };
      offset += value.length + 1;
      return line;
    });
  });
  const literal = quotedTarget.exec(target)?.slice(1).find(Boolean);
  const last = /^(?:书稿(?:的)?|本章(?:的)?)?最后一句$|^(?:the )?(?:manuscript(?:'s)? )?last sentence$/i.test(target);
  let eligible = lines;
  if (last && /书稿|manuscript/i.test(target)) {
    const starts = lines.map((line, index) => line.heading === 'manuscript' ? index : -1).filter(index => index >= 0);
    if (starts.length === 1) {
      const start = starts[0];
      const end = lines.findIndex((line, index) => index > start && !!line.heading);
      eligible = lines.slice(start + 1, end === -1 ? undefined : end);
    } else if (starts.length || (sectionHeading(chapter.title) !== 'manuscript' && lines.some(line => !!line.heading))) {
      return 'unresolved';
    }
  } else if (selectedBlockId && !/本章|chapter/i.test(target)) {
    eligible = lines.filter(line => line.block.blockId === selectedBlockId);
  }
  const candidates = eligible.filter(line => !line.heading).flatMap(line =>
    Array.from(line.value.matchAll(sentencePattern)).flatMap(part => {
      const before = part[0].trim();
      const start = line.offset + part.index! + part[0].indexOf(before);
      return before ? [{ block: line.block, before, start }] : [];
    }));
  const hits = literal ? candidates.filter(item => item.before === literal) : [];
  const hit = last ? candidates[candidates.length - 1] : hits.length === 1 ? hits[0] : undefined;
  if (!hit || hit.before === after || after.replace(/[”’」』）)]+$/, '').replace(/[。！？!?….]+$/, '').match(sentenceEnd)) return 'unresolved';
  return { chapterId: chapter.id, revisionId, blockId: hit.block.blockId, source: hit.block.text!,
    start: hit.start, before: hit.before, after, status: 'pending' };
}

export function sentenceReview(chapter: ArticleChapter, revisionId: string, id: string, edit: SentenceEdit): SentenceReview | undefined {
  const source = chapter.content.find(block => block.blockId === edit.blockId)?.text;
  if (edit.status !== 'pending' || edit.chapterId !== chapter.id || edit.revisionId !== revisionId ||
      typeof source !== 'string' || source !== edit.source || source.slice(edit.start, edit.start + edit.before.length) !== edit.before) return;
  return { id, blockId: edit.blockId, prefix: source.slice(0, edit.start), before: edit.before, after: edit.after,
    suffix: source.slice(edit.start + edit.before.length) };
}

export function applySentenceReview(chapter: ArticleChapter, review: SentenceReview): ArticleChapter {
  const nextText = review.prefix + review.after + review.suffix;
  if (nextText.length > 20000) throw new Error('TEXT_LIMIT');
  return replaceArticleBlockText(chapter, review.blockId, review.prefix + review.before + review.suffix, nextText);
}

export function sentenceEditLabels(language = '') {
  return /^en(?:[-_]|$)/i.test(language) ? {
    pending: 'Review edit in draft', accepted: 'Edit accepted', rejected: 'Edit rejected',
    stale: 'The draft has changed. Send the edit again to review it.',
    choiceStale: 'The passages have changed. Send the edit request again.',
    unresolved: 'Which sentence should I change? Quote the original sentence and give me the new wording.',
    protected: 'This draft is read-only.', accept: 'Accept edit', reject: 'Reject edit',
    saveFailed: 'Could not save. Check the draft status for details.', limit: 'This paragraph would exceed 20,000 characters.',
  } : {
    pending: '在原文中查看修改', accepted: '已采用修改', rejected: '已放弃修改',
    stale: '正文已更新，请重新发送修改要求。', unresolved: '你想改哪一句？可以把原句和要替换成的话发给我。',
    choiceStale: '正文已更新，请重新发送修改要求。',
    protected: '这篇原文只读。', accept: '采用修改', reject: '放弃修改',
    saveFailed: '暂未保存，请查看正文的保存提示。', limit: '这一段修改后将超过两万字。',
  };
}
