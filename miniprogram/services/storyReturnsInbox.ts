import { StoryReturn, storyCopies } from "./storyCopies";

/**
 * 朋友发回的回信，首页、目录、章节正文三处共用。
 * 回信只是锦上添花：任何失败（开关未开、网络、权限）都当作「没有回信」，
 * 绝不能拖慢或打断首页和书稿页的加载。
 */
export interface PendingReturn extends StoryReturn { senderName?: string }

const FRESH_MS = 60 * 1000;
const CLOSED_MS = 10 * 60 * 1000;
let cache: { at: number; ttl: number; returns: PendingReturn[] } | undefined;

/** 发回、收录、拒绝之后调用，让下一次读取拿到最新结果。 */
export function invalidatePendingReturns(): void { cache = undefined; }

export async function loadPendingReturns(): Promise<PendingReturn[]> {
  if (cache && Date.now() - cache.at < cache.ttl) return cache.returns;
  try {
    const result = await storyCopies.returns();
    const returns = (result.returns as PendingReturn[]).filter(item => item.status === "pending");
    cache = { at: Date.now(), ttl: FRESH_MS, returns };
    return returns;
  } catch (error) {
    // 功能未开放时每次进首页都再问一遍云端没有意义，十分钟内不再重试。
    const closed = (error as { code?: string })?.code === "STORY_ACCESS_DISABLED";
    cache = { at: Date.now(), ttl: closed ? CLOSED_MS : FRESH_MS, returns: [] };
    return [];
  }
}

function returnsForStory(returns: PendingReturn[], storyId: string): PendingReturn[] {
  return returns.filter(item => item.sourceStoryId === storyId);
}

export function returnsForChapter(returns: PendingReturn[], storyId: string, chapterId: string): PendingReturn[] {
  return returns.filter(item => item.sourceStoryId === storyId && item.sourceChapterId === chapterId);
}

export function chapterIdsWithReturns(returns: PendingReturn[], storyId: string): Set<string> {
  return new Set(returnsForStory(returns, storyId).map(item => item.sourceChapterId));
}

export function senderLabel(item: PendingReturn): string {
  return item.senderName && item.senderName.trim() ? item.senderName.trim() : "一位亲友";
}

/** 首页只显示一条：最新的待处理回信，其余在书里看。 */
export function homeReturnNotice(
  returns: PendingReturn[],
  storyId: string,
  storyTitle: string,
): { text: string; chapterId: string; extra: number } | undefined {
  const mine = returnsForStory(returns, storyId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!mine.length) return undefined;
  const names = [...new Set(mine.map(senderLabel))];
  const who = names.length === 1 ? names[0] : `${names[0]}等 ${names.length} 位亲友`;
  return {
    text: `${who}给《${storyTitle}》回信了`,
    chapterId: mine[0].sourceChapterId,
    extra: mine.length - 1,
  };
}
