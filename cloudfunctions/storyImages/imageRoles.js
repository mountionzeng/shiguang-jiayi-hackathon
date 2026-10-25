const crypto = require('crypto');
const core = require('./core');
const fail = (message = '这张图尚未审核通过、已删除或没有使用权限') => { throw new core.StoryImageError('IMAGE_NOT_READY', message); };

// Role selections preserve the original. Deterministic, server-owned copies keep
// the existing manuscript/export asset contract and make retries cost-free.
async function prepareImageRole(repo, storage, ctx, input) {
  core.requireOwner(ctx.openid, input.familyId);
  const storyId = core.normalizeStoryInput(input);
  const purpose = input.purpose;
  if (!['cover', 'backdrop', 'illustration'].includes(purpose)) fail('请选择封面、底图或插图');
  const chapterId = purpose === 'cover' ? core.COVER_CHAPTER_ID : input.chapterId;
  const sourceId = String(input.imageId || '');
  const read = async () => {
    const current = await repo.getActiveStoryDraft(input.familyId, storyId);
    if (!current || (purpose !== 'cover' && !current.draft.chapters?.some(c => c.id === chapterId))) fail('这一章已变化，请重新打开');
    let source;
    if (sourceId.startsWith(input.familyId + '_img_req-')) {
      const image = await repo.getImage(sourceId);
      if (!image || image.familyId !== input.familyId || image.deletedAtMs !== undefined || image.moderation !== 'pass' ||
          image.sourcePolicyRequired || image.sourceIds !== undefined || !image.fileID?.startsWith('cloud://')) fail();
      source = {fileID:image.fileID, bytes:image.bytes, aiGenerated:image.aiGenerated !== false,
        sourceText:image.sourceText || '', sourceKind:image.sourceKind || '', quality:image.quality || 'unchecked',
        qualityIssues:image.qualityIssues || [], originImageId:image.originImageId || sourceId};
      if (image.storyId === storyId && image.chapterId === chapterId && image.purpose === purpose) source.existingId = sourceId;
    } else if (/^photo-(?!ai-)[a-z0-9-]{1,80}$/.test(sourceId)) {
      const photo = await repo.getPhoto(input.familyId, sourceId);
      const present = current.draft.chapters?.some(c => c.content?.some(b => b.photoId === sourceId) || Object.values(c.packageAssets || {}).some(a => a.photoId === sourceId));
      if (!present || !photo || photo.familyId !== input.familyId || photo._openid !== ctx.openid || photo.deletedAt ||
          photo.sourcePolicyRequired || photo.sourceIds !== undefined || photo.moderation?.ok !== true || photo.moderation?.suggest !== 'pass' ||
          !photo.displayFileID?.startsWith('cloud://') || !photo.displayFileID.endsWith(`/user-photos/${input.familyId}/${sourceId}/display.jpg`)) fail();
      source = {fileID:photo.displayFileID, bytes:photo.displayBytes || 0, aiGenerated:false, sourceText:'', sourceKind:'upload',
        quality:'unchecked', qualityIssues:[], originImageId:sourceId};
    } else fail();
    if (purpose === 'cover' && ['pending','flawed'].includes(source.quality)) fail('这张图还在质检或有画面瑕疵，请先选另一张');
    return source;
  };
  const source = await read();
  if (source.existingId) return {imageId:source.existingId};
  const requestId = 'req-role-' + crypto.createHash('sha256').update(JSON.stringify([input.familyId,storyId,chapterId,purpose,sourceId,source.fileID])).digest('hex').slice(0,32);
  const imageId = `${input.familyId}_img_${requestId}`;
  const previous = await repo.getImage(imageId);
  if (previous && previous.deletedAtMs === undefined && previous.moderation === 'pass') return {imageId};
  const extension = /\.(png|jpg|jpeg|webp)$/.exec(source.fileID)?.[1];
  if (!extension) fail();
  const fileID = await storage.copy(source.fileID, `story-images/${input.familyId}/${storyId}/${requestId}.${extension}`);
  const after = await read();
  if (JSON.stringify(source) !== JSON.stringify(after)) fail('图片状态有变化，请重新选择');
  await repo.createImage(imageId, {familyId:input.familyId, storyId, chapterId, purpose, requestId, fileID,
    bytes:source.bytes || 0, moderation:'pass', quality:source.quality, qualityIssues:source.qualityIssues,
    aiGenerated:source.aiGenerated, sourceText:source.sourceText, sourceKind:source.sourceKind,
    originImageId:source.originImageId, createdAtMs:Date.now()});
  return {imageId};
}
module.exports = {prepareImageRole};
