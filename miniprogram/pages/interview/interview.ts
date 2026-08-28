import {
  createContribution,
  MemoryScope,
  MAX_MEMORY_LENGTH,
  MemoryType,
  Visibility,
} from "../../domain/biography";
import {
  detectCoveredDimensions,
  DIMENSION_CHIPS,
  DIMENSION_LABELS,
  draftTitleFromAnswers,
  InterviewDimension,
  InterviewMode,
  nextInterviewPrompt,
  pickInterviewQuestion,
  sharedQuestionSeed,
} from "../../domain/interview";
import { CLOUD_AI_ENABLED } from "../../config/runtime";
import {
  appendContribution,
  loadCurrentMember,
  loadRoomState,
} from "../../services/roomStorage";

interface MessageView {
  id: string;
  kind: "opening" | "followup" | "answer";
  text: string;
  label: string;
}

const THINKING_DELAY_MS = 420;

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
}

Page({
  data: {
    mode: "personal" as InterviewMode,
    isPersonal: true,
    protagonistName: "",
    memberName: "",
    memberRelation: "",
    isElder: false,

    messages: [] as MessageView[],
    askedDimensions: [] as InterviewDimension[],
    answers: [] as string[],

    inputText: "",
    asking: false,
    scrollIntoView: "",

    stage: "chat" as "chat" | "save",
    draftTitle: "",
    draftText: "",
    draftLength: 0,
    tooLong: false,
    dateLabel: "",
    coveredChips: [] as string[],

    // 「随手记 / 回忆录」沿用原型的说法，在整理时才选，入口仍然只有一个。
    memoryType: "note" as MemoryType,
    saving: false,
    saved: false,

    keyboardHeight: 0,
    localDemoOnly: !CLOUD_AI_ENABLED,
  },

  messageSeq: 0,

  onLoad(options: { mode?: string }) {
    const state = loadRoomState();
    const member = loadCurrentMember(state);
    const isElder = member.role === "elder";
    const mode: InterviewMode = options.mode === "family" ? "family" : "personal";
    const question = pickInterviewQuestion(sharedQuestionSeed(), mode);

    this.setData({
      mode,
      isPersonal: mode === "personal",
      protagonistName: mode === "personal" ? member.name : state.protagonistName,
      memberName: member.name,
      memberRelation: member.relation,
      isElder,
      dateLabel: today(),
    });

    this.pushMessage(
      "opening",
      mode === "personal"
        ? `${question.text}\n（这段只写进你自己的人生之书，请用“我”来讲。）`
        : `${question.text}\n（讲一段你和家人共同经历的事，请用“我们”来讲。）`,
    );
  },

  /**
   * 没点「整理成片段」就直接退出时，聊天记录不能白讲。
   * 个人采访自动存回自己书里；家庭采访保存为待确认的家庭记忆。
   */
  onUnload() {
    wx.disableAlertBeforeUnload();
    if (this.data.saved || this.data.answers.length === 0) return;

    try {
      const state = loadRoomState();
      const member = loadCurrentMember(state);
      appendContribution(
        createContribution({
          authorMemberId: member.id,
          authorName: member.name,
          relation: member.relation,
          text: this.data.answers.join(" ").slice(0, MAX_MEMORY_LENGTH),
          title: draftTitleFromAnswers(this.data.answers),
          memoryType: "note",
          scope: this.data.mode as MemoryScope,
          visibility: this.data.isPersonal ? "private" : "family",
        }),
        state,
      );
    } catch (error) {
      console.warn("退出时自动保存失败", error);
    }
  },

  pushMessage(kind: MessageView["kind"], text: string, label = "") {
    this.messageSeq += 1;
    const id = `msg-${this.messageSeq}`;
    this.setData({
      messages: this.data.messages.concat([{ id, kind, text, label }]),
      scrollIntoView: id,
    });
  },

  onInput(event: { detail: { value: string } }) {
    this.setData({ inputText: event.detail.value });
  },

  onKeyboardHeightChange(event: { detail: { height: number } }) {
    this.setData({ keyboardHeight: event.detail.height });
  },

  send() {
    const answer = this.data.inputText.trim();
    if (!answer) {
      wx.showToast({ title: "先说一句吧，短一点也行", icon: "none" });
      return;
    }

    const answers = this.data.answers.concat([answer]);
    this.pushMessage("answer", answer);
    this.setData({ answers, inputText: "", asking: true });

    wx.enableAlertBeforeUnload({
      message: this.data.isPersonal
        ? "现在离开的话，以上聊天记录会先保存到你自己的人生之书。"
        : "现在离开的话，以上聊天记录会先保存为待确认的家庭记忆。",
    });

    // 本地规则引擎：每轮只挑一个还没问过的方向，且不连着问同一个。
    const prompt = nextInterviewPrompt({
      answer,
      askedDimensions: this.data.askedDimensions,
      mode: this.data.mode,
    });

    setTimeout(() => {
      this.setData({
        asking: false,
        askedDimensions: this.data.askedDimensions.concat([prompt.dimension]),
      });
      this.pushMessage("followup", prompt.text, DIMENSION_LABELS[prompt.dimension]);
    }, THINKING_DELAY_MS);
  },

  finish() {
    if (this.data.answers.length === 0) {
      wx.showToast({ title: "还没有讲述内容", icon: "none" });
      return;
    }

    // 本地演示整理只做原话拼接，不改写、不补写，界面上如实说明。
    const draftText = this.data.answers.join(" ");
    const covered = detectCoveredDimensions(draftText);

    this.setData({
      stage: "save",
      draftTitle: draftTitleFromAnswers(this.data.answers),
      draftText,
      draftLength: draftText.length,
      tooLong: draftText.length > MAX_MEMORY_LENGTH,
      coveredChips: covered.map((dimension) => DIMENSION_CHIPS[dimension]),
    });
  },

  backToChat() {
    this.setData({ stage: "chat" });
  },

  onTitleInput(event: { detail: { value: string } }) {
    this.setData({ draftTitle: event.detail.value });
  },

  onDraftInput(event: { detail: { value: string } }) {
    const draftText = event.detail.value;
    this.setData({
      draftText,
      draftLength: draftText.length,
      tooLong: draftText.length > MAX_MEMORY_LENGTH,
    });
  },

  chooseType(event: { currentTarget: { dataset: { type: MemoryType } } }) {
    this.setData({ memoryType: event.currentTarget.dataset.type });
  },

  notYet() {
    wx.showToast({ title: "照片和语音赛后接入", icon: "none" });
  },

  save() {
    if (this.data.saving) return;
    this.setData({ saving: true });

    try {
      const state = loadRoomState();
      const member = loadCurrentMember(state);
      const visibility: Visibility = this.data.isPersonal ? "private" : "family";
      appendContribution(
        createContribution({
          authorMemberId: member.id,
          authorName: member.name,
          relation: member.relation,
          text: this.data.draftText,
          title: this.data.draftTitle,
          memoryType: this.data.memoryType,
          scope: this.data.mode as MemoryScope,
          visibility,
        }),
        state,
      );

      this.setData({ saved: true });
      wx.disableAlertBeforeUnload();
      wx.showToast({
        title: this.data.isPersonal
          ? "已存进我的人生之书"
          : "已存进记忆之家，等待确认",
        icon: "none",
        duration: 2400,
      });
      setTimeout(() => wx.navigateBack(), 900);
    } catch (error) {
      this.setData({ saving: false });
      wx.showToast({
        title: error instanceof Error ? error.message : "暂时无法保存",
        icon: "none",
      });
    }
  },
});
