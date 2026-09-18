const CURRENT_STORY_KEY = "shiguang-current-story-v1";
const CURRENT_STORY_ID_KEY = 'shiguang-current-story-id-v1';
export function loadCurrentStoryId(): string { return wx.getStorageSync<string>(CURRENT_STORY_ID_KEY) || ''; }
export function saveCurrentStoryId(id:string): void { wx.setStorageSync(CURRENT_STORY_ID_KEY,id); }

/** "" means an ungrouped conversation; undefined means no explicit choice yet. */
export function loadCurrentStoryTitle(): string | undefined {
  try {
    const stored = wx.getStorageSync<{ title?: unknown }>(CURRENT_STORY_KEY);
    return stored && typeof stored.title === "string" ? stored.title : undefined;
  } catch {
    return undefined;
  }
}

export function saveCurrentStoryTitle(title: string): void {
  try {
    wx.setStorageSync(CURRENT_STORY_KEY, { title });
  } catch {
    // This only controls which story appears first next time.
  }
}
