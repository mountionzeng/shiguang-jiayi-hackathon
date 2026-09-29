/**
 * 就地小忆共享机制：一套问答/整理逻辑给 book（章节正文）、interview（记忆保存阶段）、
 * archive（记忆编辑器）三处复用，避免同样的代码在每个页面各写一份。
 *
 * 核心原则（用户 2026-09-29 明确要求）：不管是提问、帮写作、找素材还是给建议，
 * 都要从用户自己已经写下/说出的文本出发——这里只做「读当前文本 → 给一个贴着它的问题 →
 * 只整理用户刚给的回答」，不读取本机制以外的素材，不做通用助手。
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
  xiaoyiCanOrganize: boolean;
  xiaoyiStatus: string;
  xiaoyiMessages: XiaoyiMessage[];
}

/** 三处页面 data() 的就地小忆字段初值，字段名统一，避免拼错。 */
export function initialXiaoyiPanelData(): XiaoyiPanelData {
  return {
    xiaoyiOpen: false, xiaoyiLoading: false, xiaoyiContextPreview: "",
    xiaoyiAnswer: "", xiaoyiDraftText: "", xiaoyiCanOrganize: false,
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
  /** 把原话或整理稿落回该页自己的正文承载结构；返回是否成功落回。 */
  xiaoyiLand(text: string, kind: XiaoyiLandKind): Promise<boolean>;
}

/** 关闭面板时清空的字段，三处一致。 */
export function resetXiaoyiPanel(this: XiaoyiHost) {
  if (this.data.xiaoyiLoading) return;
  this.xiaoyiAskedDimensions = [];
  this.xiaoyiConversation = [];
  this.setData({ xiaoyiOpen: false, xiaoyiAnswer: "", xiaoyiDraftText: "", xiaoyiStatus: "", xiaoyiMessages: [] });
}

export function xiaoyiMessagesAppend(this: XiaoyiHost, message: Omit<XiaoyiMessage, "id">) {
  const id = `xiaoyi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  this.setData({ xiaoyiMessages: [...this.data.xiaoyiMessages, { id, ...message }] });
}

export async function askXiaoyiQuestion(this: XiaoyiHost, event?: { currentTarget?: { dataset?: { mode?: string } } }) {
  if (this.data.xiaoyiLoading) return;
  const mode = event?.currentTarget?.dataset?.mode === "write" ? "write" : "ask";
  const contextText = this.xiaoyiContextText().trim();
  const answer = this.data.xiaoyiAnswer.trim();
  if (!contextText && !answer) {
    this.setData({ xiaoyiStatus: "先写一句，或者直接告诉小忆你卡在哪里。" });
    return;
  }
  this.setData({ xiaoyiLoading: true, xiaoyiStatus: mode === "write" ? "小忆会先问一个问题，不会直接替你写。" : "小忆正在想一个贴着这段文字的问题…" });
  try {
    const config = this.xiaoyiConfig();
    const conversation: InterviewTurn[] = this.xiaoyiConversation.length
      ? [...this.xiaoyiConversation]
      : contextText ? [{ role: "user", text: contextText }] : [];
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
    });
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
    this.setData({ xiaoyiStatus: mode === "write" ? "先回答这个问题，再让小忆整理你的回答。" : "", xiaoyiCanOrganize: prompt.generationMode === "cloud-ai" });
  } catch {
    this.setData({ xiaoyiStatus: "小忆刚刚走神了，请再试一次。" });
  } finally {
    this.setData({ xiaoyiLoading: false });
  }
}

export function onXiaoyiAnswerInput(this: XiaoyiHost, event: { detail: { value: string } }) {
  this.setData({ xiaoyiAnswer: event.detail.value });
}
export function onXiaoyiDraftInput(this: XiaoyiHost, event: { detail: { value: string } }) {
  this.setData({ xiaoyiDraftText: event.detail.value });
}

export async function useXiaoyiOriginal(this: XiaoyiHost) {
  const answer = this.data.xiaoyiAnswer.trim();
  if (!answer) { wx.showToast({ title: "先回答一句吧", icon: "none" }); return; }
  this.xiaoyiConversation = [...this.xiaoyiConversation, { role: "user", text: answer }];
  xiaoyiMessagesAppend.call(this, { kind: "answer", text: answer });
  await this.xiaoyiLand(answer, "spoken");
}

export async function organizeXiaoyiAnswer(this: XiaoyiHost) {
  const answer = this.data.xiaoyiAnswer.trim();
  if (!answer || this.data.xiaoyiLoading) { if (!answer) wx.showToast({ title: "先回答一句吧", icon: "none" }); return; }
  this.setData({ xiaoyiLoading: true, xiaoyiStatus: "小忆正在只整理你刚刚回答的话…" });
  try {
    const config = this.xiaoyiConfig();
    const draft = await organizeInlineAnswer({
      answer,
      memoryType: config.memoryType ?? "memoir",
      memberName: config.memberName,
      storyTitle: config.storyTitle,
    });
    if (!draft) {
      this.setData({ xiaoyiStatus: "小忆暂时没连上，先用你的原话更稳妥。" });
      return;
    }
    this.xiaoyiConversation = [...this.xiaoyiConversation, { role: "user", text: answer }];
    xiaoyiMessagesAppend.call(this, { kind: "answer", text: answer });
    xiaoyiMessagesAppend.call(this, { kind: "draft", text: draft.body, label: "小忆只整理了你的回答" });
    this.setData({ xiaoyiDraftText: draft.body, xiaoyiStatus: "这段可以继续改，满意后再放进去。" });
  } finally {
    this.setData({ xiaoyiLoading: false });
  }
}

export async function useXiaoyiDraft(this: XiaoyiHost) {
  const text = this.data.xiaoyiDraftText.trim();
  if (!text) { wx.showToast({ title: "还没有整理好的文字", icon: "none" }); return; }
  await this.xiaoyiLand(text, "organized");
}
