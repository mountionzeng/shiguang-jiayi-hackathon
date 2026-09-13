import { createContribution, FamilyMember, MAX_MEMORY_LENGTH, MemoryContribution } from "../domain/biography";
import { appendContributionsRemoteFirst } from "./roomRepository";

export interface DrinkingTimeStory { id: number; title: string; }
export interface DrinkingTimeDocument extends DrinkingTimeStory { body: string; bodyAvailable: boolean; sourceRevision: string; sourceUpdatedAt: number; }
export interface DrinkingTimeStoryPage { stories: DrinkingTimeStory[]; nextCursor: number | null; }
const MAX_IMPORTED_STORY_LENGTH = 50_000;

const ERROR_MESSAGES: Record<string, string> = {
  bridge_not_configured: "账号关联服务还没有配置好",
  bridge_timeout: "Drinking Time 响应超时，请稍后重试",
  bridge_unavailable: "暂时无法连接 Drinking Time",
  email_not_configured: "邮箱验证码服务暂未配置",
  email_already_linked: "当前微信账号已关联其他邮箱",
  identity_conflict: "这个邮箱存在账号冲突，请联系管理员核对",
  invalid_code: "关联身份已经变化，请重新验证",
  invalid_bridge_signature: "账号关联服务校验失败",
  invalid_input: "请检查邮箱或验证码是否填写正确",
  invalid_otp: "验证码不正确或已过期",
  needs_manual_mapping: "这个旧账号需要管理员确认后才能关联",
  not_found: "这篇故事已不存在或不属于当前账号",
  not_linked: "请先验证并关联 Drinking Time 邮箱",
  rate_limited: "操作太频繁，请稍后再试",
  replayed_request: "请求已处理，请刷新后查看结果",
  session_expired: "验证已过期，请重新获取验证码",
  source_has_data: "两边都有内容，已停止自动关联以保护原故事",
  story_list_too_large: "网页版故事太多，请先在网页端整理后再导入",
  story_response_too_large: "这篇故事含有较多特殊字符，请先在网页版拆分后再导入",
  story_too_large: "这篇故事超过 5 万字，请先在网页版拆成几篇再导入",
  bridge_response_aborted: "连接意外中断，请重试",
  bridge_response_too_large: "返回内容过大，请先在网页版拆分",
  unavailable: "Drinking Time 暂时不可用",
};

function friendlyBridgeError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const code = Object.keys(ERROR_MESSAGES).find(key => raw.includes(key));
  return new Error(code ? ERROR_MESSAGES[code] : "暂时无法连接 Drinking Time");
}

async function call(action: string, data: Record<string, unknown> = {}): Promise<unknown> {
  if (!wx.cloud) throw new Error("当前微信版本暂不支持账号关联");
  try {
    const response = await wx.cloud.callFunction({ name: "drinkingTimeBridge", data: { action, ...data } });
    if (!response.result || typeof response.result !== "object") throw new Error("bridge_unavailable");
    return response.result;
  } catch (error) {
    throw friendlyBridgeError(error);
  }
}
function recordFrom(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Drinking Time 返回了无法识别的数据");
  return value as Record<string, unknown>;
}
export async function requestDrinkingTimeOtp(email: string): Promise<void> {
  const result = recordFrom(await call("requestOtp", { email }));
  if (result.ok !== true) throw new Error("验证码发送状态无法确认，请重试");
}
export async function linkDrinkingTimeEmail(email: string, otp: string): Promise<void> {
  const result = recordFrom(await call("link", { email, otp }));
  if (result.linked !== true) throw new Error("关联状态无法确认，请重试");
}
export interface DrinkingTimeLinkStatus { linked: boolean; emailHint: string; }
export async function drinkingTimeLinkStatus(): Promise<DrinkingTimeLinkStatus> {
  const result = recordFrom(await call("status"));
  if (typeof result.linked !== "boolean" || typeof result.emailHint !== "string") {
    throw new Error("关联状态暂时无法确认");
  }
  return { linked: result.linked, emailHint: result.emailHint };
}
function storyPageFrom(value: unknown, cursor: number): DrinkingTimeStoryPage {
  const result = recordFrom(value);
  if (!Array.isArray(result.stories)) throw new Error("网页版故事列表暂不可用");
  if (!result.stories.every((item): item is DrinkingTimeStory => Boolean(item) &&
      Number.isSafeInteger((item as DrinkingTimeStory).id) && (item as DrinkingTimeStory).id > 0 &&
      typeof (item as DrinkingTimeStory).title === "string")) {
    throw new Error("网页版故事列表格式已变化，请更新小程序");
  }
  if (result.nextCursor !== null &&
      (!Number.isSafeInteger(result.nextCursor) || (result.nextCursor as number) <= cursor)) {
    throw new Error("网页版故事分页状态异常，请稍后重试");
  }
  return { stories: result.stories, nextCursor: result.nextCursor as number | null };
}
export async function listDrinkingTimeStoryPage(cursor = 0): Promise<DrinkingTimeStoryPage> {
  return storyPageFrom(await call("list", { cursor }), cursor);
}
export async function readDrinkingTimeStory(storyId: number): Promise<DrinkingTimeDocument> {
  const result = recordFrom(await call("read", { storyId })) as Partial<DrinkingTimeDocument>;
  if (!Number.isSafeInteger(result.id) || typeof result.title !== "string" ||
      typeof result.body !== "string" || typeof result.bodyAvailable !== "boolean" ||
      typeof result.sourceRevision !== "string" || typeof result.sourceUpdatedAt !== "number" ||
      !Number.isFinite(result.sourceUpdatedAt) || (result.bodyAvailable && !/^[0-9a-f]{24}$/.test(result.sourceRevision))) {
    throw new Error("网页版故事正文暂不可用");
  }
  return result as DrinkingTimeDocument;
}

export function splitImportedStory(text: string): string[] {
  const source = text.trim(); if (!source) return [];
  const chunks: string[] = []; let rest = source;
  while (rest.length > MAX_MEMORY_LENGTH) {
    chunks.push(rest.slice(0, MAX_MEMORY_LENGTH).trim());
    rest = rest.slice(MAX_MEMORY_LENGTH).trim();
  }
  if (rest) chunks.push(rest); return chunks;
}

function textFingerprint(text: string): string {
  let left = 0x811c9dc5, right = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}
export function importedContributions(document: DrinkingTimeDocument, member: FamilyMember, fragment?: string): MemoryContribution[] {
  const source = fragment === undefined ? document.body.trim() : fragment.trim();
  if (fragment === undefined && source.length > MAX_IMPORTED_STORY_LENGTH) {
    throw new Error("这篇故事超过 5 万字，请先在网页版拆成几篇再导入");
  }
  if (fragment !== undefined && source.length > MAX_MEMORY_LENGTH) {
    throw new Error(`片段最多 ${MAX_MEMORY_LENGTH} 字，请再删减一些`);
  }
  const chunks = fragment === undefined ? splitImportedStory(source) : [source].filter(Boolean);
  const importKey = fragment === undefined ? `${document.sourceRevision}-full` : `${document.sourceRevision}-fragment-${textFingerprint(source)}`;
  return chunks.map((text, index) => createContribution({
    id: `memory-dt-${document.id}-${importKey}-${index + 1}`,
    authorMemberId: member.id, authorName: member.name, relation: member.relation, text,
    title: index === 0 ? document.title : `${document.title}（续）`, storyTitle: document.title,
    memoryType: fragment === undefined ? "memoir" : "note", scope: "personal", visibility: "private",
    now: new Date(document.sourceUpdatedAt + index),
  }));
}
export function pendingImportedContributions(candidates: MemoryContribution[], existing: MemoryContribution[]) {
  const existingIds = new Set(existing.map(item => item.id));
  return candidates.filter(item => !existingIds.has(item.id));
}
export async function importDrinkingTimeStory(document: DrinkingTimeDocument, member: FamilyMember, existing: MemoryContribution[], fragment?: string) {
  const candidates = importedContributions(document, member, fragment);
  if (!candidates.length) throw new Error("这篇故事还没有可导入的正文");
  const pending = pendingImportedContributions(candidates, existing);
  if (pending.length) await appendContributionsRemoteFirst(pending);
  return pending.length;
}

export const drinkingTimeAccountTest = { friendlyBridgeError, recordFrom, storyPageFrom, textFingerprint };
