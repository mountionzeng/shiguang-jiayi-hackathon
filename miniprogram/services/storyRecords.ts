import {
  contributionStoryTitle,
  FamilyRoomState,
  isRecordingProfile,
  memoryPool,
  Story,
} from "../domain/biography";
import { currentManuscript, manuscriptHistory } from "./manuscript";

/**
 * 阶段 A：故事记录的样子，和「从旧数据算出固定 id 的故事」。
 * 只在内存里算，不写库；界面还没有接上这里，仍然读 services/storyShelf.ts。
 *
 * 规则来源：docs/2026-09-14-story-records-plan.md，用户 2026-09-14 确认。
 */

export const STORY_ID = /^story-[0-9a-z]+(?:-[0-9a-z]{1,20})?$/;

/** 新故事的 id：新建时用，不含在旧数据里就能算出来的成分。 */
export function newStoryId(now = new Date()): string {
  return `story-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^0-9a-z]/gi, "").toLowerCase() || "x";
}

/** 32 位 FNV-1a：只用来把中文故事名变成稳定、短小、合法的 id 片段。 */
function stableHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** 每个档案整理过的书稿，对应固定的故事 id：改名、书稿和同名记忆合并，都不变。 */
export function legacyManuscriptStoryId(memberId: string): string {
  return `story-m-${sanitizeIdPart(memberId)}`;
}

/** 只按故事名分组、还没有书稿的故事，对应固定的故事 id：同一个名字总算出同一个 id。 */
export function legacyTitleStoryId(title: string): string {
  return `story-t-${stableHash(title.trim())}`;
}

/** 已有数据里本来就重名时（例如两个档案的书稿同名），后出现的显示名加「（2）」「（3）」……不写库，只影响这次算出来的展示。 */
function dedupeDisplayTitle(title: string, seen: Map<string, number>): string {
  const count = (seen.get(title) ?? 0) + 1;
  seen.set(title, count);
  return count === 1 ? title : `${title}（${count}）`;
}

/**
 * 从现有数据（记忆库 + 各档案的书稿）算出「故事」的样子，id 固定、可重复调用。
 * 只读，不写库。deletedStories 沿用旧的按 key/名字记法，直到阶段 C 换成 Story.deletedAt。
 */
export function deriveLegacyStories(state: FamilyRoomState): Story[] {
  const familyId = state.roomName; // 阶段 A 占位：真正的 familyId 在阶段 B 接入云端时传入。
  const now = new Date(0).toISOString();
  const byTitle = new Map<string, Story>();
  // 「删了这个故事」在旧数据里按 storyShelf 的 key 记；书稿并进同名记忆故事后 key 不变
  // （沿用 services/storyShelf.ts 的行为），所以这张表在创建时就定死每个故事的旧 key。
  const legacyDeleteKey = new Map<Story, string>();

  memoryPool(state.contributions)
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .forEach((memory) => {
      const title = contributionStoryTitle(memory);
      if (!title) return;
      const existing = byTitle.get(title);
      if (existing) {
        if (!existing.memoryIds.includes(memory.id)) existing.memoryIds.push(memory.id);
        if (memory.createdAt > existing.updatedAt) existing.updatedAt = memory.createdAt;
        return;
      }
      const story: Story = {
        id: legacyTitleStoryId(title),
        familyId,
        title,
        protagonistMemberIds: [],
        memoryIds: [memory.id],
        createdAt: memory.createdAt,
        updatedAt: memory.createdAt,
        legacy: { storyTitle: title, previousShelfKey: `story:${title}` },
      };
      byTitle.set(title, story);
      legacyDeleteKey.set(story, `story:${title}`);
    });

  const manuscriptStories: Story[] = [];
  state.members.filter(isRecordingProfile).forEach((member) => {
    const { draft } = currentManuscript(state, member.id);
    if (!draft) return;
    const title = draft.title.trim();
    const savedAt = manuscriptHistory(state, member.id)[0]?.savedAt ?? draft.generatedAt ?? now;
    const named = title ? byTitle.get(title) : undefined;
    if (named && !named.legacy?.memberId) {
      // 书稿和同名记忆合并成一个故事：素材记忆保留，故事名、id 和旧删除 key 都用记忆那一份的（先出现的赢）。
      // 旧 key 沿用记忆那一份（storyShelf 合并后 key 不变），不换成书稿的 manuscript:key。
      named.legacy = { ...named.legacy, memberId: member.id };
      if (savedAt > named.updatedAt) named.updatedAt = savedAt;
      return;
    }
    const story: Story = {
      id: legacyManuscriptStoryId(member.id),
      familyId,
      title: title || "还没取名的书稿",
      protagonistMemberIds: [],
      memoryIds: [],
      createdAt: savedAt,
      updatedAt: savedAt,
      legacy: { memberId: member.id, storyTitle: title || undefined, previousShelfKey: `manuscript:${member.id}` },
    };
    manuscriptStories.push(story);
    legacyDeleteKey.set(story, `manuscript:${member.id}`);
  });

  const deletedKeys = new Set((state.deletedStories ?? []).map((story) => story.key));
  const deletedTitles = new Set((state.deletedStories ?? []).map((story) => story.title));
  const seenTitles = new Map<string, number>();

  return Array.from(byTitle.values())
    .concat(manuscriptStories)
    .filter((story) => !deletedKeys.has(legacyDeleteKey.get(story) ?? "") && !deletedTitles.has(story.title))
    // 按最近动过的排：素材记忆、书稿版本，谁的时间晚就排前面。
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    // 重名时，最近动过的那个留原名，其余的显示加「（2）」「（3）」……只影响这次算出来的展示，不写库。
    .map((story) => ({ ...story, title: dedupeDisplayTitle(story.title, seenTitles) }));
}
