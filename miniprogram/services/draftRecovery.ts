import type { BiographyDraft, Story } from '../domain/biography';
import { cachedAccountScope } from './cloudRoomStorage';
import { loadRoomStateRemoteFirst, usesCloudStorage } from './roomRepository';
import { activeStory, loadStoryRevision } from './storyBooks';
import { currentManuscript, makeRevision, saveManuscriptRevision } from './manuscript';
import { saveArticle, isArticleRejected, type ArticleSaveRequest } from './articleService';
import type { ArticleChapter } from './articleModules';
import { mergeArticleChanges, mergeBookChanges, sameArticleContent, sameDraftValue, DraftMergeConflict } from './draftMerge';
import { ensurePhotoUploads } from './photoCloud';
import { chapterPhotoIds } from './chapterLayoutView';
import { readRetainedChapterDrafts, type ChapterDraft } from './chapterDraft';

export interface DraftRecovery { story: Story; draft: BiographyDraft; base: BiographyDraft }
export async function loadDraftRecovery(storyId: string, revisionId: string): Promise<DraftRecovery> {
  const scope=cachedAccountScope();
  const state=await loadRoomStateRemoteFirst({view:'home'});
  const story=activeStory(state,storyId), current=currentManuscript(state,storyId);
  const base=state.manuscriptRevisions?.find(r=>r.id===revisionId && r.storyId===storyId)
    || (usesCloudStorage() ? await loadStoryRevision(storyId,revisionId) : undefined);
  if (scope !== cachedAccountScope()) throw new Error('账号已切换，草稿仍保留在原账号');
  if (!current.draft || !story.currentRevisionId || !base?.draft) throw new Error('暂时无法读取历史书稿，修改已保留');
  return {story,draft:current.draft,base:base.draft};
}
export interface StoredArticleDraft {
  revisionId: string; storyVersion?: number; chapter: ArticleChapter; attempt?: ArticleSaveRequest | null; conflict?: boolean;
}
export const newArticleRequest = (story: Story, chapter: ArticleChapter): ArticleSaveRequest => ({
  requestId:`request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`,
  storyId:story.id, revisionId:story.currentRevisionId!, expectedVersion:story.version!, chapter, sourceMemoryIds:[...chapter.memoryIds],
});

/** A closed chapter is saved without changing which chapter the user is reading.
 * Every request is backed up before sending; unknown outcomes keep their original id. */
export async function syncStoredArticle(key: string, storyId: string,
  load: (revisionId:string)=>Promise<DraftRecovery> = id=>loadDraftRecovery(storyId,id)): Promise<void> {
  const scope=cachedAccountScope();
  for (let tries=0;tries<4;tries++) {
    let saved=wx.getStorageSync<StoredArticleDraft>(key);
    if (!saved?.chapter) return;
    const unchanged=()=>scope === cachedAccountScope() && sameDraftValue(wx.getStorageSync(key),saved);
    if (saved.conflict || !saved.storyVersion) {
      const {story,draft,base}=await load(saved.revisionId);
      if (!unchanged()) continue;
      const b=base.chapters?.find(c=>c.id===saved.chapter.id), r=draft.chapters?.find(c=>c.id===saved.chapter.id);
      if (!b || !r) throw new DraftMergeConflict('章节已被移动或删除');
      const chapter=mergeArticleChanges(b,saved.chapter,r);
      if (sameArticleContent(chapter,r)) { wx.removeStorageSync(key); return; }
      saved={revisionId:story.currentRevisionId!,storyVersion:story.version,chapter,conflict:false};
      wx.setStorageSync(key,saved);
    }
    if (scope !== cachedAccountScope()) throw new Error('账号已切换，草稿仍保留在原账号');
    if (!saved.attempt) {
      saved={...saved,attempt:newArticleRequest({id:storyId,currentRevisionId:saved.revisionId,version:saved.storyVersion} as Story,saved.chapter)};
      wx.setStorageSync(key,saved);
    }
    const attempt=saved.attempt!;
    try {
      await ensurePhotoUploads(chapterPhotoIds(attempt.chapter));
      const result=await saveArticle(attempt);
      if (!unchanged()) continue;
      if (sameDraftValue(saved.chapter,attempt.chapter)) { wx.removeStorageSync(key); return; }
      // The acknowledgement was for an older request; keep edits entered afterwards.
      wx.setStorageSync(key,{...saved,revisionId:result.revisionId,storyVersion:result.version,attempt:null,conflict:true});
    } catch(error) {
      if (isArticleRejected(error)) {
        // A different editor may have saved newer input while this request ran.
        if (!unchanged()) continue;
        wx.setStorageSync(key,{...saved,attempt:null});
        if (!sameDraftValue(saved.chapter,attempt.chapter)) continue;
        throw error;
      }
      if ((error as {code?:string})?.code !== 'VERSION_CONFLICT') throw error;
      if (unchanged()) wx.setStorageSync(key,{...saved,conflict:true});
      if (tries===3) throw error;
    }
  }
  throw new Error('书稿正在更新，修改已保留，稍后自动重试');
}

/** Recover the older whole-book backup format as a delta, not an old snapshot. */
export async function syncRetainedDraft(key: string, token: string, storyId: string): Promise<void> {
  const scope=cachedAccountScope();
  for (let tries=0;tries<3;tries++) {
    const list=readRetainedChapterDrafts(key), saved=list.find(d=>d.token===token);
    if (!saved) return;
    if (saved.editorError) throw new Error(saved.editorError);
    const replace=(next?:ChapterDraft)=>{
      if (scope !== cachedAccountScope()) throw new Error('账号已切换，草稿仍保留在原账号');
      const current=readRetainedChapterDrafts(key);
      if (!sameDraftValue(current.find(d=>d.token===token),saved)) throw new Error('本机草稿已更新，稍后自动重试');
      wx.setStorageSync(key+':retained',current.flatMap(d=>d.token===token ? next?[next]:[] : [d]));
    };
    const {story,draft,base}=await loadDraftRecovery(storyId,saved.revisionId);
    // A lost save receipt may already be in history, even if subsequent edits advanced the book.
    let baseline=base;
    if (saved.pendingSave) {
      try {
        const state=await saveManuscriptRevision(saved.pendingSave,saved.pendingSave.sourceRevisionId || saved.revisionId);
        if (sameDraftValue(saved.draft,saved.pendingSave.draft)) { replace(); return; }
        replace({...saved,revisionId:saved.pendingSave.id,storyVersion:activeStory(state,storyId).version,pendingSave:undefined});
        continue;
      } catch(error) {
        if ((error as {code?:string})?.code !== 'VERSION_CONFLICT') throw error;
      }
    }
    const merged=mergeBookChanges(baseline,saved.draft,draft);
    if (sameDraftValue(merged,draft)) { replace(); return; }
    const pending=makeRevision('',merged,saved.fingerprint,'draft','自动恢复本机修改');
    pending.storyId=storyId; pending.expectedStoryVersion=story.version; pending.sourceRevisionId=story.currentRevisionId;
    // Preserve the complete merged payload for idempotent recovery if the process exits now.
    replace({...saved,draft:merged,revisionId:story.currentRevisionId!,storyVersion:story.version,pendingSave:pending});
  }
  throw new Error('书稿正在更新，草稿已保留，稍后自动重试');
}
