import type { ShiguangAppOptions } from "../app";
import {
  InterviewDimension,
  InterviewMode,
  InterviewPrompt,
  nextInterviewPrompt,
} from "../domain/interview";
import { CLOUD_AI_ENABLED } from "../config/runtime";

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
  return Boolean(app.globalData.cloudReady);
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
    }),
    generationMode: "local-fallback",
    fallbackReason,
  };
}

export interface GenerateInterviewPromptInput {
  answer: string;
  askedDimensions: InterviewDimension[];
  mode?: InterviewMode;
  memberName?: string;
  storyTitle?: string;
  previousAnswers?: string[];
}

export async function generateInterviewPrompt(
  input: GenerateInterviewPromptInput,
): Promise<InterviewPrompt> {
  if (!canUseCloudAi()) return localFallbackPrompt(input, "cloud-not-ready");

  try {
    const response = await wx.cloud.callFunction({
      name: "chatInterview",
      data: {
        answer: input.answer,
        askedDimensions: input.askedDimensions,
        mode: input.mode ?? "personal",
        memberName: input.memberName,
        storyTitle: input.storyTitle,
        previousAnswers: input.previousAnswers ?? [],
      },
    });

    if (isCloudInterviewResult(response.result)) {
      return {
        dimension: response.result.dimension,
        text: response.result.text.trim(),
        generationMode: "cloud-ai",
      };
    }

    console.warn("AI 追问返回格式不完整，将使用本地追问规则", response.result);
    return localFallbackPrompt(input, "invalid-result");
  } catch (error) {
    console.warn("AI 追问不可用，将使用本地追问规则", error);
    return localFallbackPrompt(input, "function-error");
  }
}
