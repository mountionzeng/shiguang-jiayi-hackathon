import { createContribution, FamilyMember, MAX_MEMORY_LENGTH, MemoryContribution } from "../domain/biography";
import { appendContributionRemoteFirst } from "./roomRepository";

export interface DrinkingTimeStory { id: number; title: string; }
export interface DrinkingTimeDocument extends DrinkingTimeStory { body: string; bodyAvailable: boolean; }
export const MAX_IMPORTED_STORY_CHUNKS = 100;

const ERROR_MESSAGES: Record<string, string> = {
  bridge_not_configured: "账号关联服务还没有配置好",
  bridge_timeout: "Drinking Time 响应超时，请稍后重试",
  bridge_unavailable: "暂时无法连接 Drinking Time",
  email_not_configured: "邮箱验证码服务暂未配置",
  email_already_linked: "当前微信账号已关联其他邮箱",
  identity_conflict: "这个邮箱存在账号冲突，请联系管理员核对",
  invalid_bridge_signature: "账号关联服务校验失败",
  invalid_input: "请检查邮箱或验证码是否填写正确",
  invalid_otp: "验证码不正确或已过期",
  needs_manual_mapping: "这个旧账号需要管理员确认后才能关联",
  not_linked: "请先验证并关联 Drinking Time 邮箱",
  rate_limited: "操作太频繁，请稍后再试",
  session_expired: "验证已过期，请重新获取验证码",
  source_has_data: "两边都有内容，已停止自动关联以保护原故事",
  unavailable: "Drinking Time 暂时不可用",
};

function friendlyBridgeError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const code = Object.keys(ERROR_MESSAGES).find(key => raw.includes(key));
  return new Error(code ? ERROR_MESSAGES[code] : "暂时无法连接 Drinking Time");
}

async function call<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  if (!wx.cloud) throw new Error("当前微信版本暂不支持账号关联");
  try {
    const response = await wx.cloud.callFunction({ name: "drinkingTimeBridge", data: { action, ...data } });
    if (!response.result || typeof response.result !== "object") throw new Error("bridge_unavailable");
    return response.result as T;
  } catch (error) {
    throw friendlyBridgeError(error);
  }
}
export const requestDrinkingTimeOtp = (email: string) => call<{ ok: true }>("requestOtp", { email });
export const linkDrinkingTimeEmail = (email: string, otp: string) => call<{ linked: true }>("link", { email, otp });
export async function drinkingTimeLinkStatus(): Promise<boolean> {
  const result = await call<{ linked?: unknown }>("status");
  return result.linked === true;
}
export async function listDrinkingTimeStories(): Promise<DrinkingTimeStory[]> {
  const result = await call<{ stories?: unknown }>("list");
  if (!Array.isArray(result.stories)) throw new Error("网页版故事列表暂不可用");
  return result.stories.filter((item): item is DrinkingTimeStory => Boolean(item) && Number.isSafeInteger((item as DrinkingTimeStory).id) && typeof (item as DrinkingTimeStory).title === "string");
}
export async function readDrinkingTimeStory(storyId: number): Promise<DrinkingTimeDocument> {
  const result = await call<Partial<DrinkingTimeDocument>>("read", { storyId });
  if (!Number.isSafeInteger(result.id) || typeof result.title !== "string" ||
      typeof result.body !== "string" || typeof result.bodyAvailable !== "boolean") {
    throw new Error("网页版故事正文暂不可用");
  }
  return result as DrinkingTimeDocument;
}

export function splitImportedStory(text: string): string[] {
  const source = text.trim(); if (!source) return [];
  const chunks: string[] = []; let rest = source;
  while (rest.length > MAX_MEMORY_LENGTH) {
    const window = rest.slice(0, MAX_MEMORY_LENGTH + 1);
    const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"));
    const cut = boundary >= 120 ? boundary + 1 : MAX_MEMORY_LENGTH;
    chunks.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest); return chunks;
}
export function importedContributions(document: DrinkingTimeDocument, member: FamilyMember, fragment?: string): MemoryContribution[] {
  const chunks = fragment === undefined ? splitImportedStory(document.body) : [fragment.trim()].filter(Boolean);
  if (fragment !== undefined && chunks[0]?.length > MAX_MEMORY_LENGTH) {
    throw new Error(`片段最多 ${MAX_MEMORY_LENGTH} 字，请再删减一些`);
  }
  if (chunks.length > MAX_IMPORTED_STORY_CHUNKS) {
    throw new Error("这篇故事超过 5 万字，请先在网页版拆成几篇再导入");
  }
  return chunks.map((text, index) => createContribution({
    id: `memory-dt-${document.id}-${fragment === undefined ? "story" : "fragment"}-${index + 1}`,
    authorMemberId: member.id, authorName: member.name, relation: member.relation, text,
    title: index === 0 ? document.title : `${document.title}（续）`, storyTitle: document.title,
    memoryType: fragment === undefined ? "memoir" : "note", scope: "personal", visibility: "private",
    now: new Date(1_700_000_000_000 + index),
  }));
}
export async function importDrinkingTimeStory(document: DrinkingTimeDocument, member: FamilyMember, fragment?: string) {
  const contributions = importedContributions(document, member, fragment);
  if (!contributions.length) throw new Error("这篇故事还没有可导入的正文");
  for (const contribution of contributions) await appendContributionRemoteFirst(contribution);
  return contributions.length;
}
