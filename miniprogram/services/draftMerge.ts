import type { BiographyDraft, ManuscriptChapter } from '../domain/biography';
import { articleChapter, type ArticleChapter } from './articleModules';
import { draftWithChapters } from './chapters';

// Cloud serializers can reorder keys. Comparing serialized objects directly would
// turn an unchanged paragraph into a conflict, or fail to recognise an acknowledgement.
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value)
    .filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
}
export const sameDraftValue = (a: unknown, b: unknown) => stable(a) === stable(b);
export class DraftMergeConflict extends Error {
  code = 'DRAFT_MERGE_CONFLICT';
  constructor(field: string) { super(`${field}在本机和云端都有不同修改，两份内容均已保留`); }
}
function field<T>(base: T, local: T, remote: T, label: string): T {
  if (sameDraftValue(local, base) || sameDraftValue(local, remote)) return remote;
  if (sameDraftValue(remote, base)) return local;
  throw new DraftMergeConflict(label);
}
function body(chapter: ArticleChapter) {
  return {content:chapter.content.map(b => ({blockId:b.blockId,
    ...(typeof b.text === 'string' ? {text:b.text} : {photoId:b.photoId})})), layout:chapter.layout, audioModules:chapter.audioModules || [], packageAssets:chapter.packageAssets || {}};
}
function normalized(chapter: ManuscriptChapter): ArticleChapter {
  const result=articleChapter(chapter);
  // Native legacy editor adds one terminal newline; already assigned article
  // blocks contain the actual user text and must not lose another newline.
  result.content=result.content.map(block=>{
    const original=chapter.content.find(b=>b.blockId===block.blockId);
    return original && typeof original.text==='string' && typeof block.text==='string' ? {...block,text:original.text} : block;
  });
  return result;
}
export function mergeArticleChanges(base: ManuscriptChapter, local: ManuscriptChapter, remote: ManuscriptChapter): ArticleChapter {
  if (base.id !== local.id || remote.id !== local.id) throw new DraftMergeConflict('章节');
  const b=normalized(base), l=normalized(local), r=normalized(remote);
  const selected=field(body(b),body(l),body(r),`“${local.title || remote.title}”的正文或排版`);
  return {...r, title:field(b.title,l.title,r.title,'章节标题'), ...selected,
    backdropImageId:field(b.backdropImageId || '',l.backdropImageId || '',r.backdropImageId || '','章节底图'),
    memoryIds:[...new Set([...r.memoryIds,...l.memoryIds])],
    // Server-owned source attribution comes from the current version, never from a local cache.
    content:selected.content.map(block => {
      const existing=r.content.find(b=>b.blockId===block.blockId), mine=l.content.find(b=>b.blockId===block.blockId);
      return {...block,...(existing?.sourceIds ? {sourceIds:existing.sourceIds} : {}),
        ...(!existing && mine?.parentBlockId ? {parentBlockId:mine.parentBlockId} : {})};
    }),
  };
}
export function sameArticleContent(a: ManuscriptChapter, b: ManuscriptChapter): boolean {
  const x=normalized(a), y=normalized(b);
  return sameDraftValue([x.title,body(x),x.backdropImageId || '',[...x.memoryIds].sort()],
    [y.title,body(y),y.backdropImageId || '',[...y.memoryIds].sort()]);
}

/** Apply only the edits made since the draft's immutable base. Unopened chapters
 * in an old whole-book backup must never roll newer cloud chapters back. */
export function mergeBookChanges(base: BiographyDraft, local: BiographyDraft, remote: BiographyDraft): BiographyDraft {
  const before=base.chapters || [], mine=local.chapters || [], latest=remote.chapters || [];
  const order=field(before.map(c=>c.id),mine.map(c=>c.id),latest.map(c=>c.id),'章节顺序');
  const chapters=order.map(id=>{
    const b=before.find(c=>c.id===id), l=mine.find(c=>c.id===id), r=latest.find(c=>c.id===id);
    if (!b) return field(undefined,l,r,'新增章节')!;
    if (!l || !r) return field(b,l,r,'章节删除')!;
    // Keep untouched legacy chapters byte-for-byte, including provenance metadata.
    if (sameDraftValue(b,l) || sameDraftValue(l,r)) return r;
    if (sameDraftValue(b,r)) return l;
    return mergeArticleChanges(b,l,r);
  }).filter(Boolean);
  // Deleting an entry must also check changes in the removed chapter.
  for (const b of before.filter(c=>!order.includes(c.id)))
    field(b,mine.find(c=>c.id===b.id),latest.find(c=>c.id===b.id),'章节删除');
  return draftWithChapters({...remote,
    title:field(base.title,local.title,remote.title,'书名'),
    introduction:field(base.introduction,local.introduction,remote.introduction,'简介')},chapters);
}
