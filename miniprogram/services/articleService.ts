import type { ArticleChapter } from './articleModules';
export interface ArticleSaveRequest { requestId: string; storyId: string; revisionId: string; expectedVersion: number; chapter: ArticleChapter; sourceMemoryIds?: string[] }
// These replies confirm that this attempt was not accepted. Network/unknown
// failures must keep the original payload and request id for receipt recovery.
export function isArticleRejected(error: unknown): boolean {
  return ['CONTENT_REJECTED', 'MODERATION_REVIEW'].includes((error as { code?: string })?.code || '');
}
export async function saveArticle(request: ArticleSaveRequest): Promise<{ revisionId: string; version: number }> {
  if (!wx.cloud) throw new Error('请连接网络后重试');
  // Omitted on pre-upgrade pending requests: preserve their exact wire payload for safe retries.
  const { sourceMemoryIds, ...data } = request;
  const { chapter } = request;
  const response = await wx.cloud.callFunction({ name: 'storyBooks', data: { ...data, action: 'articleSave', chapter: {
    ...(chapter.backdropImageId !== undefined ? {backdropImageId:chapter.backdropImageId} : {}),
    id: chapter.id, title: chapter.title, ...(sourceMemoryIds ? {memoryIds:[...new Set(sourceMemoryIds)]} : {}), content: chapter.content.map(block => ({ blockId: block.blockId,
      ...(block.parentBlockId ? { parentBlockId: block.parentBlockId } : {}),
      ...(typeof block.text === 'string' ? { text: block.text } : { photoId: block.photoId }),
    })), layout: chapter.layout, packageAssets: chapter.packageAssets || {},
  } } });
  const result = response.result as { revisionId: string; version: number; error?: string; code?: string; message?: string };
  if (!result || result.error || !result.revisionId || !Number.isSafeInteger(result.version)) throw Object.assign(new Error(result?.message || '保存失败，修改已留在本机，请重试'), { code: result?.code || result?.error });
  return result;
}
