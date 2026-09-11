import { FamilyMember, FamilyRoomState, MemoryContribution } from "../domain/biography";

export type MemberKind = NonNullable<FamilyMember["kind"]>;

/**
 * One member update and the memories whose references it changes. Storage writes the
 * memories first and the member last, so a failed attempt leaves the member visible
 * and a retry recomputes the same change from the latest state.
 */
export interface MemberChange {
  member: FamilyMember;
  contributions: MemoryContribution[];
}

function findMember(state: FamilyRoomState, memberId: string): FamilyMember {
  const member = state.members.find((item) => item.id === memberId);
  if (!member) throw new Error("没有找到这个档案或亲友，请刷新后重试");
  return member;
}

/** Memories that name the member as a related person or reader, with that reference removed. */
export function withoutMemberReferences(
  contributions: MemoryContribution[],
  memberId: string,
): MemoryContribution[] {
  const strip = (ids: unknown) => Array.isArray(ids) && ids.includes(memberId)
    ? ids.filter((id) => id !== memberId)
    : undefined;
  return contributions.flatMap((contribution) => {
    const related = strip(contribution.relatedMemberIds);
    const readers = strip(contribution.sharedWithMemberIds);
    if (!related && !readers) return [];
    const next = { ...contribution };
    if (related) next.relatedMemberIds = related.length ? related : undefined;
    if (readers) next.sharedWithMemberIds = readers.length ? readers : undefined;
    return [next];
  });
}

/** Legacy records only: set the missing kind and nothing else. */
export function planClassify(
  state: FamilyRoomState,
  memberId: string,
  kind: MemberKind,
  currentMemberId: string,
): MemberChange | undefined {
  const member = findMember(state, memberId);
  if (member.deletedAt) throw new Error("它在「最近删除」里，请先恢复");
  if (member.kind === kind) return undefined;
  if (member.kind) throw new Error("只能给旧版数据归类");
  if (kind === "person" && member.id === currentMemberId) {
    throw new Error("正在使用的档案不能归为亲友，请先切换到别的档案");
  }
  return { member: { ...member, kind }, contributions: [] };
}

/**
 * Soft delete. A profile's book and versions stay stored and come back on restore;
 * the memories it told stay in the shared pool. References to the member are removed
 * from memories, which themselves are never deleted.
 */
export function planDelete(
  state: FamilyRoomState,
  memberId: string,
  currentMemberId: string,
  now = new Date(),
): MemberChange | undefined {
  const member = findMember(state, memberId);
  const contributions = withoutMemberReferences(state.contributions, memberId);
  if (member.deletedAt) return contributions.length ? { member, contributions } : undefined;
  if (member.id === currentMemberId) throw new Error("正在使用的档案不能删除，请先切换到别的档案");
  return { member: { ...member, deletedAt: now.toISOString() }, contributions };
}

export function planRestore(state: FamilyRoomState, memberId: string): MemberChange | undefined {
  const member = findMember(state, memberId);
  if (!member.deletedAt) return undefined;
  const { deletedAt: _deletedAt, ...restored } = member;
  return { member: restored, contributions: [] };
}

export function applyMemberChange(state: FamilyRoomState, change: MemberChange): FamilyRoomState {
  const changed = new Map(change.contributions.map((item) => [item.id, item]));
  return {
    ...state,
    members: state.members.map((item) => item.id === change.member.id ? change.member : item),
    contributions: state.contributions.map((item) => changed.get(item.id) ?? item),
  };
}
