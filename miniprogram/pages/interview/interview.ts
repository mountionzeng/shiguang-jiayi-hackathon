import {
  createContribution,
  MAX_MEMORY_LENGTH,
  Visibility,
} from "../../domain/biography";
import {
  detectCoveredDimensions,
  DIMENSION_CHIPS,
  DIMENSION_LABELS,
  draftTitleFromAnswers,
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

    visibility: "family" as Visibility,
    saving: false,
    saved: false,

    keyboardHeight: 0,
    localDemoOnly: !CLOUD_AI_ENABLED,
  },

  messageSeq: 0,

  onLoad() {
    const state = loadRoomState();
    const member = loadCurrentMember(state);
    const isElder = member.role === "elder";
    const question = pickSharedQuestion(sharedQuestionSeed());

    this.setData({
      protagonistName: state.protagonistName,
      memberName: member.name,
      memberRelation: member.relation,
      isElder,
      dateLabel: today(),
    });

    this.pushMessage(
      "opening",
      isElder
        ? `${question.text}\n（这是今天全家的同一个问题，你就当讲给孩子们听。）`
        : `${question.text}\n（说说你记得的${state.protagonistName}，想到哪儿说到哪儿。）`,
    );
  },

  /**
   * 没点「整理成片段」就直接退出时，聊天记录不能白讲。
   * 这里自动存成"只给老人看"的回忆片段：这是最保守的可见范围，
   * 不会在讲述人没做选择的情况下把内容摊给其他家人。
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
          visibility: "private",
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
      message: `现在离开的话，以上聊天记录会先为你保存成「只给${this.data.protagonistName}看」的回忆片段。想让家人也看到，请回去点「整理成片段」。`,
    });

    // 本地规则引擎：每轮只挑一个还没问过的方向，且不连着问同一个。
    const prompt = nextInterviewPrompt({
      answer,
      askedDimensions: this.data.askedDimensions,
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

  chooseVisibility(event: { currentTarget: { dataset: { visibility: Visibility } } }) {
    this.setData({ visibility: event.currentTarget.dataset.visibility });
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
      appendContribution(
        createContribution({
          authorMemberId: member.id,
          authorName: member.name,
          relation: member.relation,
          text: this.data.draftText,
          visibility: this.data.visibility,
        }),
        state,
      );

      this.setData({ saved: true });
      wx.disableAlertBeforeUnload();
      wx.showToast({
        title:
          this.data.visibility === "private"
            ? `已保存，只有${state.protagonistName}看得到`
            : `已保存，等${state.protagonistName}确认后家人才看得到`,
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
