import {
  contributionStoryTitle,
  FamilyRoomState,
  isRecordingProfile,
  memoryPool,
} from "../domain/biography";
import { createManuscriptReader } from "./manuscript";
import { startPerformanceMeasure } from './performanceLog';

/**
 * 「人生之书」里的一个故事。书就是故事：记忆库里同一个故事名的记忆算一个故事，
 * 以前每个档案整理好的书稿也算一个故事（名字就是书名）。书稿和同名故事合成一项。
 *
 * 这里只读现有数据，不写库；故事以后有了自己的记录，只需要换掉这里的来源。
 */
export interface ShelfStory {
  storyId?: string;
  writingMode?: "objective" | "creative";
  bookTitle?: string;
  key: string;
  title: string;
  /** Newest first. */
  memoryIds: string[];
  latestAt: string;
  excerpt: string;
  /** The profile whose manuscript this story's text lives in, if it has one. */
  manuscriptMemberId?: string;
  chapterCount: number;
}

export const UNTITLED_MANUSCRIPT = "还没取名的书稿";

export function storyShelf(state: FamilyRoomState): ShelfStory[] {
  const finish = startPerformanceMeasure('story.shelf');
  let outcome: 'ok' | 'error' = 'error';
  try {
    const shelf = buildStoryShelf(state);
    outcome = 'ok';
    return shelf;
  } finally {
    finish(outcome, { memories: state.contributions.length, revisions: state.manuscriptRevisions?.length ?? 0,
      stories: state.stories?.length ?? 0 });
  }
}

function buildStoryShelf(state: FamilyRoomState): ShelfStory[] {
  const reader = createManuscriptReader(state);
  const activeMemoryIds = new Set(state.contributions.filter(memory => !memory.deletedAt).map(memory => memory.id));
  // Preserve the existing excerpt order (contribution order, not story.memoryIds).
  const firstMemories = new Map<string, { index: number; text: string }>();
  state.contributions.forEach((memory, index) => {
    if (!firstMemories.has(memory.id)) firstMemories.set(memory.id, { index, text: memory.text });
  });
  const independent: ShelfStory[] = (state.stories ?? []).filter(s=>!s.deletedAt).map(story=>{
    const current = reader.current(story.id);
    const draft = current.draft;
    const memoryIds = story.memoryIds.filter(id => activeMemoryIds.has(id));
    let firstMemory: { index: number; text: string } | undefined;
    for (const id of memoryIds) {
      const memory = firstMemories.get(id);
      if (memory && (!firstMemory || memory.index < firstMemory.index)) firstMemory = memory;
    }
    return {key:story.id,storyId:story.id,title:story.title,bookTitle:story.bookTitle || story.title,writingMode:story.writingMode || 'objective',memoryIds,latestAt:story.updatedAt,
      excerpt:(draft?.paragraphs[0] || firstMemory?.text || '').slice(0,64),
      manuscriptMemberId:story.id,chapterCount:draft?.chapters?.length ?? 0};
  }).sort((a,b)=>b.latestAt.localeCompare(a.latestAt));
  if (state.storyMigration?.status === 'active') return independent;
  const byTitle = new Map<string, ShelfStory>();
  memoryPool(state.contributions)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .forEach((memory) => {
      const title = contributionStoryTitle(memory);
      if (!title) return;
      const story = byTitle.get(title);
      if (story) {
        story.memoryIds.push(memory.id);
        return;
      }
      byTitle.set(title, {
        key: `story:${title}`,
        title,
        memoryIds: [memory.id],
        latestAt: memory.createdAt,
        excerpt: memory.text.slice(0, 64),
        chapterCount: 0,
      });
    });

  const manuscripts: ShelfStory[] = [];
  state.members.filter(isRecordingProfile).forEach((member) => {
    const { draft } = reader.current(member.id);
    if (!draft) return;
    const title = draft.title.trim() || UNTITLED_MANUSCRIPT;
    const chapterCount = draft.chapters?.length || 1;
    const savedAt = reader.history(member.id)[0]?.savedAt ?? draft.generatedAt ?? "";
    const named = byTitle.get(title);
    if (named && !named.manuscriptMemberId) {
      named.manuscriptMemberId = member.id;
      named.chapterCount = chapterCount;
      if (savedAt > named.latestAt) named.latestAt = savedAt;
      return;
    }
    const firstText = (draft.chapters?.[0]?.content ?? draft.content ?? [])
      .map((item) => item.text ?? "").find(Boolean) ?? draft.paragraphs[0] ?? "";
    manuscripts.push({
      key: `manuscript:${member.id}`,
      title,
      memoryIds: [],
      latestAt: savedAt,
      excerpt: firstText.slice(0, 64),
      manuscriptMemberId: member.id,
      chapterCount,
    });
  });

  const deletedKeys = new Set((state.deletedStories ?? []).map((story) => story.key));
  const deletedTitles = new Set((state.deletedStories ?? []).map((story) => story.title));
  return independent.concat(Array.from(byTitle.values()).concat(manuscripts)
    // A manuscript joins a same-named memory story dynamically, which changes its
    // derived key. The title keeps the deletion stable across that transition.
    .filter((story) => !deletedKeys.has(story.key) && !deletedTitles.has(story.title)))
    .sort((left, right) => right.latestAt.localeCompare(left.latestAt));
}

export function shelfStoryLabel(story: ShelfStory): string {
  const parts: string[] = [];
  if (story.manuscriptMemberId) parts.push(`已整理 ${story.chapterCount} 章`);
  if (story.memoryIds.length) parts.push(`${story.memoryIds.length} 段记忆`);
  return parts.join(" · ");
}
