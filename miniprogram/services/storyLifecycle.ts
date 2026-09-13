import { DeletedStory, FamilyRoomState } from "../domain/biography";

export function planDeleteStory(
  state: FamilyRoomState,
  key: string,
  title: string,
  now = new Date(),
): FamilyRoomState {
  if (!key || !title) throw new Error("没有找到这个故事，请刷新后重试");
  const previous = state.deletedStories ?? [];
  if (previous.some((story) => story.key === key)) return state;
  const deleted: DeletedStory = { key, title, deletedAt: now.toISOString() };
  return { ...state, deletedStories: [deleted, ...previous] };
}

export function planRestoreStory(state: FamilyRoomState, key: string): FamilyRoomState {
  const deletedStories = (state.deletedStories ?? []).filter((story) => story.key !== key);
  if (deletedStories.length === (state.deletedStories ?? []).length) return state;
  return { ...state, deletedStories };
}
