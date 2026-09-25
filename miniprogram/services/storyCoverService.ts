import { callStoryImages, newImageRequestId, StoryImageJob, StoryImageServiceError, storyImageApi } from './storyImageService';

export interface CoverSources {
  storyId: string; title: string; revisionId: string; version: number; coverImageId: string;
  chapterCount: number; textLength: number; photos: Array<{photoId: string; url: string}>;
}
export interface CoverInput { storyId: string; referenceImageIds: string[]; referencePhotoIds: string[]; artDirection?: string }

async function submit(input: CoverInput): Promise<StoryImageJob> {
  const count = input.referenceImageIds.length + input.referencePhotoIds.length;
  if (count > 3) throw new Error('最多选 3 张参考图');
  const allowed = await new Promise<boolean>(resolve => wx.showModal({
    title: '生成这本书的封面？',
    content: `会把整本书已保存的正文${count ? `和你选中的 ${count} 张参考图片` : ''}${input.artDirection?.trim() ? '，以及你写的美术想法' : ''}发送给腾讯云 TokenHub 上的 AI 服务，提炼全书主题${count ? '、画风与配色' : ''}后生成封面。照片只发送压缩小图，不识别人脸身份。会消耗一次配图额度，服务商日志留存政策仍适用。生成后由你决定是否使用。`,
    confirmText: '生成封面', cancelText: '先等等',
    success: result => resolve(result.confirm), fail: () => resolve(false),
  }));
  if (!allowed) throw new StoryImageServiceError('CONSENT_DECLINED', '本次没有生成封面');
  const result = await callStoryImages<{job: StoryImageJob}>('submit', {
    ...input, purpose: 'cover', coverConsent: true, requestId: newImageRequestId(),
  });
  const job = result.job;
  if (!job || job.purpose !== 'cover' || !job.jobId || !job.status) throw new Error('封面服务返回内容不完整');
  return job;
}
async function sources(storyId: string) {
  return callStoryImages<CoverSources>('coverSources', {storyId});
}
async function select(storyId: string, imageId: string, expectedVersion: number) {
  return callStoryImages<{ok: boolean}>('selectCover', {storyId, imageId, expectedVersion});
}
async function resolveUrl(storyId: string, imageId?: string): Promise<string> {
  if (!storyId || !imageId) return '';
  const list = await storyImageApi.listStoryImages(storyId);
  return list.images.find(image => image.imageId === imageId && image.purpose === 'cover' && image.moderation === 'pass')?.url || '';
}
export const storyCoverApi = {submit, sources, select, resolveUrl};
