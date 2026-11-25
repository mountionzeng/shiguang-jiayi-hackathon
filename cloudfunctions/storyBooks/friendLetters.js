const { evaluateStoryAccess, grantIdFor, readAuthorizedStory } = require('./access');
const { PRINCIPAL_ID } = require('./identity');

const INBOX = 'story_friend_letter_inboxes';
const RETAINED = 40;
const HOME_LIMIT = 3;
const storyKey = ({ familyId, storyId }) => familyId + ':' + storyId;

// The invitation directory bounds delivery and includes shares accepted before
// letters existed. Persist with the save so retries cannot send old updates again.
async function publishFriendLetters(tx, ctx, story, revision, changes) {
  if (!changes.length) return;
  const { familyId, id: storyId } = story;
  const directory = await tx.get('story_invite_indexes', `${familyId}_${storyId}`);
  if (!directory?.ids?.length) return;
  const space = await tx.get('story_principal_spaces', familyId);
  if (space?.status !== 'active' || !PRINCIPAL_ID.test(space.principalId)) return;
  const ownerPrincipalId = space.principalId;
  const nowMs = Date.parse(revision.savedAt);

  async function deliver(principalId, invitationId, eligible) {
    const previous = await tx.get(INBOX, principalId);
    const fresh = eligible.map(({ chapterId, summary }) => ({
      familyId, storyId, chapterId, ownerPrincipalId, invitationId,
      editorPrincipalId: ctx.principalId, editorName: revision.editorName || '亲友',
      summary,
    }));
    const replaced = new Set(fresh.map(letter => letter.chapterId));
    const retained = (previous?.letters || []).filter(letter =>
      letter.familyId !== familyId || letter.storyId !== storyId || !replaced.has(letter.chapterId));
    await tx.set(INBOX, principalId, { letters: [...fresh, ...retained].slice(0, RETAINED) });
  }

  if (ctx.principalId !== ownerPrincipalId) await deliver(ownerPrincipalId, null, changes);
  for (const invitationId of directory.ids) {
    const invitation = await tx.get('story_invitations', invitationId);
    const principalId = invitation?.recipientPrincipalId;
    if (invitation?.status !== 'approved' || invitation.familyId !== familyId || invitation.storyId !== storyId ||
        !PRINCIPAL_ID.test(principalId) || principalId === ctx.principalId || principalId === ownerPrincipalId) continue;
    const grant = await tx.get('story_grants', grantIdFor(familyId, storyId, principalId));
    if (grant?.invitationId !== invitationId) continue;
    const eligible = changes.filter(({ chapterId }) => evaluateStoryAccess({
      principalId, ownerPrincipalId, story, grant, action: 'read', chapterIds: [chapterId], nowMs,
    }));
    if (eligible.length) await deliver(principalId, invitationId, eligible);
  }
}

async function listFriendLetters(repo, ctx, canaryFamilies, approveText) {
  const inbox = await repo.get(INBOX, ctx.principalId);
  const letters = [];
  const shown = new Set();
  for (const entry of inbox?.letters || []) {
    const { familyId, storyId, chapterId, ownerPrincipalId, invitationId, editorPrincipalId, editorName, summary } = entry;
    const id = storyKey(entry);
    if (shown.has(id) || editorPrincipalId === ctx.principalId || !canaryFamilies.has(familyId)) continue;
    try {
      const read = await readAuthorizedStory(repo, ctx, { familyId, storyId, chapterIds: [chapterId] }, {
        approveText, expectedShare: { ownerPrincipalId, invitationId },
      });
      letters.push({ id, familyId, storyId, chapterId, editorName, storyTitle: read.story.title,
        chapterTitle: read.chapters[0].title || '未命名章节', summary });
      shown.add(id);
      if (letters.length === HOME_LIMIT) break;
    } catch (error) {
      if (!['STORY_FORBIDDEN', 'CONTENT_REJECTED'].includes(error.code)) throw error;
    }
  }
  return { letters };
}

module.exports = { listFriendLetters, publishFriendLetters };
