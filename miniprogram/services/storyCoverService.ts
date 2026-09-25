import { callStoryImages, newImageRequestId, StoryImageJob, StoryImageServiceError, storyImageApi } from './storyImageService';

export interface CoverSources {
  storyId: string; title: string; revisionId: string; version: number; coverImageId: string;
  chapterCount: number; textLength: number; photos: Array<{photoId: string; url: string}>;
}
export interface CoverInput { storyId: string; referenceImageIds: string[]; referencePhotoIds: string[]; artDirection?: string; requestId?: string }
export interface ShareCoverCandidate { imageId: string; url: string; createdAtMs: number }
export interface ShareCoverCandidates { candidates: ShareCoverCandidate[]; pendingJobs: StoryImageJob[] }

async function submit(input: CoverInput): Promise<StoryImageJob> {
  const count = input.referenceImageIds.length + input.referencePhotoIds.length;
  if (count > 3) throw new Error('最多选 3 张参考图');
  if (input.artDirection?.trim()) {
    let capabilities: {guidedGeneration?: unknown};
    try {
      capabilities = await callStoryImages<{guidedGeneration?: unknown}>('capabilities', {});
    } catch (error) {
      if (error instanceof StoryImageServiceError && error.code === 'UNKNOWN_ACTION') {
        throw new StoryImageServiceError('GUIDED_GENERATION_UNAVAILABLE', '封面服务还没更新到画面想法功能，请稍后再试');
      }
      throw error;
    }
    if (capabilities.guidedGeneration !== true) throw new StoryImageServiceError('GUIDED_GENERATION_UNAVAILABLE', '封面服务还没更新到画面想法功能，请稍后再试');
  }
  const allowed = await new Promise<boolean>(resolve => wx.showModal({
    title: '生成这本书的封面？',
    content: `会把整本书已保存的正文${count ? `和你选中的 ${count} 张参考图片` : ''}${input.artDirection?.trim() ? '，以及你写的美术想法' : ''}发送给腾讯云 TokenHub 上的 AI 服务，提炼全书主题${count ? '、画风与配色' : ''}后生成封面。照片只发送压缩小图，不识别人脸身份。会消耗一次配图额度，服务商日志留存政策仍适用。生成后由你决定是否使用。`,
    confirmText: '生成封面', cancelText: '先等等',
    success: result => resolve(result.confirm), fail: () => resolve(false),
  }));
  if (!allowed) throw new StoryImageServiceError('CONSENT_DECLINED', '本次没有生成封面');
  const result = await callStoryImages<{job: StoryImageJob}>('submit', {
    ...input, purpose: 'cover', coverConsent: true, requestId: input.requestId ?? newImageRequestId(),
  });
  const job = result.job;
  if (!job || job.purpose !== 'cover' || !job.jobId || !job.status) throw new Error('封面服务返回内容不完整');
  if (input.artDirection?.trim() && job.ideaApplied !== true) throw new StoryImageServiceError('GUIDED_GENERATION_UNAVAILABLE', '封面服务没有使用你的画面想法，请稍后再试');
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
async function listShareCoverCandidates(storyId: string): Promise<ShareCoverCandidates> {
  const list = await storyImageApi.listStoryImages(storyId);
  return {
    candidates: list.images
      .filter(image => image.purpose === 'cover' && image.moderation === 'pass' && Boolean(image.url))
      .map(image => ({ imageId: image.imageId, url: image.url, createdAtMs: image.createdAtMs })),
    pendingJobs: list.pending.filter(job => job.purpose === 'cover'),
  };
}
async function checkShareCoverJob(storyId: string, jobId: string): Promise<StoryImageJob> {
  const result = await storyImageApi.checkImageJob(jobId, storyId);
  if (!result.job || result.job.purpose !== 'cover') {
    throw new StoryImageServiceError('JOB_NOT_FOUND', '没找到这次封面生成');
  }
  if (result.image && result.image.purpose !== 'cover') {
    throw new StoryImageServiceError('JOB_NOT_FOUND', '没找到这次封面生成');
  }
  return result.job;
}
export const storyCoverApi = {submit, sources, select, resolveUrl, listShareCoverCandidates, checkShareCoverJob};
