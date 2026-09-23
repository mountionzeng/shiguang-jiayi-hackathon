const core = require('./core');

/** Cover assets are resolved on the server; clients never submit arbitrary image URLs. */
function createCoverServices({ repo, storage, readPhotos }) {
  async function context(familyId, storyId) {
    const current = await repo.getActiveStoryDraft(familyId, storyId);
    if (!current) throw new core.StoryImageError('STORY_NOT_FOUND', '这本书还没有已保存的书稿');
    core.assertUnrestrictedStory(current.story, current.draft);
    return current;
  }
  async function allowedPhotos(familyId, storyId, current) {
    return repo.listStoryPhotoIds(familyId, storyId, current);
  }
  async function sources(ctx, event) {
    core.requireOwner(ctx.openid, event.familyId);
    const storyId = core.normalizeStoryInput(event);
    const current = await context(event.familyId, storyId);
    const source = core.bookSource(current.draft);
    const photoIds = await allowedPhotos(event.familyId, storyId, current);
    const photos = [];
    for (let i = 0; i < photoIds.length; i += 9) {
      const batch = await readPhotos({ familyId: event.familyId, photoIds: photoIds.slice(i, i + 9),
        variant: 'small', purpose: 'view', onBehalfOfOpenid: ctx.openid });
      photos.push(...batch.filter(photo => photo.status === 'ok' && photo.url).map(photo => ({ photoId: photo.photoId, url: photo.url })));
    }
    return { storyId, title: current.draft.title || current.story.bookTitle || current.story.title,
      revisionId: current.revision.id, version: current.story.version, coverImageId: current.story.coverImageId || '',
      chapterCount: source.chapterCount, textLength: source.textLength, photos };
  }
  async function prepare(ctx, input, current) {
    const imageIds = input.referenceImageIds || [], photoIds = input.referencePhotoIds || [];
    const urls = [];
    for (const id of imageIds) {
      const image = await repo.getImage(id);
      const linked = image && !image.storyId && await repo.isImageLinkedToStory(input.familyId, input.storyId, id);
      if (!image || image.familyId !== input.familyId || (image.storyId !== input.storyId && !linked) ||
        image.deletedAtMs !== undefined || !image.fileID || image.moderation !== 'pass') {
        throw new core.StoryImageError('REFERENCE_IMAGE_NOT_READY', '所选图片不属于本书、已删除或尚未通过审核，请重新选择');
      }
      const url = (await storage.tempUrls([image.fileID], 300))[image.fileID];
      if (!url) throw new core.StoryImageError('REFERENCE_IMAGE_NOT_FOUND', '暂时读不到参考图，请稍后再试');
      urls.push(url);
    }
    if (photoIds.length) {
      const allowed = new Set(await allowedPhotos(input.familyId, input.storyId, current));
      if (photoIds.some(id => !allowed.has(id))) throw new core.StoryImageError('REFERENCE_IMAGE_NOT_FOUND', '只能参考这本书里的照片');
      const photos = await readPhotos({ familyId: input.familyId, photoIds, variant: 'small',
        purpose: 'ai-reference', onBehalfOfOpenid: ctx.openid });
      if (photos.length !== photoIds.length || photos.some(photo => photo.status !== 'ok' || !photo.url)) {
        throw new core.StoryImageError('REFERENCE_IMAGE_NOT_READY', '所选照片尚未上传或暂时无法用于 AI，请重新选择');
      }
      urls.push(...photos.map(photo => photo.url));
    }
    return urls;
  }
  async function select(ctx, event) {
    core.requireOwner(ctx.openid, event.familyId);
    const storyId = core.normalizeStoryInput(event);
    const imageId = String(event.imageId || '');
    if (imageId && !imageId.startsWith(event.familyId + '_img_req-')) throw new core.StoryImageError('IMAGE_NOT_FOUND', '没找到这张封面');
    if (!Number.isInteger(event.expectedVersion)) throw new core.StoryImageError('REVISION_CHANGED', '请重新打开封面页面');
    return repo.setStoryCover({ familyId: event.familyId, storyId, imageId, expectedVersion: event.expectedVersion });
  }
  return { sources, prepare, select };
}
/** Called inside the same database transaction that reads the story and candidate. */
function coverSelectionPatch(story, image, {familyId, storyId, imageId, expectedVersion}, now = new Date().toISOString()) {
  if (!story || story.familyId !== familyId || story.deletedAt) throw new core.StoryImageError('STORY_NOT_FOUND', '这本书已不可用');
  core.assertUnrestrictedStory(story);
  if ((story.coverImageId || '') === imageId) return undefined;
  if (story.version !== expectedVersion) throw new core.StoryImageError('REVISION_CHANGED', '这本书刚有更新，请重新打开封面页再选用');
  if (imageId && (!image || image.familyId !== familyId || image.storyId !== storyId || image.purpose !== 'cover' ||
      image.deletedAtMs !== undefined || image.moderation !== 'pass')) {
    throw new core.StoryImageError('IMAGE_NOT_READY', '这张封面尚未通过审核或已不可用，请稍后再试');
  }
  return {coverImageId:imageId, imageIds:[...new Set([...(story.imageIds || []), ...(imageId ? [imageId] : [])])],
    version:story.version + 1, updatedAt:now};
}
module.exports = { createCoverServices, coverSelectionPatch };
