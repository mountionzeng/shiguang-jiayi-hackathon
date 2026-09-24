import { SendChapter, SendSelection, SendSnapshot } from './bookSend';
export interface BookExportSelection {
  storyId: string; revisionId: string; expectedVersion: number; scope: SendSelection['scope']; chapterIds: string[];
  excerpt?: { chapterId: string; start: number; end: number };
}
export interface BookExportDescriptor {
  id: string; storyId: string; revisionId: string; storyVersion: number; title: string;
  chapters: Array<Pick<SendChapter, 'id' | 'title' | 'text'>>; coverImageId: string; containsAiText: boolean;
}
export interface BookExportMaterial { descriptor: BookExportDescriptor; coverUrl: string }
async function call<T>(action: string, input: object = {}): Promise<T> {
  if (!wx.cloud) throw new Error('图片导出需要连接云端后使用');
  const response = await wx.cloud.callFunction({ name: 'storyBooks', data: { ...input, action } });
  const result = response.result as { error?: string; message?: string; code?: string } | undefined;
  if (!result || result.error) throw Object.assign(new Error(result?.message || '暂时无法确认导出权限，请重试'), { code: result?.code });
  return result as T;
}
export function bookExportSelection(snapshot: SendSnapshot, selection: SendSelection): BookExportSelection {
  const base = { storyId: snapshot.storyId, revisionId: snapshot.revisionId, expectedVersion: snapshot.version,
    scope: selection.scope, chapterIds: selection.scope === 'chapters' ? [...selection.chapterIds] : [] };
  if (selection.scope !== 'text') return base;
  const chapter = snapshot.chapters.find(c => c.id === selection.textChapterId);
  const start = chapter?.text.indexOf(selection.text) ?? -1;
  if (!selection.text.trim() || start < 0) throw new Error('请重新选择原文中的文字');
  return { ...base, excerpt: { chapterId: selection.textChapterId, start, end: start + selection.text.length } };
}
export const bookExportApi = {
  available: async () => (await call<{ bookExport?: boolean }>('capabilities')).bookExport === true,
  preview: (selection: BookExportSelection) => call<{ descriptor: BookExportDescriptor }>('bookExportPreview', selection),
  material: (selection: BookExportSelection, descriptorId: string) => call<BookExportMaterial>('bookExportImages', { ...selection, descriptorId }),
};
