import {
  BiographyDraft,
  buildLocalChapterDraft,
  buildLocalPersonalBiographyDraft,
  FamilyMember,
  FamilyRoomState,
  personalBookContributions,
} from "../domain/biography";
import type { ShiguangAppOptions } from "../app";
import { CLOUD_AI_ENABLED } from "../config/runtime";
import { requestAiConsent } from "./aiConsent";

interface CloudBiographyResult {
  title?: unknown;
  paragraphs?: unknown;
  sourceCount?: unknown;
  generatedAt?: unknown;
  generationMode?: unknown;
}

function isCloudBiographyResult(value: unknown): value is BiographyDraft {
  if (!value || typeof value !== "object") return false;
  const result = value as CloudBiographyResult;
  return (
    typeof result.title === "string" &&
    Array.isArray(result.paragraphs) &&
    result.paragraphs.every((paragraph) => typeof paragraph === "string") &&
    typeof result.sourceCount === "number" &&
    typeof result.generatedAt === "string" &&
    result.generationMode === "cloud-ai"
  );
}

/** Why a candidate came from the local demo instead of the online AI. */
export type BiographyFallbackReason =
  | "cloud-disabled" | "cloud-not-ready" | "consent-declined"
  | "ai-not-configured" | "function-missing" | "timeout" | "cloud-failed" | "malformed";

function failureReason(error: unknown): BiographyFallbackReason {
  const text = String((error as { errMsg?: unknown })?.errMsg ?? (error as Error)?.message ?? error);
  if (/AI_NOT_CONFIGURED/.test(text)) return "ai-not-configured";
  if (/FUNCTION_NOT_FOUND|-501000|could not be found/i.test(text)) return "function-missing";
  if (/timed? ?out|timeout|-504003/i.test(text)) return "timeout";
  return "cloud-failed";
}

export async function generateBiography(
  state: FamilyRoomState,
  member: FamilyMember,
): Promise<BiographyDraft> {
  return (await generateBiographyWithStatus(state, member)).draft;
}

/** Organize one chapter from chosen memories, keeping the chapter's name and current text in view. */
export interface ChapterRequest {
  memoryIds: string[];
  chapterTitle?: string;
  existingText?: string;
}

export async function generateBiographyWithStatus(
  state: FamilyRoomState,
  member: FamilyMember,
  chapter?: ChapterRequest,
): Promise<{ draft: BiographyDraft; fallbackReason?: BiographyFallbackReason }> {
  const own = personalBookContributions(state.contributions, member.id);
  // Chosen ids can only narrow the member's own stories, never reach someone else's.
  const personal = chapter ? own.filter((memory) => chapter.memoryIds.includes(memory.id)) : own;
  if (personal.length === 0) {
    throw new Error(chapter ? "先勾选要整理的记忆" : "至少写下一段自己的经历后才能生成章节");
  }
  if (chapter && personal.length > 20) throw new Error("一次最多整理 20 条记忆");
  const existingText = (chapter?.existingText ?? "").slice(0, 4000);

  const app = getApp<ShiguangAppOptions>();
  let fallbackReason: BiographyFallbackReason;
  if (!CLOUD_AI_ENABLED) fallbackReason = "cloud-disabled";
  else if (!app.globalData.cloudReady || !wx.cloud) fallbackReason = "cloud-not-ready";
  else if (!await requestAiConsent()) fallbackReason = "consent-declined";
  else {
    try {
      const response = await wx.cloud.callFunction({
        name: "generateBiography",
        data: {
          protagonistName: member.name,
          memories: personal.map((memory) => ({
            id: memory.id,
            authorName: memory.authorName,
            relation: "本人",
            text: memory.text,
          })),
          ...(chapter ? { chapterTitle: chapter.chapterTitle ?? "", existingText } : {}),
        },
      });

      if (isCloudBiographyResult(response.result)) {
        return { draft: response.result };
      }

      console.warn("云函数返回格式不完整，将使用本地草稿");
      fallbackReason = "malformed";
    } catch (error) {
      console.warn("AI 云生成不可用，将使用本地草稿");
      fallbackReason = failureReason(error);
    }
  }

  return {
    draft: chapter
      ? buildLocalChapterDraft(personal, existingText, chapter.chapterTitle)
      : buildLocalPersonalBiographyDraft(member.name, member.id, state.contributions),
    fallbackReason,
  };
}
