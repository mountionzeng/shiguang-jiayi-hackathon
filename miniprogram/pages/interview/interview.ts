import {
  createContribution,
  MAX_MEMORY_LENGTH,
  VISIBILITY_LABELS,
  Visibility,
} from "../../domain/biography";
import {
  DIMENSION_LABELS,
  InterviewDimension,
  nextInterviewPrompt,
  pickSharedQuestion,
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
  role: "interviewer" | "member";
  text: string;
  dimensionLabel: string;
}

const THINKING_DELAY_MS = 420;

Page({
  data: {
    protagonistName: "",
    memberName: "",
    memberRelation: "",
    isElder: false,

    messages: [] as MessageView[],
    askedDimensions: [] as InterviewDimension[],
    answers: [] as string[],

    inputText: "",
    remaining: MAX_MEMORY_LENGTH,
    asking: false,
    scrollIntoView: "",

    stage: "chat" as "chat" | "save",
    draftText: "",
    draftLength: 0,
    tooLong: false,
    visibility: "family" as Visibility,
    familyLabel: VISIBILITY_LABELS.family,
    privateLabel: VISIBILITY_LABELS.private,
    saving: false,

    keyboardHeight: 0,
    localDemoOnly: !CLOUD_AI_ENABLED,
  },

  messageSeq: 0,

  onLoad() {
    const state = loadRoomState();
    const member = loadCurrentMember(state);
    const isElder = member.role === "elder";
    const question = pickSharedQuestion(sharedQuestionSeed());

    const opening = isElder
      ? `${question.text}\n（这是今天全家的同一个问题，你就当讲给孩子们听。）`
      : `${question.text}\n（说说你记得的${state.protagonistName}，想到哪儿说到哪儿。）`;

    this.setData({
      protagonistName: state.protagonistName,
      memberName: member.name,
      memberRelation: member.relation,
      isElder,
    });

    this.pushMessage("interviewer", opening, "今天的问题");
  },

  onUnload() {
    wx.disableAlertBeforeUnload();
  },

  pushMessage(role: MessageView["role"], text: string, dimensionLabel = "") {
    this.messageSeq += 1;
    const id = `msg-${this.messageSeq}`;
    const messages = this.data.messages.concat([{ id, role, text, dimensionLabel }]);
    this.setData({ messages, scrollIntoView: id });
  },

  onInput(event: { detail: { value: string } }) {
    const inputText = event.detail.value;
    this.setData({
      inputText,
      remaining: Math.max(0, MAX_MEMORY_LENGTH - inputText.length),
    });
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
    this.pushMessage("member", answer);
    this.setData({
      answers,
      inputText: "",
      remaining: MAX_MEMORY_LENGTH,
      asking: true,
    });
    wx.enableAlertBeforeUnload({ message: "这段讲述还没有保存，确定要离开吗？" });

    // 本地规则引擎：每轮只挑一个还没问过的方向，且不连着问同一个方向。
    const prompt = nextInterviewPrompt({
      answer,
      askedDimensions: this.data.askedDimensions,
    });

    setTimeout(() => {
      this.setData({
        asking: false,
        askedDimensions: this.data.askedDimensions.concat([prompt.dimension]),
      });
      this.pushMessage("interviewer", prompt.text, DIMENSION_LABELS[prompt.dimension]);
    }, THINKING_DELAY_MS);
  },

  finish() {
    if (this.data.answers.length === 0) {
      wx.showToast({ title: "还没有讲述内容", icon: "none" });
      return;
    }

    // 本地演示整理只做原话拼接，不改写、不补写，界面上如实说明。
    const draftText = this.data.answers.join(" ");
    this.setData({
      stage: "save",
      draftText,
      draftLength: draftText.length,
      tooLong: draftText.length > MAX_MEMORY_LENGTH,
    });
  },

  backToChat() {
    this.setData({ stage: "chat" });
  },

  onDraftInput(event: { detail: { value: string } }) {
    const draftText = event.detail.value;
    this.setData({
      draftText,
      draftLength: draftText.length,
      tooLong: draftText.length > MAX_MEMORY_LENGTH,
    });
  },

  chooseVisibility(event: { currentTarget: { dataset: { visibility: Visibility } } }) {
    this.setData({ visibility: event.currentTarget.dataset.visibility });
  },

  save() {
    if (this.data.saving) return;
    this.setData({ saving: true });

    try {
      const state = loadRoomState();
      const member = loadCurrentMember(state);
      const contribution = createContribution({
        authorMemberId: member.id,
        authorName: member.name,
        relation: member.relation,
        text: this.data.draftText,
        visibility: this.data.visibility,
      });
      appendContribution(contribution, state);
      wx.disableAlertBeforeUnload();

      const message =
        this.data.visibility === "private"
          ? `已保存，只有${state.protagonistName}看得到`
          : `已保存，等${state.protagonistName}确认后家人才看得到`;

      wx.showToast({ title: message, icon: "none", duration: 2400 });
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
