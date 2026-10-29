/**
 * 就地小忆共享机制：一套问答/整理逻辑给 book（章节正文）、interview（记忆保存阶段）、
 * archive（记忆编辑器）三处复用，避免同样的代码在每个页面各写一份。
 *
 * 核心原则（用户 2026-09-29 明确要求）：不管是提问、帮写作、找素材还是给建议，
 * 都要从用户自己已经写下/说出的文本出发。提问、整理原话、写成一段可分别触发，
 * 不读取本机制以外的素材；生成结果经用户确认后落回正文。
 *
 * 每个宿主页面自己实现：
 * - openXiaoyi/closeXiaoyi（各页打开条件不同）与上下文捕获（编辑器选区 / 草稿 / 记忆正文）；
 * - xiaoyiConfig()：这次问答要带的场景参数；
 * - xiaoyiContextText()：当前应该读的文本；
 * - xiaoyiLand(text, kind)：把用户的原话或整理稿落回到该页自己的正文承载结构。
 *
 * 本模块只实现三处完全一致的部分：问一个问题、记录对话、整理刚给的回答、调用落回。
 */
import { MemoryType } from "../domain/biography";
import { CLOUD_FOLLOW_UP_LABEL, FOLLOW_UP_LABEL, InterviewDimension, InterviewMode, InterviewTurn, QUOTA_EXHAUSTED_FOLLOW_UP_LABEL } from "../domain/interview";
import { generateInterviewPrompt } from "./interviewService";
import { organizeInlineAnswer } from "./memoryOrganizerService";

export type XiaoyiMessageKind = "question" | "answer" | "draft" | "status";
export interface XiaoyiMessage { id: string; kind: XiaoyiMessageKind; text: string; label?: string }
export type XiaoyiLandKind = "spoken" | "organized";

export interface XiaoyiPanelData {
  xiaoyiOpen: boolean;
  xiaoyiLoading: boolean;
  xiaoyiContextPreview: string;
  xiaoyiAnswer: string;
  xiaoyiDraftText: string;
  xiaoyiWritingInstruction: string;
  xiaoyiStatus: string;
  xiaoyiMessages: XiaoyiMessage[];
}

/** 三处页面 data() 的就地小忆字段初值，字段名统一，避免拼错。 */
export function initialXiaoyiPanelData(): XiaoyiPanelData {
  return {
    xiaoyiOpen: false, xiaoyiLoading: false, xiaoyiContextPreview: "",
    xiaoyiAnswer: "", xiaoyiDraftText: "", xiaoyiWritingInstruction: "",
    xiaoyiStatus: "", xiaoyiMessages: [],
  };
}

export interface XiaoyiConfig {
  memoryType?: MemoryType;
  storyTitle?: string;
  storyId?: string;
  mode?: InterviewMode;
  memberName?: string;
}

/** 宿主页面（book/interview/archive）需要满足的最小接口。 */
export interface XiaoyiHost {
  data: XiaoyiPanelData & Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  xiaoyiAskedDimensions: InterviewDimension[];
  xiaoyiConversation: InterviewTurn[];
  /** 这次问答要带的场景参数（故事名、记忆类型等）。 */
  xiaoyiConfig(): XiaoyiConfig;
  /** 当前应该读的文本：选区、草稿或已保存记忆的正文。 */
  xiaoyiContextText(): string;
  /** Stable document identity; source text alone cannot distinguish identical drafts. */
  xiaoyiContextKey?(): string;
  /** 把原话或整理稿落回该页自己的正文承载结构；返回是否成功落回。 */
  xiaoyiLand(text: string, kind: XiaoyiLandKind): Promise<boolean>;
}

const requests = new WeakMap<XiaoyiHost, object>();
const draftContexts = new WeakMap<XiaoyiHost, string>();
function contextKey(host: XiaoyiHost): string {
  return JSON.stringify([host.xiaoyiContextKey?.() ?? "", host.xiaoyiContextText().trim()]);
}
function beginRequest(host: XiaoyiHost) {
  const token = {};
  const context = contextKey(host);
  const answer = host.data.xiaoyiAnswer;
  const instruction = host.data.xiaoyiWritingInstruction;
  requests.set(host, token);
  const unchanged = () => contextKey(host) === context
    && host.data.xiaoyiAnswer === answer && host.data.xiaoyiWritingInstruction === instruction;
  return {
    context,
    current: () => requests.get(host) === token && unchanged(),
    finish: () => {
      if (requests.get(host) !== token) return;
      requests.delete(host);
      host.setData({ xiaoyiLoading: false,
        ...(!unchanged() ? { xiaoyiStatus: "输入或正文已有变化，请重新生成。" } : {}),
      });
    },
  };
}

/** 关闭面板时清空的字段，三处一致。 */
export function resetXiaoyiPanel(this: XiaoyiHost) {
  // Context switches may invalidate an in-flight request even though the close button is disabled.
  requests.delete(this);
  draftContexts.delete(this);
  this.xiaoyiAskedDimensions = [];
  this.xiaoyiConversation = [];
  this.setData({ ...initialXiaoyiPanelData() });
}

export function xiaoyiMessagesAppend(this: XiaoyiHost, message: Omit<XiaoyiMessage, "id">) {
  const id = `xiaoyi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  this.setData({ xiaoyiMessages: [...this.data.xiaoyiMessages, { id, ...message }] });
}

export async function askXiaoyiQuestion(this: XiaoyiHost) {
  if (this.data.xiaoyiLoading) return;
  const contextText = this.xiaoyiContextText().trim();
  const answer = this.data.xiaoyiAnswer.trim();
  if (!contextText && !answer) {
    this.setData({ xiaoyiStatus: "先写一句，或者直接告诉小忆你卡在哪里。" });
    return;
  }
  const request = beginRequest(this);
  this.setData({ xiaoyiLoading: true, xiaoyiStatus: "小忆正在想一个贴着这段文字的问题…" });
  try {
    const config = this.xiaoyiConfig();
    // sourceText already carries the editor excerpt; do not also store it as a user turn.
    const conversation: InterviewTurn[] = [...this.xiaoyiConversation];
    const prompt = await generateInterviewPrompt({
      answer: answer || contextText,
      askedDimensions: this.xiaoyiAskedDimensions,
      mode: config.mode ?? "personal",
      memoryType: config.memoryType ?? "memoir",
      memberName: config.memberName,
      storyTitle: config.storyTitle,
      storyId: config.storyId,
      previousAnswers: [],
      conversation,
      sourceOnly: true,
      sourceText: contextText,
      replyIntent: "question",
    });
    if (!request.current()) return;
    const label = prompt.generationMode === "cloud-ai" ? CLOUD_FOLLOW_UP_LABEL
      : prompt.fallbackReason === "moderation-quota-exhausted" ? QUOTA_EXHAUSTED_FOLLOW_UP_LABEL : FOLLOW_UP_LABEL;
    this.xiaoyiAskedDimensions = [...this.xiaoyiAskedDimensions, prompt.dimension];
    const lastAnswer = [...conversation].reverse().find(turn => turn.role === "user");
    if (answer && lastAnswer?.text !== answer) {
      conversation.push({ role: "user", text: answer });
      xiaoyiMessagesAppend.call(this, { kind: "answer", text: answer });
    }
    this.xiaoyiConversation = [...conversation, { role: "assistant", text: prompt.text }];
    xiaoyiMessagesAppend.call(this, { kind: "question", text: prompt.text, label });
    this.setData({ xiaoyiStatus: "" });
  } catch {
    if (request.current()) this.setData({ xiaoyiStatus: "小忆刚刚走神了，请再试一次。" });
  } finally {
    request.finish();
  }
}

export function onXiaoyiAnswerInput(this: XiaoyiHost, event: { detail: { value: string } }) {
  // The native input owns its live value/cursor, especially during IME dictation.
  // Keep the latest value for actions without replaying it through setData.
  this.data.xiaoyiAnswer = event.detail.value;
}
export function onXiaoyiDraftInput(this: XiaoyiHost, event: { detail: { value: string } }) {
  this.data.xiaoyiDraftText = event.detail.value;
}
export function onXiaoyiWritingInstruction(this: XiaoyiHost, event: { detail: { value: string } }) {
  this.data.xiaoyiWritingInstruction = event.detail.value;
}

export async function useXiaoyiOriginal(this: XiaoyiHost) {
  if (this.data.xiaoyiLoading) return;
  const answer = this.data.xiaoyiAnswer.trim();
  if (!answer) { wx.showToast({ title: "先回答一句吧", icon: "none" }); return; }
  this.xiaoyiConversation = [...this.xiaoyiConversation, { role: "user", text: answer }];
  xiaoyiMessagesAppend.call(this, { kind: "answer", text: answer });
  await this.xiaoyiLand(answer, "spoken");
}

export async function organizeXiaoyiAnswer(this: XiaoyiHost, event?: { currentTarget?: { dataset?: { mode?: string } } }) {
  const answer = this.data.xiaoyiAnswer.trim();
  if (!answer || this.data.xiaoyiLoading) { if (!answer) wx.showToast({ title: "先在下面写一句素材", icon: "none" }); return; }
  const writingMode = event?.currentTarget?.dataset?.mode === "compose" ? "compose" : "polish";
  const basisText = this.xiaoyiContextText().trim();
  const request = beginRequest(this);
  this.setData({ xiaoyiLoading: true, xiaoyiStatus: writingMode === "compose" ? "小忆正在把你的素材写成一段…" : "小忆正在整理你的原话…" });
  try {
    const config = this.xiaoyiConfig();
    const draft = await organizeInlineAnswer({
      answer,
      memoryType: config.memoryType ?? "memoir",
      memberName: config.memberName,
      storyTitle: config.storyTitle,
      writingMode,
      writingInstruction: this.data.xiaoyiWritingInstruction.trim(),
      // Keep just the nearby editor excerpt; the generated text is inserted, never replaces it.
      basisText: basisText.slice(-500),
      conversation: this.xiaoyiConversation.slice(-10).map(turn => ({ role: turn.role, content: turn.text })),
    });
    if (!request.current()) return;
    if (!draft) {
      this.setData({ xiaoyiStatus: "这次没有生成可用草稿，你的素材还在。可以重试，也可以直接使用原话。" });
      return;
    }
    this.xiaoyiConversation = [...this.xiaoyiConversation, { role: "user", text: answer }];
    xiaoyiMessagesAppend.call(this, { kind: "answer", text: answer });
    xiaoyiMessagesAppend.call(this, { kind: "draft", text: draft.body, label: writingMode === "compose" ? "小忆成文 · 文字 AI 生成" : "小忆只整理了你的回答" });
    draftContexts.set(this, request.context);
    this.setData({ xiaoyiDraftText: draft.body, xiaoyiStatus: "这段可以继续改，满意后再放进去。" });
  } catch {
    if (request.current()) this.setData({ xiaoyiStatus: "这次没写好，你的素材还在，可以再试一次。" });
  } finally {
    request.finish();
  }
}

export async function useXiaoyiDraft(this: XiaoyiHost) {
  if (this.data.xiaoyiLoading) return;
  const text = this.data.xiaoyiDraftText.trim();
  if (!text) { wx.showToast({ title: "还没有整理好的文字", icon: "none" }); return; }
  if (draftContexts.get(this) !== contextKey(this)) {
    this.setData({ xiaoyiDraftText: "", xiaoyiStatus: "当前正文已变化，请重新生成草稿。" });
    return;
  }
  await this.xiaoyiLand(text, "organized");
}
