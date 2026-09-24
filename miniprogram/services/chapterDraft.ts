import { BiographyDraft, ManuscriptRevision } from '../domain/biography';
import { usesCloudStorage } from './roomRepository';

export interface ChapterDraft {
  token: string;
  draft: BiographyDraft;
  chapterId: string;
  view: 'chapter' | 'contents';
  revisionId: string;
  storyVersion?: number;
  fingerprint: string;
  pendingSave?: ManuscriptRevision;
  editorError?: string;
  savedAt: string;
}

// Resolve the signed-in identity before reading a draft, never a global last-draft key.
export async function chapterDraftScope(): Promise<string> {
  if (!usesCloudStorage()) return 'local';
  const response = await wx.cloud.callFunction({name:'getOpenId'});
  const result = response.result as {openid?: string; account?: {primaryFamilyId?: string}};
  if (!result?.openid) throw new Error('无法确认草稿所属账号，请重新打开');
  return JSON.stringify([result.openid, result.account?.primaryFamilyId || '']);
}
export function chapterDraftKey(scope: string, bookId: string): string {
  if (!scope || !bookId) throw new Error('草稿所属故事尚未确认');
  return 'shiguang-chapter-draft-v1:' + encodeURIComponent(JSON.stringify([scope,bookId]));
}
export function readChapterDraft(key: string): ChapterDraft | undefined {
  const value = wx.getStorageSync<ChapterDraft | ''>(key);
  if (!value) return undefined;
  if (!value.token || !value.draft || !Array.isArray(value.draft.chapters)) throw new Error('本机草稿读取失败，已保留，请勿清理缓存');
  return value;
}
export function writeChapterDraft(key: string, draft: Omit<ChapterDraft,'token'|'savedAt'>): ChapterDraft {
  const value = {...draft, token:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2), savedAt:new Date().toISOString()};
  wx.setStorageSync(key,value);
  return value;
}
export function clearChapterDraft(key: string, token: string): void {
  if (readChapterDraft(key)?.token === token) wx.setStorageSync(key,'');
}
