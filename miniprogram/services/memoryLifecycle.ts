import { FamilyRoomState, MemoryContribution } from "../domain/biography";

function findContribution(state: FamilyRoomState, contributionId: string): MemoryContribution {
  const contribution = state.contributions.find((item) => item.id === contributionId);
  if (!contribution) throw new Error("没有找到这段记忆，请刷新后重试");
  return contribution;
}

/**
 * 软删除：放进「最近删除」，从所有正常列表里隐去，可以恢复。已经被某一章写进正文的
 * 原话不受影响——删除来源记忆，不会拿掉书稿里已经存下的字；那一章的 memoryIds 里
 * 仍然留着这个 id，只是它现在指向一条已删除的记忆（现有代码本来就能容忍未知/失效 id）。
 */
export function planDeleteMemory(
  state: FamilyRoomState,
  contributionId: string,
  now = new Date(),
): MemoryContribution | undefined {
  const contribution = findContribution(state, contributionId);
  if (contribution.deletedAt) return undefined;
  return { ...contribution, deletedAt: now.toISOString() };
}

export function planRestoreMemory(state: FamilyRoomState, contributionId: string): MemoryContribution | undefined {
  const contribution = findContribution(state, contributionId);
  if (!contribution.deletedAt) return undefined;
  const { deletedAt: _deletedAt, ...restored } = contribution;
  return restored;
}
