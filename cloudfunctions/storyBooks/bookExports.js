const crypto = require('node:crypto');
const core = require('./core');
const { FAMILY_ID } = require('./identity');
const { loadAuthorizedExportStory, blockPublishable } = require('./exports');
const { memoryExportSource } = require('./memoryExports');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const deny = () => fail('STORY_FORBIDDEN', '这份书稿或封面暂时不能导出');

function normalize(input, exporting = false) {
  if (input?.sourceKind === 'memory') return normalizeMemory(input, exporting);
  const fields = ['familyId','storyId','revisionId','expectedVersion','scope','chapterIds','excerpt','sourceKind','coverImageIds','targetTextImageCount', ...(exporting ? ['descriptorId'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key)) ||
    (input.sourceKind !== undefined && input.sourceKind !== 'story') ||
    !FAMILY_ID.test(input.familyId || '') || !/^story-[a-z0-9-]{1,100}$/.test(input.storyId || '') ||
    !/^revision-[a-zA-Z0-9-]{1,120}$/.test(input.revisionId || '') || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
    !['book','chapters','text'].includes(input.scope) || !Array.isArray(input.chapterIds) || input.chapterIds.length > 30 ||
    new Set(input.chapterIds).size !== input.chapterIds.length || input.chapterIds.some(id => typeof id !== 'string' || !/^chapter-[a-z0-9-]{1,60}$/.test(id))) {
    fail('INVALID_INPUT', '请重新选择要分享的内容');
  }
  if (input.coverImageIds !== undefined && (!Array.isArray(input.coverImageIds) || input.coverImageIds.length > 6 ||
    new Set(input.coverImageIds).size !== input.coverImageIds.length ||
    input.coverImageIds.some(id => typeof id !== 'string' || !/^[0-9A-Za-z_-]{1,200}$/.test(id)))) {
    fail('INVALID_INPUT', '分享封面选择无效');
  }
  if (input.targetTextImageCount !== undefined &&
    (!Number.isSafeInteger(input.targetTextImageCount) || input.targetTextImageCount < 1 || input.targetTextImageCount > 30)) {
    fail('INVALID_INPUT', '正文图片数量无效');
  }
  if (input.scope === 'chapters' && !input.chapterIds.length || input.scope !== 'chapters' && input.chapterIds.length) fail('INVALID_INPUT', '章节范围无效');
  const e = input.excerpt;
  if (input.scope === 'text') {
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some(k => !['chapterId','start','end'].includes(k)) ||
      !/^chapter-[a-z0-9-]{1,60}$/.test(e.chapterId || '') || !Number.isSafeInteger(e.start) || !Number.isSafeInteger(e.end) || e.start < 0 || e.end <= e.start || e.end > 40000) fail('INVALID_INPUT', '文字选区无效');
  } else if (e !== undefined) fail('INVALID_INPUT', '分享范围与选区不一致');
  if (exporting && !/^book-[a-f0-9]{64}$/.test(input.descriptorId || '')) fail('INVALID_INPUT', '请先生成图片预览');
  return input;
}

function normalizeMemory(input, exporting = false) {
  const fields = ['familyId','sourceKind','memoryId','revisionId','expectedSourceVersion','targetTextImageCount', ...(exporting ? ['descriptorId'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key)) ||
    !FAMILY_ID.test(input.familyId || '') || typeof input.memoryId !== 'string' || !/^[0-9A-Za-z_-]{1,160}$/.test(input.memoryId) ||
    (input.revisionId !== undefined && (typeof input.revisionId !== 'string' || !/^[0-9A-Za-z_-]{1,160}$/.test(input.revisionId))) ||
    typeof input.expectedSourceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedSourceVersion)) {
    fail('INVALID_INPUT', '请重新选择要分享的记忆');
  }
  if (input.targetTextImageCount !== undefined &&
    (!Number.isSafeInteger(input.targetTextImageCount) || input.targetTextImageCount < 1 || input.targetTextImageCount > 30)) {
    fail('INVALID_INPUT', '正文图片数量无效');
  }
  if (exporting && !/^book-[a-f0-9]{64}$/.test(input.descriptorId || '')) fail('INVALID_INPUT', '请先生成图片预览');
  return input;
}

async function build(repo, ctx, input) {
  if (input.sourceKind === 'memory') return buildMemory(repo, ctx, input);
  return repo.transaction(async tx => {
    const loaded = await loadAuthorizedExportStory(tx, ctx, input);
    const { story, space, draft } = loaded;
    // A reader/edit grant is never an owner export permission.
    if (ctx.principalId !== space.principalId || story.sourcePolicyRequired) deny();
    if (story.version !== input.expectedVersion) fail('VERSION_CONFLICT', '书稿已有更新，请重新选择');
    const wanted = input.scope === 'book' ? draft.chapters.map(c => c.id)
      : input.scope === 'text' ? [input.excerpt.chapterId] : input.chapterIds;
    if (wanted.some(id => !draft.chapters.some(c => c.id === id))) fail('INVALID_INPUT', '所选章节已不存在');
    const chapters = [];
    let containsAiText = false;
    for (const chapter of draft.chapters.filter(c => wanted.includes(c.id))) {
      // Conservative policy: every textual source in a selected chapter must allow export.
      for (const block of chapter.content.filter(b => typeof b.text === 'string')) if (!await blockPublishable(tx, block)) deny();
      let text = chapter.content.map(b => typeof b.text === 'string' ? b.text : '\n').join('');
      if (input.scope === 'text') {
        const { start, end } = input.excerpt;
        if (end > text.length || /[\uDC00-\uDFFF]/.test(text[start] || '') || /[\uDC00-\uDFFF]/.test(text[end] || '')) fail('INVALID_INPUT', '文字选区已变化');
        text = text.slice(start, end);
      }
      chapters.push({ id: chapter.id, title: chapter.title || '', text });
      containsAiText ||= chapter.containsAiText === true || chapter.generationMode === 'cloud-ai' || draft.generationMode === 'cloud-ai';
    }
    const length = chapters.reduce((sum, c) => sum + Array.from(c.text).length, 0);
    if (!chapters.some(c => c.text.trim()) || length > 40000) fail('STORY_SHARE_LIMIT', '所选文字为空或超出排版范围，请分批选择章节');
    const requestedCoverIds = input.coverImageIds?.length ? input.coverImageIds : (story.coverImageId ? [story.coverImageId] : []);
    const coverFileIDs = [];
    for (const imageId of requestedCoverIds) {
      const image = await tx.get('story_images', imageId);
      if (!image || image.familyId !== input.familyId || image.storyId !== story.id || image.purpose !== 'cover' ||
        image.deletedAtMs !== undefined || image.moderation !== 'pass' || image.sourcePolicyRequired || image.sourceIds?.length ||
        typeof image.fileID !== 'string' || !image.fileID.startsWith('cloud://') ||
        !image.fileID.includes(`/story-images/${input.familyId}/${story.id}/`) || !/\.(png|jpg|jpeg|webp)$/.test(image.fileID)) deny();
      coverFileIDs.push(image.fileID);
    }
    const descriptor = { storyId: story.id, revisionId: loaded.revision.id, storyVersion: story.version,
      title: draft.title || story.bookTitle || story.title, chapters, coverImageId: requestedCoverIds[0] || '',
      coverImageIds: requestedCoverIds, ...(input.targetTextImageCount ? { targetTextImageCount: input.targetTextImageCount } : {}),
      containsAiText };
    const id = 'book-' + crypto.createHash('sha256').update(core.stable({ ...descriptor, coverFileIDs })).digest('hex');
    return { descriptor: { id, ...descriptor }, coverFileID: coverFileIDs[0] || '', coverFileIDs };
  });
}

async function buildMemory(repo, ctx, input) {
  const result = await memoryExportSource(repo, ctx, {
    memoryId: input.memoryId,
    ...(input.revisionId !== undefined ? { revisionId: input.revisionId } : {}),
    expectedSourceVersion: input.expectedSourceVersion,
  });
  const source = result.source;
  if (!source.text.trim()) fail('STORY_SHARE_LIMIT', '所选记忆为空，请重新选择');
  const chapter = { id: `memory-${source.memoryId}`, title: source.title || '一段记忆', text: source.text };
  const descriptor = {
    sourceKind: 'memory', memoryId: source.memoryId, revisionId: source.revisionId, sourceVersion: source.sourceVersion,
    title: source.title || '一段记忆', chapters: [chapter], coverImageId: '', containsAiText: source.containsAiText === true,
    ...(input.targetTextImageCount ? { targetTextImageCount: input.targetTextImageCount } : {}),
  };
  const id = 'book-' + crypto.createHash('sha256').update(core.stable(descriptor)).digest('hex');
  return { descriptor: { id, ...descriptor }, coverFileID: '' };
}

async function previewBookExport(repo, ctx, raw, { approve } = {}) {
  const input = normalize(raw), first = await build(repo, ctx, input);
  const d = first.descriptor;
  if (typeof approve !== 'function' || await approve([d.title, ...d.chapters.flatMap(c => [c.title, c.text])].join('\n'), ctx.verifiedOpenid) !== true) {
    fail('CONTENT_REJECTED', '所选内容没有通过内容安全检查');
  }
  const checked = await build(repo, ctx, input);
  if (first.descriptor.id !== checked.descriptor.id) fail('VERSION_CONFLICT', '书稿已有更新，请重新预览');
  return { descriptor: checked.descriptor };
}

async function exportBookImages(repo, ctx, raw, { approve, sign } = {}) {
  const input = normalize(raw, true), { descriptorId, ...selection } = input;
  const preview = await previewBookExport(repo, ctx, selection, { approve });
  if (preview.descriptor.id !== descriptorId) fail('VERSION_CONFLICT', '图片预览已失效，请重新生成');
  const before = await build(repo, ctx, selection);
  const coverUrls = [];
  for (const coverFileID of before.coverFileIDs || (before.coverFileID ? [before.coverFileID] : [])) {
    if (typeof sign !== 'function') deny();
    const signed = await sign(coverFileID, 300);
    let parsed;
    try { parsed = new URL(signed); } catch { deny(); }
    if (typeof signed !== 'string' || signed.length > 4096 || parsed.protocol !== 'https:' || parsed.username || parsed.password) deny();
    coverUrls.push(signed);
  }
  const after = await build(repo, ctx, selection);
  if (after.descriptor.id !== descriptorId || core.stable(after.coverFileIDs || []) !== core.stable(before.coverFileIDs || [])) fail('VERSION_CONFLICT', '书稿、封面或权限已有变化，请重新生成');
  return { descriptor: after.descriptor, coverUrl: coverUrls[0] || '', coverUrls };
}
module.exports = { previewBookExport, exportBookImages };
