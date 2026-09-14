import { FamilyRoomState, MemoryContribution } from "../domain/biography";
import { chaptersOf } from "./chapters";
import { currentManuscript } from "./manuscript";
import { storyShelf } from "./storyShelf";

export interface DesktopStoryOption {
  key: string;
  title: string;
  detail: string;
  excerpt: string;
}

export interface DesktopStorySnapshot {
  sourceKey: string;
  sourceRevision: string;
  title: string;
  updatedAt: string;
  memories: Array<Pick<MemoryContribution,
    "id" | "text" | "title" | "summary" | "emotions" | "people" | "places" | "storyTitle" | "createdAt">>;
  manuscript?: {
    title: string;
    generatedAt: string;
    chapters: Array<{
      id: string;
      title: string;
      memoryIds: string[];
      content: Array<{ text: string } | { photoId: string }>;
    }>;
  };
}

export interface DesktopTransferResult {
  code: string;
  expiresAt: string;
  storyId: number;
  imported: boolean;
}

const ERROR_MESSAGES: Record<string, string> = {
  bridge_not_configured: "电脑连接服务还没有配置好",
  bridge_timeout: "电脑连接服务响应超时，请稍后重试",
  bridge_unavailable: "暂时无法连接电脑端",
  invalid_bridge_signature: "电脑连接服务校验失败",
  invalid_input: "这篇故事暂时无法传到电脑，请刷新后重试",
  not_configured: "电脑登录码服务还没有配置好",
  rate_limited: "生成得太频繁了，请稍后再试",
  replayed_request: "这次请求已经处理，请重新选择故事",
  unavailable: "电脑端暂时不可用",
};

function friendlyBridgeError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const code = Object.keys(ERROR_MESSAGES).find(key => raw.includes(key));
  return new Error(code ? ERROR_MESSAGES[code] : "暂时无法连接电脑端");
}

async function call(action: string, data: Record<string, unknown> = {}): Promise<unknown> {
  if (!wx.cloud) throw new Error("当前微信版本暂不支持电脑连接");
  try {
    const response = await wx.cloud.callFunction({ name: "drinkingTimeBridge", data: { action, ...data } });
    if (!response.result || typeof response.result !== "object") throw new Error("bridge_unavailable");
    return response.result;
  } catch (error) {
    throw friendlyBridgeError(error);
  }
}

function fingerprint(text: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

export function desktopStoryOptions(state: FamilyRoomState): DesktopStoryOption[] {
  return storyShelf(state).map(story => ({
    key: story.key,
    title: story.title,
    detail: [story.memoryIds.length ? `${story.memoryIds.length} 段记忆` : "", story.chapterCount ? `${story.chapterCount} 章` : ""]
      .filter(Boolean)
      .join(" · "),
    excerpt: story.excerpt,
  }));
}

export function desktopStorySnapshot(state: FamilyRoomState, key: string): DesktopStorySnapshot {
  const story = storyShelf(state).find(item => item.key === key);
  if (!story) throw new Error("这个故事已经删除或更新，请刷新后重试");
  const byId = new Map(state.contributions.map(memory => [memory.id, memory]));
  const memories = story.memoryIds
    .map(id => byId.get(id))
    .filter((memory): memory is MemoryContribution => Boolean(memory))
    .map(memory => ({
      id: memory.id,
      text: memory.text,
      title: memory.title,
      summary: memory.summary,
      emotions: memory.emotions,
      people: memory.people,
      places: memory.places,
      storyTitle: memory.storyTitle,
      createdAt: memory.createdAt,
    }));
  const current = story.manuscriptMemberId
    ? currentManuscript(state, story.manuscriptMemberId)
    : undefined;
  const manuscript = current?.draft
    ? {
        title: current.draft.title,
        generatedAt: current.draft.generatedAt,
        chapters: chaptersOf(current.draft, current.sourceFingerprint).map(chapter => ({
          id: chapter.id,
          title: chapter.title,
          memoryIds: [...chapter.memoryIds],
          content: chapter.content.map(item => ({ ...item })),
        })),
      }
    : undefined;
  if (!memories.length && !manuscript?.chapters.some(chapter => chapter.content.length)) {
    throw new Error("这个故事还没有可以放到电脑上的内容");
  }
  const updatedAt = Number.isFinite(Date.parse(story.latestAt))
    ? story.latestAt
    : new Date().toISOString();
  const sourceRevision = fingerprint(JSON.stringify({ key: story.key, memories, manuscript }));
  return { sourceKey: story.key, sourceRevision, title: story.title, updatedAt, memories, manuscript };
}

function transferResult(value: unknown): DesktopTransferResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("电脑登录码返回异常");
  const result = value as Partial<DesktopTransferResult>;
  if (typeof result.code !== "string" || !/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(result.code) ||
    typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt)) ||
    !Number.isSafeInteger(result.storyId) || typeof result.imported !== "boolean") {
    throw new Error("电脑登录码返回异常");
  }
  return result as DesktopTransferResult;
}

export async function createDesktopStoryCode(state: FamilyRoomState, key: string) {
  return transferResult(await call("issueDesktop", { story: desktopStorySnapshot(state, key) }));
}

export const drinkingTimeAccountTest = { fingerprint, friendlyBridgeError, transferResult };
