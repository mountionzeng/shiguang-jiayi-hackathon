const { assertSpaceOwner, identityError, FAMILY_ID } = require('./identity');

const STORY_ID = /^story-[a-z0-9-]{1,100}$/;
const CHAPTER_ID = /^chapter-[a-z0-9-]{1,60}$/;
const MAX_STEPS = 40;
const MAX_CHANGES = 20;
const MAX_TEXT = 400;

/*
 * 主人在某一章里看到“谁改了哪几段”。
 *
 * 只读、只给主人；沿着 sourceRevisionId 从当前版本往前走，把每个由家人保存的
 * 版本和它的上一版逐段比对。只展示这一章里文字真的变了的段落，截断到 MAX_TEXT 字，
 * 不返回整本书，也不返回家人没改的内容。走不到头（缺失、成环、超步数）就停下，
 * 已经找到的照样返回，不拿一次读失败拖垮整章。
 */
function textBlocks(chapter) {
  return (chapter?.content || []).flatMap(block => typeof block.text === 'string' && block.photoId === undefined ? [block.text] : []);
}
const clip = text => Array.from(String(text)).slice(0, MAX_TEXT).join('');

function diffBlocks(before, after) {
  const changes = [];
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (before[index] === after[index]) continue;
    changes.push({ index, before: before[index] === undefined ? '' : clip(before[index]), after: after[index] === undefined ? '' : clip(after[index]) });
  }
  return changes;
}

async function revisionRecord(tx, familyId, revisionId) {
  const record = await tx.get('biography_drafts', `${familyId}_${revisionId}`);
  return record?.familyId === familyId && record.revision?.id === revisionId ? record.revision : undefined;
}

async function names(tx, familyId, storyId) {
  const directory = await tx.get('story_invite_indexes', `${familyId}_${storyId}`);
  const byPrincipal = new Map();
  for (const id of Array.isArray(directory?.ids) ? directory.ids.slice(0, 12) : []) {
    const inv = await tx.get('story_invitations', id);
    if (inv?.recipientPrincipalId) {
      byPrincipal.set(inv.recipientPrincipalId, inv.applicants?.find(a => a.principalId === inv.recipientPrincipalId)?.displayName || inv.inviteeName || '亲友');
    }
  }
  return byPrincipal;
}

async function listChapterChanges(repo, ctx, input) {
  if (!input || !FAMILY_ID.test(input.familyId || '') || input.familyId !== ctx.familyId ||
      !STORY_ID.test(input.storyId || '') || !CHAPTER_ID.test(input.chapterId || '')) throw identityError();
  return repo.transaction(async tx => {
    await assertSpaceOwner(tx, ctx);
    const story = await tx.get('stories', `${ctx.familyId}_${input.storyId}`);
    if (!story || story.familyId !== ctx.familyId || story.id !== input.storyId || story.deletedAt) throw identityError();
    const who = await names(tx, ctx.familyId, story.id);
    const changes = [];
    let revisionId = story.currentRevisionId;
    const seen = new Set();
    for (let step = 0; step < MAX_STEPS && changes.length < MAX_CHANGES && revisionId && !seen.has(revisionId); step += 1) {
      seen.add(revisionId);
      const revision = await revisionRecord(tx, ctx.familyId, revisionId);
      if (!revision || revision.storyId !== story.id) break;
      const previousId = revision.sourceRevisionId;
      if (revision.editedByPrincipalId && previousId && (revision.editedChapterIds || []).includes(input.chapterId)) {
        const previous = await revisionRecord(tx, ctx.familyId, previousId);
        const after = revision.draft?.chapters?.find(chapter => chapter.id === input.chapterId);
        const before = previous?.draft?.chapters?.find(chapter => chapter.id === input.chapterId);
        if (after && before) {
          const blocks = diffBlocks(textBlocks(before), textBlocks(after));
          const titleChanged = (before.title || '') !== (after.title || '');
          if (blocks.length || titleChanged) {
            changes.push({ revisionId, by: who.get(revision.editedByPrincipalId) || '一位亲友', savedAt: revision.savedAt,
              ...(titleChanged ? { title: { before: clip(before.title || ''), after: clip(after.title || '') } } : {}), blocks });
          }
        }
      }
      revisionId = previousId;
    }
    return { changes };
  });
}

module.exports = { listChapterChanges, diffBlocks };
