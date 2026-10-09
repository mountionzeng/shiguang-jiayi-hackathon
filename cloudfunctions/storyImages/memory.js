const core = require('./core');

function memoryId(value) {
  if (typeof value !== 'string' || !/^[0-9A-Za-z_-]{1,160}$/.test(value))
    throw new core.StoryImageError('INVALID_MEMORY', '请先保存这段记忆再配图');
  return value;
}

function memorySource(memory, ownerMemberId, familyId, id) {
  memoryId(id);
  if (!memory || memory.familyId !== familyId || memory.deletedAt || memory.scope !== 'personal' ||
      memory.reviewStatus !== 'confirmed' || !ownerMemberId || memory.authorMemberId !== ownerMemberId ||
      memory.sourcePolicyRequired || memory.sourceIds || memory.sourceSystem)
    throw new core.StoryImageError('MEMORY_NOT_FOUND', '这段记忆已不可用于配图，请重新打开');
  if (typeof memory.text !== 'string' || !memory.text.trim() || memory.text.length > 500)
    throw new core.StoryImageError('MEMORY_EMPTY', '先保存几句回忆，再请小忆配图');
  // Reuse chapter composition without inventing a story or copying business records.
  const source = core.chapterSource({ chapters: [{ id: 'memory', title: memory.title || '',
    content: [{ text: memory.text }], }] }, 'memory');
  source.photoIds = (Array.isArray(memory.photoIds) ? memory.photoIds : []).filter(id => /^photo-(?!ai-)[a-z0-9-]{1,80}$/.test(id));
  source.photoHash = core.textHash(source.photoIds.join('\n'));
  source.scope = 'memory';
  source.fullTextHash = core.textHash(JSON.stringify([memory.title || '', memory.text]));
  return source;
}

function assertMemoryImage(image, familyId, id) {
  if (!image || image.familyId !== familyId || image.memoryId !== id || image.storyId ||
      image.purpose !== 'illustration' || image.sourcePolicyRequired || image.sourceIds !== undefined || image.deletedAtMs !== undefined || image.moderation !== 'pass' ||
      typeof image.fileID !== 'string' || !image.fileID.startsWith('cloud://') ||
      !/^req-[0-9a-z-]{8,60}$/.test(image.requestId || '') || image._id !== `${familyId}_img_${image.requestId}` ||
      !['png','jpg','jpeg','webp'].some(ext => image.fileID.endsWith(`/story-images/${familyId}/memory-${id}/${image.requestId}.${ext}`)))
    throw new core.StoryImageError('IMAGE_NOT_READY', '这张图尚未通过审核或已不可用，请稍后再试');
}
module.exports = { memoryId, memorySource, assertMemoryImage };
