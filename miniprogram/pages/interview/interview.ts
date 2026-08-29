import {
  createContribution,
  contributionScope,
  contributionStoryTitle,
  FamilyMember,
  FamilyRoomState,
  MAX_MEMORY_LENGTH,
  MemoryType,
  normalizeMemoryText,
  OrganizationMode,
} from "../../domain/biography";
import {
  detectCoveredDimensions,
  DIMENSION_CHIPS,
  DIMENSION_LABELS,
  draftTitleFromAnswers,
  InterviewDimension,
  pickInterviewQuestion,
  sharedQuestionSeed,
} from "../../domain/interview";
import { CLOUD_AI_ENABLED } from "../../config/runtime";
import { generateInterviewPrompt } from "../../services/interviewService";
import { organizeMemory } from "../../services/memoryOrganizerService";
import {
  appendContributionRemoteFirst,
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
} from "../../services/roomRepository";

interface MessageView {
  id: string;
  kind: "opening" | "followup" | "answer";
  text: string;
  label: string;
}

interface StoryOptionView {
  title: string;
  count: number;
  selected: boolean;
}

interface MemberOptionView {
  id: string;
  name: string;
  relation: string;
  avatarText: string;
  selected: boolean;
}

interface InterviewLoadOptions {
  sourceId?: string;
  storyTitle?: string;
}

function decodeQueryValue(value = ""): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return "";
  }
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
}

function storyOptionsFor(
  memories: FamilyRoomState["contributions"],
  memberId: string,
  selectedTitle: string,
): StoryOptionView[] {
  const counts = new Map<string, number>();
  memories.forEach((memory) => {
    const title = contributionStoryTitle(memory);
    if (
      memory.authorMemberId === memberId &&
      contributionScope(memory) === "personal" &&
      title
    ) {
      counts.set(title, (counts.get(title) ?? 0) + 1);
    }
  });
  return Array.from(counts.entries()).map(([title, count]) => ({
    title,
    count,
    selected: title === selectedTitle,
  }));
}

function memberOptionsFor(
  members: FamilyMember[],
  currentMemberId: string,
  selectedIds: string[] = [],
): MemberOptionView[] {
  return members
    .filter((member) => member.id !== currentMemberId)
    .map((member) => ({
      id: member.id,
      name: member.name,
      relation: member.relation,
      avatarText: member.avatarText,
      selected: selectedIds.includes(member.id),
    }));
}

/** 按 Unicode 码点分片，避免在 500 字边界把 emoji 的代理项拆成乱码。 */
function splitRecoverableText(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const symbol of text) {
    if (chunk && chunk.length + symbol.length > MAX_MEMORY_LENGTH) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += symbol;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

Page({
  data: {
    memberName: "",
    memberRelation: "",

    messages: [] as MessageView[],
    askedDimensions: [] as InterviewDimension[],
    answers: [] as string[],

    inputText: "",
    asking: false,
    organizing: false,
    scrollIntoView: "",

    stage: "choose" as "choose" | "chat" | "save",
    draftTitle: "",
    draftSummary: "",
    draftText: "",
    draftLength: 0,
    draftEmotions: [] as string[],
    draftPeople: [] as string[],
    draftPlaces: [] as string[],
    draftOrganizationMode: "local-demo" as OrganizationMode,
    tooLong: false,
    dateLabel: "",
    coveredChips: [] as string[],

    // 「随手记 / 回忆录」沿用原型的说法，在整理时才选，入口仍然只有一个。
    memoryType: "note" as MemoryType,
    storyTitle: "",
    storyOptions: [] as StoryOptionView[],
    relatedMemberIds: [] as string[],
    relatedOptions: [] as MemberOptionView[],
    audienceMemberIds: [] as string[],
    audienceOptions: [] as MemberOptionView[],
    saving: false,
    saved: false,

    keyboardHeight: 0,
    localDemoOnly: !CLOUD_AI_ENABLED,
  },

  messageSeq: 0,

  async onLoad(options: InterviewLoadOptions = {}) {
    const state = await loadRoomStateRemoteFirst();
    const member = await loadCurrentMemberRemoteFirst(state);
    const question = pickInterviewQuestion(sharedQuestionSeed(), "personal");
    const requestedStoryTitle = decodeQueryValue(options.storyTitle);
    const requestedSourceId = decodeQueryValue(options.sourceId);
    const source = state.contributions.find((memory) => (
      memory.id === requestedSourceId &&
      memory.authorMemberId === member.id &&
      contributionScope(memory) === "personal"
    ));
    const sourceStoryTitle = source ? contributionStoryTitle(source) : "";
    const storyTitle = sourceStoryTitle || requestedStoryTitle;
    const sourcePreview = source
      ? `${source.text.slice(0, 72)}${source.text.length > 72 ? "……" : ""}`
      : "";
    const opening = source
      ? storyTitle
        ? `我们继续聊「${storyTitle}」吧。\n上次你讲到：“${sourcePreview}”\n这一次，你还想补充什么？`
        : `我们接着这段往下聊吧。\n上次你讲到：“${sourcePreview}”\n后来你又想起了什么？`
      : `${question.text}\n想到自己、家人或朋友都可以。先慢慢讲，聊完后再决定放进哪个故事、谁可以看。`;

    this.setData({
      memberName: member.name,
      memberRelation: member.relation,
      stage: source || storyTitle ? "chat" : "choose",
      dateLabel: today(),
      storyTitle,
      storyOptions: storyOptionsFor(state.contributions, member.id, storyTitle),
      relatedOptions: memberOptionsFor(state.members, member.id),
      audienceOptions: memberOptionsFor(state.members, member.id),
    });

    this.pushMessage("opening", opening);
  },

  /**
   * 没点「整理成片段」就直接退出时，聊天记录不能白讲。
   * 未完成归档时先存为只有自己可见的片段，避免强迫用户过早分类。
   */
  onUnload() {
    wx.disableAlertBeforeUnload();
    const unsentText = this.data.inputText.trim();
    const rawAnswers = this.data.answers.concat(unsentText ? [unsentText] : []);
    if (this.data.saved || rawAnswers.length === 0) return;

    void this.saveRecoverableAnswers(rawAnswers);
  },

  async saveRecoverableAnswers(rawAnswers: string[]) {
    try {
      const currentState = await loadRoomStateRemoteFirst();
      const member = await loadCurrentMemberRemoteFirst(currentState);
      const recoverableText = normalizeMemoryText(
        this.data.stage === "save" && this.data.draftText
          ? this.data.draftText
          : rawAnswers.join(" ")
      );
      const chunks = splitRecoverableText(recoverableText);

      for (const text of chunks) {
        await appendContributionRemoteFirst(createContribution({
          authorMemberId: member.id,
          authorName: member.name,
          relation: member.relation,
          text,
          title: chunks.length === 1
            ? this.data.draftTitle || draftTitleFromAnswers(rawAnswers)
            : draftTitleFromAnswers([text]),
          memoryType: "note",
          preserveNormalizedText: true,
          scope: "personal",
          visibility: "private",
        }));
      }
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
    const inputText = event.detail.value;
    this.setData({ inputText });
    if (inputText.trim()) {
      wx.enableAlertBeforeUnload({
        message: "现在离开的话，尚未发送的文字也会先存进未整理片段，仅你可见。",
      });
    } else if (this.data.answers.length === 0) {
      wx.disableAlertBeforeUnload();
    }
  },

  onKeyboardHeightChange(event: { detail: { height: number } }) {
    this.setData({ keyboardHeight: event.detail.height });
  },

  async send() {
    const answer = this.data.inputText.trim();
    if (!answer) {
      wx.showToast({ title: "先说一句吧，短一点也行", icon: "none" });
      return;
    }

    const answers = this.data.answers.concat([answer]);
    this.pushMessage("answer", answer);
    this.setData({ answers, inputText: "", asking: true });

    wx.enableAlertBeforeUnload({
      message: "现在离开的话，以上聊天会先存进你的未整理片段，仅你可见。",
    });

    try {
      const prompt = await generateInterviewPrompt({
        answer,
        askedDimensions: this.data.askedDimensions,
        mode: "personal",
        memberName: this.data.memberName,
        storyTitle: this.data.storyTitle,
        previousAnswers: this.data.answers,
      });
      this.setData({
        asking: false,
        askedDimensions: this.data.askedDimensions.concat([prompt.dimension]),
      });
      this.pushMessage(
        "followup",
        prompt.text,
        DIMENSION_LABELS[prompt.dimension],
      );
    } catch (error) {
      console.warn("生成追问失败", error);
      this.setData({ asking: false });
      wx.showToast({ title: "暂时问不出来，稍后再试", icon: "none" });
    }
  },

  async finish() {
    if (this.data.organizing) return;
    const unsentText = this.data.inputText.trim();
    const answers = this.data.answers.concat(unsentText ? [unsentText] : []);
    if (answers.length === 0) {
      wx.showToast({ title: "还没有讲述内容", icon: "none" });
      return;
    }

    this.setData({ organizing: true });
    try {
      const draft = await organizeMemory({
        transcript: answers,
        memoryType: this.data.memoryType,
        memberName: this.data.memberName,
        storyTitle: this.data.storyTitle,
      });
      const covered = detectCoveredDimensions(draft.body);

      this.setData({
        stage: "save",
        answers,
        inputText: "",
        draftTitle: draft.title || draftTitleFromAnswers(answers),
        draftSummary: draft.summary,
        draftText: draft.body,
        draftLength: draft.body.length,
        draftEmotions: draft.emotions,
        draftPeople: draft.people,
        draftPlaces: draft.places,
        draftOrganizationMode: draft.generationMode,
        tooLong: draft.body.length > MAX_MEMORY_LENGTH,
        coveredChips: covered.map((dimension) => DIMENSION_CHIPS[dimension]),
      });
    } finally {
      this.setData({ organizing: false });
    }
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

  beginInterview() {
    this.setData({ stage: "chat" });
  },

  chooseFragment() {
    this.setData({
      storyTitle: "",
      storyOptions: this.data.storyOptions.map((option) => ({
        ...option,
        selected: false,
      })),
    });
  },

  chooseStory(event: { currentTarget: { dataset: { title: string } } }) {
    const storyTitle = event.currentTarget.dataset.title;
    this.setData({
      storyTitle,
      storyOptions: this.data.storyOptions.map((option) => ({
        ...option,
        selected: option.title === storyTitle,
      })),
    });
  },

  onStoryTitleInput(event: { detail: { value: string } }) {
    const storyTitle = event.detail.value;
    this.setData({
      storyTitle,
      storyOptions: this.data.storyOptions.map((option) => ({
        ...option,
        selected: option.title === storyTitle.trim(),
      })),
    });
  },

  toggleRelatedMember(event: { currentTarget: { dataset: { id: string } } }) {
    const memberId = event.currentTarget.dataset.id;
    const relatedMemberIds = this.data.relatedMemberIds.includes(memberId)
      ? this.data.relatedMemberIds.filter((id) => id !== memberId)
      : this.data.relatedMemberIds.concat(memberId);
    this.setData({
      relatedMemberIds,
      relatedOptions: this.data.relatedOptions.map((option) => ({
        ...option,
        selected: relatedMemberIds.includes(option.id),
      })),
    });
  },

  choosePrivate() {
    this.setData({
      audienceMemberIds: [],
      audienceOptions: this.data.audienceOptions.map((option) => ({
        ...option,
        selected: false,
      })),
    });
  },

  toggleAudienceMember(event: { currentTarget: { dataset: { id: string } } }) {
    const memberId = event.currentTarget.dataset.id;
    const audienceMemberIds = this.data.audienceMemberIds.includes(memberId)
      ? this.data.audienceMemberIds.filter((id) => id !== memberId)
      : this.data.audienceMemberIds.concat(memberId);
    this.setData({
      audienceMemberIds,
      audienceOptions: this.data.audienceOptions.map((option) => ({
        ...option,
        selected: audienceMemberIds.includes(option.id),
      })),
    });
  },

  notYet() {
    wx.showToast({ title: "照片和语音赛后接入", icon: "none" });
  },

  async save() {
    if (this.data.saving) return;
    this.setData({ saving: true });

    try {
      const state = await loadRoomStateRemoteFirst();
      const member = await loadCurrentMemberRemoteFirst(state);
      const availableMemberIds = new Set(
        state.members
          .filter((candidate) => candidate.id !== member.id)
          .map((candidate) => candidate.id),
      );
      const selectedMemberIds = this.data.relatedMemberIds.concat(
        this.data.audienceMemberIds,
      );
      if (selectedMemberIds.some((memberId) => !availableMemberIds.has(memberId))) {
        throw new Error("有亲友已不在当前空间，请重新选择");
      }
      await appendContributionRemoteFirst(
        createContribution({
          authorMemberId: member.id,
          authorName: member.name,
          relation: member.relation,
          text: this.data.draftText,
          title: this.data.draftTitle,
          summary: this.data.draftSummary,
          emotions: this.data.draftEmotions,
          people: this.data.draftPeople,
          places: this.data.draftPlaces,
          organizationMode: this.data.draftOrganizationMode,
          memoryType: this.data.memoryType,
          storyTitle: this.data.storyTitle,
          relatedMemberIds: this.data.relatedMemberIds,
          sharedWithMemberIds: this.data.audienceMemberIds,
          scope: "personal",
          visibility: "private",
        }),
      );

      this.setData({ saved: true });
      wx.disableAlertBeforeUnload();
      wx.showToast({
        title: this.data.storyTitle.trim()
          ? `已放进「${this.data.storyTitle.trim()}」`
          : "已存入未整理片段",
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
