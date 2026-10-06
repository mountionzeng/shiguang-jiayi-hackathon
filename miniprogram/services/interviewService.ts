import type { ShiguangAppOptions } from "../app";
import { logServiceFailure } from './serviceFailure';
import {
  MemoryType,
} from "../domain/biography";
import {
  InterviewDimension,
  InterviewMode,
  InterviewPrompt,
  InterviewTurn,
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
  // The local client has no semantic model. Keep the fallback honest and tied
  // to the user's words instead of cycling through unrelated fact dimensions.
  const templates = [
    "你刚才这句话里，最想留下来的是哪个意思？",
    "这句话对你来说，最贴近的是哪一部分？",
    "你愿意从这句话里的哪个词或意思接着说？",
  ];
  const answer = input.answer.trim();
  const wantsPause = /(?:^|[，。！？,!?\s])(?:(?:今天|这次)?(?:就|先)?到这里(?:吧|了|就好|就行)?|(?:今天|现在)?(?:先)?不聊了|我(?:想|要)(?:先)?(?:歇|休息)(?:一会儿|一会)?)[。！!，,\s]*$/.test(answer);
  const wantsRecordOnly = /(?:只想|只要|就想)(?:把)?(?:这(?:句|段)话)?(?:记下|记录(?:下来)?|留下)(?:就好|就行|吧)?[。！!\s]*$/.test(answer);
  return {
    dimension: "feeling",
    text: wantsPause ? "好，我们先停在这里。" : wantsRecordOnly ? "好，这里先不追问。" : templates[input.askedDimensions.length % templates.length],
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
    logServiceFailure('chatInterview', 'ai', error);
    console.warn("AI 追问不可用，将使用本地追问规则");
    const failure = error as { code?: unknown; errMsg?: unknown; message?: unknown } | undefined;
    if (failure?.code === "AI_CONTENT_CHECK_QUOTA_EXHAUSTED" || /AI_CONTENT_CHECK_QUOTA_EXHAUSTED|内容安全检查额度已用完/.test(String(failure?.errMsg || failure?.message || ""))) {
      return localFallbackPrompt(input, "moderation-quota-exhausted");
    }
    return localFallbackPrompt(input, "function-error");
  }
}
