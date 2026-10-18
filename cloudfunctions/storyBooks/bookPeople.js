// A person mentioned in a book is not an authenticated reader. Only explicit
// member IDs and invitation records link the two; display names never do.
async function bookPeople(tx, story, invitations, members) {
  const ids = new Set(story.protagonistMemberIds || []);
  if (story.legacy?.memberId) ids.add(story.legacy.memberId);
  const memories = await Promise.all((story.memoryIds || []).map(id => tx.get('memories', `${story.familyId}_${id}`)));
  for (const memory of memories) {
    if (!memory || memory.familyId !== story.familyId || memory.deletedAt) continue;
    if (memory.authorMemberId) ids.add(memory.authorMemberId);
    for (const id of memory.relatedMemberIds || []) ids.add(id);
  }
  for (const invitation of invitations) if (invitation.memberId) ids.add(invitation.memberId);
  const available = members.filter(member => member && member.familyId === story.familyId && !member.deletedAt).map(member => ({
    id: member.memberId || member.id, name: member.name, relation: member.relation,
    avatarText: member.avatarText, isOwner: member.role === 'owner',
  }));
  return {people:available.filter(member => ids.has(member.id)),availablePeople:available.filter(member => !member.isOwner)};
}

module.exports = { bookPeople };
