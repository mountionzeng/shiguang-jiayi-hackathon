const crypto = require('node:crypto');
const core = require('./core');
const { assertCurrentIdentity, identityError, FAMILY_ID } = require('./identity');
const { evaluateStoryAccess, grantIdFor } = require('./access');
const { materializeOwnedDraft, applyBlockEdits, allowsSources } = require('./provenance');
const { copiedPath } = require('./copyAssets');

const STORY = /^story-[a-z0-9-]{1,100}$/;
const REVISION = /^revision-[a-zA-Z0-9-]{1,120}$/;
const CHAPTER = /^chapter-[a-z0-9-]{1,60}$/;
const BLOCK = /^block-[a-f0-9]{64}$/;
const PHOTO = /^photo-[a-z0-9-]{1,80}$/;
const digest = value => crypto.createHash('sha256').update(core.stable(value)).digest('hex');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const deny = () => fail('STORY_FORBIDDEN', '这段内容没有公开发布权限');

function normalizeRef(input) {
  if (!exact(input, ['familyId', 'storyId']) || !FAMILY_ID.test(input.familyId || '') || !STORY.test(input.storyId || '')) throw identityError();
  return input;
}

function normalizeSelection(input, withDescriptor = false) {
  const fields = ['familyId', 'storyId', 'revisionId', 'chapterId', 'blockIds', 'photoIds', ...(withDescriptor ? ['descriptorId'] : [])];
  if (!exact(input, fields) || !FAMILY_ID.test(input.familyId || '') || !STORY.test(input.storyId || '') || !REVISION.test(input.revisionId || '') ||
    !CHAPTER.test(input.chapterId || '') || !Array.isArray(input.blockIds) || !input.blockIds.length || input.blockIds.length > 12 ||
    new Set(input.blockIds).size !== input.blockIds.length || input.blockIds.some(id => typeof id !== 'string' || !BLOCK.test(id)) ||
    !Array.isArray(input.photoIds) || input.photoIds.length > 4 || new Set(input.photoIds).size !== input.photoIds.length ||
    input.photoIds.some(id => typeof id !== 'string' || !PHOTO.test(id)) ||
    (withDescriptor && (typeof input.descriptorId !== 'string' || !/^card-[a-f0-9]{64}$/.test(input.descriptorId)))) {
    fail('INVALID_INPUT', '请选择 1 至 12 段文字和最多 4 张图片');
  }
  return input;
}

async function loadStory(tx, ctx, ref) {
  // Only an in-process trusted service adapter may supply this verifier.
  // The public dispatcher always resolves ctx from WeChat, never event data.
  if (typeof ctx?.verifyIdentity === 'function') await ctx.verifyIdentity(tx);
  else await assertCurrentIdentity(tx, ctx);
  const family = await tx.get('families', ref.familyId), space = await tx.get('story_principal_spaces', ref.familyId);
  if (family?.storyBooks?.status !== 'active' || space?.status !== 'active' || family.ownerAccountId !== space.accountId) throw identityError();
  const story = await tx.get('stories', `${ref.familyId}_${ref.storyId}`);
  if (!story || story.familyId !== ref.familyId || story.id !== ref.storyId || story.deletedAt || !REVISION.test(story.currentRevisionId || '')) throw identityError();
  const grant = await tx.get('story_grants', grantIdFor(ref.familyId, ref.storyId, ctx.principalId));
  const preliminaryChapterIds = ref.chapterId ? [ref.chapterId] : (grant?.scope?.type === 'chapters' ? grant.scope.chapterIds : ['chapter-check']);
  if (!evaluateStoryAccess({ principalId: ctx.principalId, ownerPrincipalId: space.principalId, story, grant, action: 'read', chapterIds: preliminaryChapterIds })) throw identityError();
  if (ref.revisionId !== undefined && story.currentRevisionId !== ref.revisionId) fail('VERSION_CONFLICT', '故事已有更新，请重新选择卡片内容');
  const record = await tx.get('biography_drafts', `${ref.familyId}_${story.currentRevisionId}`);
  const revision = record?.revision;
  if (record?.familyId !== ref.familyId || record.storyId !== story.id || revision?.id !== story.currentRevisionId || revision.storyId !== story.id || !Array.isArray(revision.draft?.chapters)) throw identityError();
  let draft = revision.draft;
  if (draft.provenanceVersion === undefined) {
    if (story.sourcePolicyRequired) deny();
    draft = materializeOwnedDraft(draft, { familyId: ref.familyId, storyId: story.id, revisionId: revision.id });
  } else {
    draft = applyBlockEdits(draft, [], { familyId: ref.familyId, storyId: story.id, requestId: 'share-card-validate' });
  }
  return { family, space, story, grant, revision, draft };
}

function canPublishStory(ctx, loaded, chapterId) {
  const { space, story, grant } = loaded;
  if (ctx.principalId === space.principalId) return true;
  // Provenance is checked block-by-block below. Removing this coarse flag only
  // for the grant check lets a copy owner publish their own appended blocks.
  return evaluateStoryAccess({ principalId: ctx.principalId, ownerPrincipalId: space.principalId,
    story: { ...story, sourcePolicyRequired: false }, grant, action: 'publish', chapterIds: [chapterId] });
}

async function blockPublishable(tx, block) {
  return Array.isArray(block.sourceIds) && await allowsSources(tx, block.sourceIds, 'view') && await allowsSources(tx, block.sourceIds, 'publish') && await allowsSources(tx, block.sourceIds, 'export');
}

async function listShareCardSource(repo, ctx, raw) {
  const ref = normalizeRef(raw);
  return repo.transaction(async tx => {
    const loaded = await loadStory(tx, ctx, ref);
    const chapters = [];
    for (const chapter of loaded.draft.chapters) {
      if (!evaluateStoryAccess({ principalId: ctx.principalId, ownerPrincipalId: loaded.space.principalId, story: loaded.story,
        grant: loaded.grant, action: 'read', chapterIds: [chapter.id] })) continue;
      const storyPublishable = canPublishStory(ctx, loaded, chapter.id);
      const blocks = [];
      for (const block of chapter.content) {
        if (!Array.isArray(block.sourceIds) || !await allowsSources(tx, block.sourceIds, 'view')) continue;
        const publishable = storyPublishable && await blockPublishable(tx, block);
        if (typeof block.text === 'string' && block.photoId === undefined) blocks.push({ blockId: block.blockId, kind: 'text', preview: block.text.slice(0, 180), characterCount: block.text.length, publishable });
        else if (block.photoId) blocks.push({ blockId: block.blockId, kind: 'photo', photoId: block.photoId, publishable });
      }
      chapters.push({ id: chapter.id, title: String(chapter.title || '').slice(0, 40), blocks });
    }
    if (!chapters.length) deny();
    return { story: { id: loaded.story.id, title: String(loaded.story.bookTitle || loaded.story.title || '我的故事').slice(0, 40), version: loaded.story.version }, revisionId: loaded.revision.id, chapters };
  });
}

async function buildDescriptor(repo, ctx, raw) {
  const input = normalizeSelection(raw);
  return repo.transaction(async tx => {
    const loaded = await loadStory(tx, ctx, input);
    const chapter = loaded.draft.chapters.find(item => item.id === input.chapterId);
    if (!chapter || !evaluateStoryAccess({ principalId: ctx.principalId, ownerPrincipalId: loaded.space.principalId, story: loaded.story,
      grant: loaded.grant, action: 'read', chapterIds: [chapter.id] }) || !canPublishStory(ctx, loaded, chapter.id)) deny();
    const selected = input.blockIds.map(id => chapter.content.find(block => block.blockId === id));
    if (selected.some(block => !block)) fail('STORY_SHARE_SELECTION_INVALID', '所选内容已经变化，请重新选择');
    const selectedPhotos = selected.filter(block => block.photoId).map(block => block.photoId);
    if (selectedPhotos.length !== input.photoIds.length || selectedPhotos.some(id => !input.photoIds.includes(id))) fail('STORY_SHARE_SELECTION_INVALID', '图片必须来自当前选中的内容');
    for (const block of selected) if (!await blockPublishable(tx, block)) deny();
    const paragraphs = selected.flatMap(block => typeof block.text === 'string' && block.photoId === undefined ? [block.text.trim()] : []).filter(Boolean);
    const characterCount = paragraphs.reduce((sum, text) => sum + text.length, 0);
    const photos = selected.flatMap(block => block.photoId ? [{ photoId: block.photoId, blockId: block.blockId }] : []);
    if (!paragraphs.length || characterCount > 1200 || characterCount + photos.length * 100 > 1200) fail('STORY_SHARE_LIMIT', '卡片内容过长，请减少文字或照片');
    const base = { version: 1, storyId: loaded.story.id, revisionId: loaded.revision.id, storyVersion: loaded.story.version,
      chapterId: chapter.id, title: String(loaded.story.bookTitle || loaded.story.title || '我的故事').slice(0, 40),
      chapterTitle: String(chapter.title || '').slice(0, 40), byline: '拾光家忆 · 故事摘录', paragraphs, photos };
    return { descriptor: { id: 'card-' + digest(base), ...base }, loaded, selected };
  });
}

async function previewShareCard(repo, ctx, input, { approve } = {}) {
  const first = await buildDescriptor(repo, ctx, input);
  if (typeof approve !== 'function' || await approve([first.descriptor.title, first.descriptor.chapterTitle, ...first.descriptor.paragraphs].join('\n'),ctx.verifiedOpenid) !== true) {
    fail('CONTENT_REJECTED', '卡片内容没有通过内容安全检查，请修改后重试');
  }
  const second = await buildDescriptor(repo, ctx, input);
  if (first.descriptor.id !== second.descriptor.id) fail('VERSION_CONFLICT', '故事已有更新，请重新预览');
  return { descriptor: second.descriptor };
}

async function resolvePhoto(tx, loaded, photoId) {
  if (photoId.startsWith('photo-copy-')) {
    const asset = await tx.get('story_copy_assets', `${loaded.story.familyId}__${photoId}`);
    if (!asset || asset.familyId !== loaded.story.familyId || asset.storyId !== loaded.story.id || asset.photoId !== photoId || asset.status !== 'active' ||
      asset.sourcePolicyRequired !== true || !Array.isArray(asset.sourceIds) || !asset.sourceIds.length ||
      !await allowsSources(tx, asset.sourceIds, 'publish') || !await allowsSources(tx, asset.sourceIds, 'export') ||
      !copiedPath.test(asset.fileID || '') || !asset.fileID.includes(`/copies/${asset.operationId}/`)) deny();
    return asset.fileID;
  }
  const photo = await tx.get('photos', `${loaded.story.familyId}__${photoId}`);
  if (!photo || photo.familyId !== loaded.story.familyId || photo.photoId !== photoId || !loaded.family._openid || photo._openid !== loaded.family._openid ||
    photo.deletedAt || photo.sourcePolicyRequired || photo.sourceIds !== undefined || photo.moderation?.ok !== true || photo.moderation.suggest !== 'pass' ||
    typeof photo.displayFileID !== 'string' || !photo.displayFileID.startsWith('cloud://') || !photo.displayFileID.endsWith(`/user-photos/${loaded.story.familyId}/${photoId}/display.jpg`)) deny();
  return photo.displayFileID;
}

async function exportShareCard(repo, ctx, raw, { approve, sign } = {}) {
  const input = normalizeSelection(raw, true);
  if (typeof sign !== 'function') deny();
  const selection = { familyId: input.familyId, storyId: input.storyId, revisionId: input.revisionId, chapterId: input.chapterId, blockIds: input.blockIds, photoIds: input.photoIds };
  const preview = await previewShareCard(repo, ctx, selection, { approve });
  if (preview.descriptor.id !== input.descriptorId) fail('VERSION_CONFLICT', '预览已经失效，请重新生成');
  const before = await buildDescriptor(repo, ctx, selection);
  const files = await repo.transaction(async tx => {
    const loaded = await loadStory(tx, ctx, selection);
    const rows = [];
    for (const photoId of input.photoIds) rows.push({ photoId, fileID: await resolvePhoto(tx, loaded, photoId) });
    return rows;
  });
  const media = [];
  for (const file of files) {
    const url = await sign(file.fileID, 300);
    let parsed;
    try { parsed = new URL(url); } catch { deny(); }
    if (typeof url !== 'string' || url.length > 4096 || parsed.protocol !== 'https:' || parsed.username || parsed.password) deny();
    media.push({ photoId: file.photoId, url, requestedMaxAgeSeconds: 300 });
  }
  const checkedFiles = await repo.transaction(async tx => {
    const loaded = await loadStory(tx, ctx, selection), rows = [];
    for (const photoId of input.photoIds) rows.push({ photoId, fileID: await resolvePhoto(tx, loaded, photoId) });
    return rows;
  });
  if (core.stable(files) !== core.stable(checkedFiles)) deny();
  const after = await buildDescriptor(repo, ctx, selection);
  if (before.descriptor.id !== after.descriptor.id || after.descriptor.id !== input.descriptorId) fail('VERSION_CONFLICT', '故事或权限已有变化，请重新生成');
  return { descriptor: after.descriptor, media };
}

module.exports = { listShareCardSource, previewShareCard, exportShareCard, normalizeShareCardSelection: normalizeSelection };
