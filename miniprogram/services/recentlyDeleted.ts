import { FamilyRoomState, isActiveMemory, MemoryContribution } from "../domain/biography";
import { memoryDisplayTitle } from "../domain/memoryTitle";

/**
 * 「最近删除」：故事和记忆合在一起的一份列表，按删除时间倒序。
 * 只读，不写库；恢复/清空走 roomRepository.ts 里对应的 *RemoteFirst 函数。
 */
export interface RecentlyDeletedItem {
  type: "story" | "memory";
  /** story: DeletedStory.key；memory: MemoryContribution.id。恢复/永久删除时用这个。 */
  id: string;
  title: string;
  deletedAt: string;
}

export function recentlyDeletedItems(state: FamilyRoomState): RecentlyDeletedItem[] {
  const stories: RecentlyDeletedItem[] = (state.deletedStories ?? []).map((story) => ({
    type: "story",
    id: story.key,
    title: story.title,
    deletedAt: story.deletedAt,
  }));
  const memories: RecentlyDeletedItem[] = state.contributions
    .filter((contribution) => !isActiveMemory(contribution))
    .map((contribution) => ({
      type: "memory",
      id: contribution.id,
      title: memoryDisplayTitle(contribution),
      deletedAt: (contribution as MemoryContribution).deletedAt as string,
    }));
  return [...stories, ...memories].sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}
