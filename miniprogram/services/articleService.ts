import type { ArticleChapter } from './articleModules';
export interface ArticleSaveRequest { requestId: string; storyId: string; revisionId: string; expectedVersion: number; chapter: ArticleChapter }
export async function saveArticle(request: ArticleSaveRequest): Promise<{ revisionId: string; version: number }> {
  if (!wx.cloud) throw new Error('请连接网络后重试');
  const { chapter } = request;
  const response = await wx.cloud.callFunction({ name: 'storyBooks', data: { ...request, action: 'articleSave', chapter: {
    id: chapter.id, title: chapter.title, content: chapter.content.map(block => ({ blockId: block.blockId,
      ...(block.parentBlockId ? { parentBlockId: block.parentBlockId } : {}),
      ...(typeof block.text === 'string' ? { text: block.text } : { photoId: block.photoId }),
    })), layout: chapter.layout, packageAssets: chapter.packageAssets || {},
  } } });
  const result = response.result as { revisionId: string; version: number; error?: string; message?: string };
  if (!result || result.error || !result.revisionId) throw new Error(result?.message || '保存失败，修改已留在本机，请重试');
  return result;
}
