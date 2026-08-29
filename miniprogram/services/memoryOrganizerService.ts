import type { ShiguangAppOptions } from "../app";
import {
  MemoryType,
  normalizeMemoryText,
  OrganizationMode,
} from "../domain/biography";
import { draftTitleFromAnswers } from "../domain/interview";
import { CLOUD_AI_ENABLED } from "../config/runtime";

export interface OrganizedMemoryDraft {
  title: string;
  summary: string;
  body: string;
  emotions: string[];
  people: string[];
  places: string[];
  memoryType: MemoryType;
  generationMode: OrganizationMode;
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
}

function canUseCloudAi(): boolean {
  if (!CLOUD_AI_ENABLED || !wx.cloud || typeof getApp !== "function") return false;
  const app = getApp<ShiguangAppOptions>();
  return Boolean(app.globalData.cloudReady);
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
  if (typeof draft.body !== "string" || !draft.body.trim()) return undefined;

  return {
    title: typeof draft.title === "string" && draft.title.trim()
      ? draft.title.trim().slice(0, 24)
      : fallback.title,
    summary: typeof draft.summary === "string" && draft.summary.trim()
      ? draft.summary.trim().slice(0, 40)
      : fallback.summary,
    body: draft.body.trim().slice(0, 500),
    emotions: normalizeTags(draft.emotions, fallback.memoryType === "note" ? 2 : 5),
    people: normalizeTags(draft.people, 8),
    places: normalizeTags(draft.places, 8),
    memoryType: isMemoryType(draft.memoryType) ? draft.memoryType : fallback.memoryType,
    generationMode: draft.generationMode === "cloud-ai" ? "cloud-ai" : "local-demo",
  };
}

export interface OrganizeMemoryInput {
  transcript: string[];
  memoryType: MemoryType;
  memberName?: string;
  storyTitle?: string;
}

export async function organizeMemory(
  input: OrganizeMemoryInput,
): Promise<OrganizedMemoryDraft> {
  const transcript = input.transcript.map((item) => item.trim()).filter(Boolean);
  const fallback = localOrganizedDraft(transcript, input.memoryType);
  if (!canUseCloudAi()) return fallback;

  try {
    const response = await wx.cloud.callFunction({
      name: "organizeMemory",
      data: {
        transcript,
        memoryType: input.memoryType,
        memberName: input.memberName,
        storyTitle: input.storyTitle,
      },
    });
    const cloudDraft = parseCloudDraft(response.result, fallback);
    if (cloudDraft) return cloudDraft;
    console.warn("AI 整理返回格式不完整，将保留原话草稿", response.result);
  } catch (error) {
    console.warn("AI 整理不可用，将保留原话草稿", error);
  }

  return fallback;
}
