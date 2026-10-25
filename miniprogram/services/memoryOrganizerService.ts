import type { ConfirmedPhotoReference } from "./photoWritingReference";
import { measurePerformance } from "./performanceLog";
import { logServiceFailure } from './serviceFailure';
import type { ShiguangAppOptions } from "../app";
import {
  MemoryType,
  normalizeMemoryText,
  OrganizationMode,
} from "../domain/biography";
import { draftTitleFromAnswers } from "../domain/interview";
import { CLOUD_AI_ENABLED } from "../config/runtime";
import { currentConsentVersion, requestAiConsent } from "./aiConsent";

export interface WritingOptions {
  writingMode?: "polish" | "compose";
  writingInstruction?: string;
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface OrganizedMemoryDraft {
  title: string;
  summary: string;
  body: string;
  emotions: string[];
  people: string[];
  places: string[];
  memoryType: MemoryType;
  generationMode: OrganizationMode;
  fallbackReason?: "cloud-not-ready" | "consent-declined" | "request-failed";
}

interface CloudOrganizedMemoryResult {
  title?: unknown;
  summary?: unknown;
  body?: unknown;
  emotions?: unknown;
  people?: unknown;
  places?: unknown;
  memoryType?: unknown;
  generationMode?: unknown;
  photoReferenceApplied?: unknown;
}

function canUseCloudAi(): boolean {
  if (!CLOUD_AI_ENABLED || !wx.cloud || typeof getApp !== "function") return false;
  const app = getApp<ShiguangAppOptions>();
  return Boolean(app.globalData.cloudReady && app.globalData.aiReady);
}

function normalizeTags(value: unknown, maxCount: number): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.slice(0, 12)),
    ),
  ).slice(0, maxCount);
}

function localOrganizedDraft(
  transcript: string[],
  memoryType: MemoryType,
): OrganizedMemoryDraft {
  const body = normalizeMemoryText(transcript.join(" "));
  return {
    title: draftTitleFromAnswers(transcript),
    summary: body.length > 30 ? `${body.slice(0, 29)}...` : body,
    body,
    emotions: [],
    people: [],
    places: [],
    memoryType,
    generationMode: "local-demo",
  };
}

function isMemoryType(value: unknown): value is MemoryType {
  return value === "note" || value === "memoir";
}

function parseCloudDraft(
  result: unknown,
  fallback: OrganizedMemoryDraft,
): OrganizedMemoryDraft | undefined {
  if (!result || typeof result !== "object") return undefined;
  const draft = result as CloudOrganizedMemoryResult;
  if (typeof draft.body !== "string" || !draft.body.trim() || draft.body.trim().length > 500) return undefined;

  return {
    title: typeof draft.title === "string" && draft.title.trim()
      ? draft.title.trim().slice(0, 24)
      : fallback.title,
    summary: typeof draft.summary === "string" && draft.summary.trim()
      ? draft.summary.trim().slice(0, 40)
      : fallback.summary,
    body: draft.body.trim(),
    emotions: normalizeTags(draft.emotions, fallback.memoryType === "note" ? 2 : 5),
    people: normalizeTags(draft.people, 8),
    places: normalizeTags(draft.places, 8),
    memoryType: isMemoryType(draft.memoryType) ? draft.memoryType : fallback.memoryType,
    generationMode: draft.generationMode === "cloud-ai" ? "cloud-ai" : "local-demo",
  };
}

export interface OrganizeMemoryInput extends WritingOptions {
  transcript: string[];
  memoryType: MemoryType;
  memberName?: string;
  storyTitle?: string;
  useAi?: boolean;
  memoryId?: string;
  /** Editing an existing saved memory: require the cloud copy to still match this base text. */
  expectedSavedText?: string;
  photoReference?: ConfirmedPhotoReference;
  expectedSourceRevisionId?: string;
}

export interface OrganizeInlineAnswerInput extends WritingOptions {
  answer: string;
  /** Explicit user-only dialogue material, up to eight 500-character segments. */
  transcript?: string[];
  /** Current editor excerpt, for voice/continuity; never appended as new text. */
  basisText?: string;
  memoryType?: MemoryType;
  memberName?: string;
  storyTitle?: string;
}

export async function organizeMemory(
  input: OrganizeMemoryInput,
): Promise<OrganizedMemoryDraft> {
  const transcript = input.transcript.map((item) => item.trim()).filter(Boolean);
  // A failed rewrite must preserve the complete editor draft and explicit user supplements;
  // assistant conversation is kept out of transcript by callers and only sent as model context.
  const fallback = localOrganizedDraft(transcript, input.memoryType);
  if (input.useAi === false) return fallback;
  if (!input.memoryId) return fallback;
  if (!canUseCloudAi()) return { ...fallback, fallbackReason: "cloud-not-ready" };
  if (!await requestAiConsent()) return { ...fallback, fallbackReason: "consent-declined" };

  try {
    const response = await measurePerformance("ai.organize", () => wx.cloud.callFunction({
      name: "organizeMemory",
      data: {
        memoryId: input.memoryId,
        memoryType: input.memoryType,
        memberName: input.memberName,
        storyTitle: input.storyTitle,
        consentVersion: currentConsentVersion(),
        ...(input.writingMode ? { writingMode: input.writingMode } : {}),
        ...(input.writingInstruction !== undefined ? { writingInstruction: input.writingInstruction } : {}),
        ...(input.expectedSavedText !== undefined ? {
          sourceOnly: true,
          expectedText: input.expectedSavedText,
          sourceRevisionId: input.expectedSourceRevisionId,
          transcript,
          ...(input.photoReference ? {photoReference: input.photoReference} : {}),
          ...(input.conversation ? { conversation: input.conversation } : {}),
        } : {}),
      },
    }));
    if (input.photoReference && (response.result as CloudOrganizedMemoryResult | undefined)?.photoReferenceApplied !== true) {
      throw new Error("照片参考尚未得到云端确认，已保留原稿");
    }
    const cloudDraft = parseCloudDraft(response.result, fallback);
    if (cloudDraft) return cloudDraft;
    console.warn("AI 整理返回格式不完整，将保留原话草稿");
  } catch (error) {
    logServiceFailure('organizeMemory', 'ai', error);
    console.warn("AI 整理不可用，将保留原话草稿");
    return { ...fallback, fallbackReason: "request-failed" };
  }

  return { ...fallback, fallbackReason: "request-failed" };
}

export async function organizeInlineAnswer(
  input: OrganizeInlineAnswerInput,
): Promise<OrganizedMemoryDraft | undefined> {
  const transcript = input.transcript ?? [input.answer];
  if (!transcript.length || transcript.length > 8 || transcript.some(text => text.trim().length > 500)) return undefined;
  const answer = normalizeMemoryText(transcript.join('\n'));
  if (!answer || !canUseCloudAi()) return undefined;
  if (!await requestAiConsent()) return undefined;
  const fallback = localOrganizedDraft([answer], input.memoryType ?? "note");

  try {
    const response = await measurePerformance("ai.organize", () => wx.cloud.callFunction({
      name: "organizeMemory",
      data: {
        inlineAnswer: true,
        transcript: transcript.map(text => text.trim()).filter(Boolean),
        memoryType: input.memoryType ?? "note",
        memberName: input.memberName,
        storyTitle: input.storyTitle,
        consentVersion: currentConsentVersion(),
        ...(input.writingMode ? { writingMode: input.writingMode } : {}),
        ...(input.writingInstruction !== undefined ? { writingInstruction: input.writingInstruction } : {}),
        ...(input.basisText !== undefined ? { basisText: input.basisText } : {}),
        ...(input.conversation ? { conversation: input.conversation } : {}),
      },
    }));
    const cloudDraft = parseCloudDraft(response.result, fallback);
    return cloudDraft?.generationMode === "cloud-ai" ? cloudDraft : undefined;
  } catch (error) {
    logServiceFailure('organizeMemory', 'ai', error);
    console.warn("就地小忆整理不可用，将保留原话");
    return undefined;
  }
}
