import type { ShiguangAppOptions } from "../app";
import {
  MemoryType,
} from "../domain/biography";
import {
  InterviewDimension,
  InterviewMode,
  InterviewPrompt,
  InterviewTurn,
  nextInterviewPrompt,
} from "../domain/interview";
import { CLOUD_AI_ENABLED } from "../config/runtime";
import { requestAiConsent } from "./aiConsent";

interface CloudInterviewResult {
  dimension?: unknown;
  text?: unknown;
}

const INTERVIEW_DIMENSIONS = new Set<InterviewDimension>([
  "person",
  "time",
  "place",
  "event",
  "feeling",
]);

function isCloudInterviewResult(value: unknown): value is InterviewPrompt {
  if (!value || typeof value !== "object") return false;
  const result = value as CloudInterviewResult;
  return (
    typeof result.text === "string" &&
    result.text.trim().length > 0 &&
    typeof result.dimension === "string" &&
    INTERVIEW_DIMENSIONS.has(result.dimension as InterviewDimension)
  );
}

function canUseCloudAi(): boolean {
  if (!CLOUD_AI_ENABLED || !wx.cloud || typeof getApp !== "function") return false;
  const app = getApp<ShiguangAppOptions>();
  return Boolean(app.globalData.cloudReady && app.globalData.aiReady);
}

function localFallbackPrompt(
  input: GenerateInterviewPromptInput,
  fallbackReason: InterviewPrompt["fallbackReason"],
): InterviewPrompt {
  return {
    ...nextInterviewPrompt({
      answer: input.answer,
      askedDimensions: input.askedDimensions,
      mode: input.mode,
      previousAnswers: input.previousAnswers,
    }),
    generationMode: "local-fallback",
    fallbackReason,
  };
}

export interface GenerateInterviewPromptInput {
  answer: string;
  askedDimensions: InterviewDimension[];
  mode?: InterviewMode;
  memoryType?: MemoryType;
  memberName?: string;
  storyTitle?: string;
  storyId?: string;
  /** 本轮之前的回答，不含 answer。 */
  previousAnswers?: string[];
  /** 本轮之前小忆问过的话和用户的回答，按顺序排列。 */
  conversation?: InterviewTurn[];
  /** 仅当前被编辑的这段记忆；共创对话时不读取其他记忆上下文。 */
  sourceText?: string;
  sourceOnly?: boolean;
}

export async function generateInterviewPrompt(
  input: GenerateInterviewPromptInput,
): Promise<InterviewPrompt> {
  if (!canUseCloudAi()) return localFallbackPrompt(input, "cloud-not-ready");
  if (!await requestAiConsent()) return localFallbackPrompt(input, "cloud-not-ready");

  try {
    const response = await wx.cloud.callFunction({
      name: "chatInterview",
      data: {
        answer: input.answer,
        askedDimensions: input.askedDimensions,
        mode: input.mode ?? "personal",
        memoryType: input.memoryType ?? "note",
        memberName: input.memberName,
        storyTitle: input.storyTitle,
        storyId: input.storyId,
        previousAnswers: input.previousAnswers ?? [],
        conversation: input.conversation ?? [],
        ...(input.sourceText !== undefined ? { sourceText: input.sourceText } : {}),
        ...(input.sourceOnly === true ? { sourceOnly: true } : {}),
      },
    });

    if (isCloudInterviewResult(response.result)) {
      return {
        dimension: response.result.dimension,
        text: response.result.text.trim(),
        generationMode: "cloud-ai",
      };
    }

    console.warn("AI 追问返回格式不完整，将使用本地追问规则");
    return localFallbackPrompt(input, "invalid-result");
  } catch (error) {
    console.warn("AI 追问不可用，将使用本地追问规则");
    return localFallbackPrompt(input, "function-error");
  }
}
