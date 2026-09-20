const crypto = require('node:crypto');
const core = require('./core');
const { assertCurrentIdentity, identityError, FAMILY_ID } = require('./identity');
const { evaluateStoryAccess, grantIdFor } = require('./access');

const STORY_ID = /^story-[a-z0-9-]{1,100}$/;
const CHAPTER_ID = /^chapter-[a-z0-9-]{1,60}$/;
const REVISION_ID = /^revision-[a-zA-Z0-9-]{1,120}$/;
const REQUEST_ID = /^[a-zA-Z0-9-]{8,100}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function normalize(input) {
  if (!input || !FAMILY_ID.test(input.familyId || '') || !STORY_ID.test(input.storyId || '') ||
      !CHAPTER_ID.test(input.chapterId || '') || !REVISION_ID.test(input.revisionId || '') ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || !REQUEST_ID.test(input.requestId || '') ||
      typeof input.title !== 'string' || input.title.length > 40 || !Array.isArray(input.textBlocks) ||
      input.textBlocks.length > 200) fail('INVALID_INPUT', '编辑内容无效，请重新打开章节');
  const seen = new Set(); let length = input.title.length;
  const textBlocks = input.textBlocks.map(block => {
    if (!block || !Number.isSafeInteger(block.index) || block.index < 0 || seen.has(block.index) ||
        typeof block.text !== 'string') fail('INVALID_INPUT', '正文分段无效，请重新打开章节');
    seen.add(block.index); length += block.text.length;
    return { index: block.index, text: block.text };
  });
  if (length > 20000) fail('INVALID_INPUT', '书稿最多 20000 字');
  return { familyId:input.familyId, storyId:input.storyId, chapterId:input.chapterId,
    revisionId:input.revisionId, expectedVersion:input.expectedVersion, requestId:input.requestId,
    title:input.title, textBlocks };
}

async function editAuthorizedChapter(repo, ctx, rawInput, { now = () => new Date().toISOString(), approve = async () => true } = {}) {
  const input = normalize(rawInput);
  const fingerprint = core.stable(input);
  const operationId = digest(JSON.stringify([ctx.principalId, input.familyId, input.storyId, input.requestId]));
  const authorized = async tx => {
    await assertCurrentIdentity(tx, ctx);
    const family = await tx.get('families', input.familyId);
    const space = await tx.get('story_principal_spaces', input.familyId);
    const story = await tx.get('stories', `${input.familyId}_${input.storyId}`);
    if (!family || family.storyBooks?.status !== 'active' || !space || space.status !== 'active' ||
        family.ownerAccountId !== space.accountId || !story || story.familyId !== input.familyId ||
        story.id !== input.storyId || story.deletedAt) throw identityError();
    const grant = await tx.get('story_grants', grantIdFor(input.familyId, input.storyId, ctx.principalId));
    if (!evaluateStoryAccess({ principalId:ctx.principalId, ownerPrincipalId:space.principalId, story, grant,
      action:'edit', chapterIds:[input.chapterId] })) throw identityError();
    const receipt = await tx.get('story_collaboration_operations', operationId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) fail('VERSION_CONFLICT', '请求编号冲突，请重新打开章节');
      return { receipt };
    }
    if (story.version !== input.expectedVersion || story.currentRevisionId !== input.revisionId) {
      fail('VERSION_CONFLICT', '故事已有更新；你的修改仍保留在本机，请核对后再保存');
    }
    const record = await tx.get('biography_drafts', `${input.familyId}_${input.revisionId}`);
    if (!record || record.familyId !== input.familyId || record.storyId !== story.id ||
        record.revision?.id !== input.revisionId || record.revision.storyId !== story.id ||
        !Array.isArray(record.revision.draft?.chapters)) throw identityError();
    const draft = JSON.parse(JSON.stringify(record.revision.draft));
    const chapter = draft.chapters.find(item => item.id === input.chapterId);
    if (!chapter || !Array.isArray(chapter.content)) throw identityError();
    const expectedIndexes = chapter.content.flatMap((item, index) => typeof item.text === 'string' && item.photoId === undefined ? [index] : []);
    if (expectedIndexes.length !== input.textBlocks.length || expectedIndexes.some((index, position) => input.textBlocks[position]?.index !== index)) {
      fail('VERSION_CONFLICT', '章节结构已有变化；你的修改仍保留在本机，请核对后再保存');
    }
    if (chapter.title === input.title && input.textBlocks.every(block => chapter.content[block.index].text === block.text)) {
      fail('INVALID_INPUT', '正文没有变化');
    }
    return { story, record, draft, chapter };
  };
  const preflight = await repo.transaction(authorized);
  if (preflight.receipt) return preflight.receipt.result;
  if (await approve([input.title, ...input.textBlocks.map(block => block.text)].join('\n'),ctx.verifiedOpenid) !== true) {
    fail('CONTENT_REJECTED', '内容安全检查未通过，修改仍保留在本机');
  }
  return repo.transaction(async tx => {
    const checked = await authorized(tx);
    if (checked.receipt) return checked.receipt.result;
    const { story, record, draft, chapter } = checked;
    chapter.title = input.title;
    for (const block of input.textBlocks) chapter.content[block.index] = { ...chapter.content[block.index], text:block.text };
    Object.assign(draft, core.flatten(draft.chapters));
    const savedAt = now();
    const revisionId = `revision-collab-${digest(JSON.stringify([ctx.principalId, input.requestId])).slice(0, 32)}`;
    const existing = await tx.get('biography_drafts', `${input.familyId}_${revisionId}`);
    if (existing) fail('VERSION_CONFLICT', '版本编号冲突，请重新打开章节');
    core.validateDraft(draft, story);
    const revision = { ...record.revision, id:revisionId, storyId:story.id, savedAt, draft,
      kind:'draft', label:'亲友编辑', sourceRevisionId:input.revisionId, expectedStoryVersion:story.version,
      editedByPrincipalId:ctx.principalId, editedChapterIds:[input.chapterId] };
    const nextStory = { ...story, currentRevisionId:revisionId, version:story.version + 1, updatedAt:savedAt };
    const result = { ok:true, storyId:story.id, chapterId:input.chapterId, revisionId, version:nextStory.version };
    await tx.set('biography_drafts', `${input.familyId}_${revisionId}`, { familyId:input.familyId, storyId:story.id, draftType:'story-revision', revision });
    await tx.set('stories', `${input.familyId}_${story.id}`, nextStory);
    await tx.set('story_collaboration_operations', operationId, { familyId:input.familyId, storyId:story.id,
      principalId:ctx.principalId, requestId:input.requestId, fingerprint, result, createdAt:savedAt });
    return result;
  });
}

module.exports = { editAuthorizedChapter, normalize };
