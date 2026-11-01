import {
  accountOwner,
  appendAiRevision,
  createContribution,
  contributionScope,
  contributionStoryTitle,
  FamilyMember,
  FamilyRoomState,
  isActiveMember,
  MAX_MEMORY_LENGTH,
  memoryAiLabel,
  memoryAiRevisions,
  MemoryContribution,
  memoryPool,
  MemoryType,
  normalizeMemoryText,
  OrganizationMode,
} from "../../domain/biography";
import {
  detectCoveredDimensions,
  DIMENSION_CHIPS,
  draftTitleFromAnswers,
  CLOUD_FOLLOW_UP_LABEL,
  FOLLOW_UP_LABEL,
  INTERVIEW_DIMENSIONS,
  InterviewDimension,
  InterviewTurn,
  QUOTA_EXHAUSTED_FOLLOW_UP_LABEL,
  pickInterviewQuestion,
  sharedQuestionSeed,
} from "../../domain/interview";
import { generateInterviewPrompt } from "../../services/interviewService";
import { organizeMemory } from "../../services/memoryOrganizerService";
import {
  askXiaoyiQuestion, initialXiaoyiPanelData, onXiaoyiAnswerInput, onXiaoyiDraftInput, onXiaoyiWritingInstruction, organizeXiaoyiAnswer,
  resetXiaoyiPanel, useXiaoyiDraft, useXiaoyiOriginal, XiaoyiConfig, XiaoyiLandKind, xiaoyiMessagesAppend,
} from "../../services/xiaoyiCompanion";
import {
  appendContributionRemoteFirst,
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  roomDataModeLabel,
} from "../../services/roomRepository";
import { loadSharedFamilyRoom, submitSharedContribution } from "../../services/familyInviteService";
import { readLocalPhotos } from "../../services/bookImages";
import { ImportFileLike } from "../../services/memoryImport";
import { activeStory, linkStoryMemories } from "../../services/storyBooks";
import { storyShelf } from "../../services/storyShelf";
import {recordCaptureAudio,stopCaptureAudio,cancelCaptureAudio} from '../../services/captureAudio';
import {readCaptureSession,pendingCaptureDrafts,assertCaptureScope,loadCaptureDraft,storeCaptureDraft,stageCaptureFiles,sendMemoryCapture,continueMemoryCapture,saveCaptureOriginal,captureAudioUrl,type MemoryCaptureDraft,type MemoryCaptureReceipt} from '../../services/memoryCapture';

interface CaptureMessageView extends MemoryCaptureReceipt {photoPaths:string[];localStatus?:''|'sending'|'failed'}

interface MessageView {
  id: string;
  kind: "opening" | "followup" | "answer";
  text: string;
  label: string;
}

interface StoryOptionView {
  key: string;
  storyId?: string;
  memberId?: string;
  chapterCount?: number;
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
  captureId?: string;
  capture?: string;
  storyId?: string;
  sourceId?: string;
  storyTitle?: string;
  memoryType?: string;
  /** 首页推荐问：点进来后小忆第一句就问这个。 */
  question?: string;
  dimension?: string;
  familyId?: string;
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

/** 故事属于整个记忆库，不管是谁讲的，都能接着放进同一个故事。 */
function storyOptionsFor(
  memories: FamilyRoomState["contributions"],
  selectedTitle: string,
  familyMode = false,
  deletedTitles: string[] = [],
): StoryOptionView[] {
  const counts = new Map<string, number>();
  const hidden = new Set(deletedTitles);
  (familyMode ? memories : memoryPool(memories)).forEach((memory) => {
    const title = contributionStoryTitle(memory);
    if (title && !hidden.has(title) && (!familyMode || contributionScope(memory) === "family")) {
      counts.set(title, (counts.get(title) ?? 0) + 1);
    }
  });
  return Array.from(counts.entries()).map(([title, count]) => ({
    key: `story:${title}`, title,
    count,
    selected: title === selectedTitle,
  }));
}

/** 「涉及的人」「谁可以看」：除了你自己，其他人都可以选。 */
function memberOptionsFor(
  members: FamilyMember[],
  authorId: string,
  selectedIds: string[] = [],
): MemberOptionView[] {
  return members
    .filter((member) => member.id !== authorId && isActiveMember(member))
    .map((member) => ({
      id: member.id,
      name: member.name,
      relation: member.relation,
      avatarText: member.avatarText,
      selected: selectedIds.includes(member.id),
    }));
}

/**
 * 这台手机上讲的都记在账号主人名下，不分是谁讲的（用户说讲述人标签没有意义）；
 * 家人想自己讲，以后用邀请在他们自己的微信里讲。
 */
function authorFor(state: FamilyRoomState, fallback: FamilyMember): FamilyMember {
  return accountOwner(state.members) ?? fallback;
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
    captureDraft: null as MemoryCaptureDraft | null,
    captureReceipts: [] as CaptureMessageView[],
    captureSessionId: '',
    captureMemoryId: '',
    captureReadOnly: false,
    capturePending: [] as Array<{id:string;sessionId?:string;label:string}>,
    captureBusy: false,
    captureRecording: false,
    captureEntry: false,
    captureError: '',
    captureExpandedId: '',
    memberName: "",
    memberRelation: "",

    messages: [] as MessageView[],
    askedDimensions: [] as InterviewDimension[],
    answers: [] as string[],

    inputText: "",
    asking: false,
    organizing: false,
    scrollIntoView: "",

    // 先等档案读完再决定显示哪一屏，免得从首页进来时先闪一下「选择讲述方式」。
    stage: "loading" as "loading" | "choose" | "chat" | "save",
    draftTitle: "",
    draftSummary: "",
    draftAiLabel: "",
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
    selectedStoryKey: "",
    storyId: "", writingMode: "creative" as "objective" | "creative",
    storyOptions: [] as StoryOptionView[],
    relatedMemberIds: [] as string[],
    relatedOptions: [] as MemberOptionView[],
    audienceMemberIds: [] as string[],
    audienceOptions: [] as MemberOptionView[],
    saving: false,
    saved: false,
    saveMessage: "",
    saveError: "",
    ...initialXiaoyiPanelData(),
    storageLabel: "",

    keyboardHeight: 0,
    sharedFamilyId: "",
    importing: false,

  },

  messageSeq: 0,
  sourceText: "",
  pendingContribution: undefined as MemoryContribution | undefined,
  persistedContributionId: "",
  interviewUnloaded: false,
  capturePlayer: undefined as WechatMiniprogram.InnerAudioContext | undefined,
  xiaoyiAskedDimensions: [] as InterviewDimension[],
  xiaoyiConversation: [] as InterviewTurn[],

  async onLoad(options: InterviewLoadOptions = {}) {
    this.interviewUnloaded = false;
    try {
    const sharedFamilyId = decodeQueryValue(options.familyId);
    const captureEntry = (options.capture === "1" || !!options.captureId) && !sharedFamilyId;
    const requestedSourceId = decodeQueryValue(options.sourceId);
    const shared = sharedFamilyId ? await loadSharedFamilyRoom(sharedFamilyId) : undefined;
    // 首页只提供摘要；指定记忆续聊必须读取完整正文，再按 ID 限定本次来源。
    const state = shared?.state ?? await loadRoomStateRemoteFirst({ view: requestedSourceId ? "memories" : "home" });
    const member = shared
      ? state.members.find(candidate => candidate.id === shared.viewerMemberId)
      : authorFor(state, await loadCurrentMemberRemoteFirst(state));
    if (!member) throw new Error("成员身份已失效，请重新接受邀请");
    if (!member.id) {
      wx.showToast({ title: "先写下你的名字，就可以开始聊了", icon: "none" });
      wx.redirectTo({ url: "/pages/profiles/profiles?mode=new-book" });
      return;
    }
    const question = pickInterviewQuestion(sharedQuestionSeed(), sharedFamilyId ? "family" : "personal");
    const requestedStoryTitle = decodeQueryValue(options.storyTitle);
    const requestedStoryId = decodeQueryValue(options.storyId);
    const requestedStory = !sharedFamilyId && requestedStoryId
      ? (state.stories ?? []).find(story => story.id === requestedStoryId && !story.deletedAt)
      : undefined;
    if (requestedStoryId && !requestedStory) throw new Error("这本故事书已不可用");
    const requestedMemoryType: MemoryType | undefined =
      options.memoryType === "memoir"
        ? "memoir"
        : options.memoryType === "note"
          ? "note"
          : undefined;
    // 记忆库是共用的：接着聊的那一段可以是任何人讲的。
    const source = (sharedFamilyId ? state.contributions : memoryPool(state.contributions)).find((memory) => (
      memory.id === requestedSourceId &&
      !memory.deletedAt &&
      (!sharedFamilyId || (
        memory.authorMemberId === member.id && contributionScope(memory) === "family"
      ))
    ));
    if (requestedSourceId && !source) throw new Error("这段记忆已不可用");
    const sourceStoryTitle = source ? contributionStoryTitle(source) : "";
    const storyTitle = requestedStory?.title || sourceStoryTitle || requestedStoryTitle;
    let sourceText = source?.text || "";
    let sourceMediaNote = "";
    if (source?.materialCaptureId && !sharedFamilyId) {
      const session = await readCaptureSession(source.materialCaptureId);
      if (this.interviewUnloaded) return;
      if (!Array.isArray(session.items) || session.items.some(item => item.memoryId && item.memoryId !== source.id)) {
        throw new Error("原素材与这段记忆不一致，请重新打开");
      }
      const originals = session.items.filter(item => item.memoryId === source.id);
      if (!originals.length) throw new Error("这段记忆的原素材暂未读到，请重新打开");
      sourceText = originals.map(item => item.text.trim()).filter(Boolean).join("\n\n");
      if (originals.some(item => item.photoIds.length || item.audio.length)) {
        sourceMediaNote = "附带的图片或录音尚未分析，不推断其中的内容；可以请用户说明想聊的部分。";
      }
    }
    const sourcePreview = `${sourceText.slice(0, 72)}${sourceText.length > 72 ? "……" : ""}`;
    this.sourceText = [sourceMediaNote, sourceText].filter(Boolean).join("\n\n");
    // 从首页推荐问点进来时，第一句就是用户刚才点的那个问题，不换成泛泛的“后来你又想起了什么”。
    const requestedQuestion = decodeQueryValue(options.question).slice(0, 80);
    const requestedDimension = INTERVIEW_DIMENSIONS.find(
      (dimension) => dimension === options.dimension,
    );
    const continuation = requestedQuestion ||
      (storyTitle ? "这一次，你还想补充什么？" : "后来你又想起了什么？");
    const opening = captureEntry
      ? "把这一刻先记下来吧。文字、照片、录音可以一起发，也可以分几次补充，都会保存在这段记忆里。想聊或整理时，再叫我。"
      : source
      ? !sourceText && sourceMediaNote
        ? "这段图片或录音已经保存。你想先聊其中的什么？"
        : storyTitle
        ? `我们继续聊「${storyTitle}」吧。\n上次你讲到：“${sourcePreview}”\n${continuation}`
        : `我们接着这段往下聊吧。\n上次你讲到：“${sourcePreview}”\n${continuation}`
      : requestedMemoryType === "note"
        ? "先把这一刻想到的留下来吧。几句话也可以，聊完后再决定放进哪个故事。"
        : `${requestedQuestion || question.text}\n想到自己、家人或朋友都可以。先慢慢讲，聊完后再决定放进哪个故事。`;

    this.setData({
      captureEntry,
      memberName: member.name,
      memberRelation: member.relation,
      sharedFamilyId,
      stage: captureEntry || source || storyTitle || requestedMemoryType ? "chat" : "choose",
      memoryType: requestedMemoryType ?? this.data.memoryType,
      askedDimensions: requestedQuestion && requestedDimension ? [requestedDimension] : [],
      dateLabel: today(),
      storyTitle,
      storyId: requestedStory?.id || "",
      writingMode: requestedStory?.writingMode || "creative",
      selectedStoryKey: requestedStory?.id || "",
      storyOptions: sharedFamilyId
        ? storyOptionsFor(state.contributions, storyTitle, true, (state.deletedStories ?? []).map(story => story.title))
        : storyShelf(state).filter(item => !state.stories?.some(story => story.id === item.storyId && story.sourcePolicyRequired)).map(item => ({
          key: item.key, storyId: item.storyId, memberId: item.storyId ? undefined : item.manuscriptMemberId,
          title: item.title, count: item.memoryIds.length, chapterCount: item.chapterCount,
          selected: requestedStory ? item.storyId === requestedStory.id : false,
        })),
      relatedOptions: memberOptionsFor(state.members, member.id),
      audienceOptions: memberOptionsFor(state.members, member.id),
    });

    this.pushMessage("opening", opening);
    if(captureEntry){
      wx.setNavigationBarTitle({title:'随手记'});
      if(options.captureId)await this.restoreCaptureSession(decodeQueryValue(options.captureId));
      if(!this.data.captureDraft && !this.data.captureReadOnly)await this.stageCapture([]);
      await this.refreshPendingCaptures();
    }
    } catch (error) {
      wx.showModal({ title: "暂时无法加载", content: "请返回后重新打开，不会切换到另一份本地数据。", showCancel: false, success: () => wx.navigateBack() });
    }
  },

  /**
   * 没点「整理成片段」就直接退出时，聊天记录不能白讲。
   * 未完成归档时先存为只有自己可见的片段，避免强迫用户过早分类。
   */
  onUnload() {
    this.interviewUnloaded = true;
    cancelCaptureAudio();
    this.capturePlayer?.destroy();
    if(this.data.captureDraft && !this.data.captureDraft.submitted)void storeCaptureDraft({...this.data.captureDraft,composerText:this.data.inputText});
    if(this.data.captureEntry || this.data.captureDraft || this.data.captureBusy)return;
    wx.disableAlertBeforeUnload();
    const unsentText = this.data.inputText.trim();
    const rawAnswers = this.data.answers.concat(unsentText ? [unsentText] : []);
    if (this.data.saved || this.data.saving || rawAnswers.length === 0) return;

    void this.saveRecoverableAnswers(rawAnswers);
  },

  async saveRecoverableAnswers(rawAnswers: string[]) {
    try {
      const recoverableText = normalizeMemoryText(
        this.data.stage === "save" && this.data.draftText
          ? this.data.draftText
          : rawAnswers.join(" "),
      );
      // 已经先存过原话/整理稿（finish() persist-first）：更新同一条记忆，不再新建，
      // 避免退出时把「刚整理完」和「又聊了几句」拆成两条。超长时仍走下面的分片新建。
      if (this.pendingContribution && recoverableText.length <= MAX_MEMORY_LENGTH) {
        if (!this.data.sharedFamilyId) {
          const state = await loadRoomStateRemoteFirst();
          const saved = state.contributions.find(item => item.id === this.pendingContribution!.id && !item.deletedAt);
          if (!saved && this.persistedContributionId === this.pendingContribution.id) return;
          if (saved) this.pendingContribution = {...this.pendingContribution, photoIds:saved.photoIds};
        }
        const updated = { ...this.pendingContribution, text: recoverableText };
        if (this.data.sharedFamilyId) await submitSharedContribution(this.data.sharedFamilyId, updated);
        else await appendContributionRemoteFirst(updated);
        this.pendingContribution = updated;
        return;
      }
      const shared = this.data.sharedFamilyId ? await loadSharedFamilyRoom(this.data.sharedFamilyId) : undefined;
      const state = shared?.state ?? await loadRoomStateRemoteFirst();
      const member = shared
        ? state.members.find(candidate => candidate.id === shared.viewerMemberId)
        : authorFor(state, await loadCurrentMemberRemoteFirst(state));
      if (!member) throw new Error("成员身份已失效");
      const chunks = splitRecoverableText(recoverableText);

      for (const text of chunks) {
        const contribution = createContribution({
          authorMemberId: member.id,
          authorName: member.name,
          relation: member.relation,
          text,
          title: chunks.length === 1
            ? this.data.draftTitle || draftTitleFromAnswers(rawAnswers)
            : draftTitleFromAnswers([text]),
          memoryType: this.data.memoryType,
          preserveNormalizedText: true,
          scope: this.data.sharedFamilyId ? "family" : "personal",
          visibility: this.data.sharedFamilyId ? "family" : "private",
        });
        if (this.data.sharedFamilyId) await submitSharedContribution(this.data.sharedFamilyId, contribution);
        else await appendContributionRemoteFirst(contribution);
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
    // Keep the native keyboard in charge while composing (including voice IME).
    // setData is reserved for explicit seeds/resets, never input echo.
    this.data.inputText = inputText;
    if(this.data.captureDraft && !this.data.captureDraft.submitted) {this.data.captureDraft.composerText=inputText;void storeCaptureDraft(this.data.captureDraft);}
    if (inputText.trim()) {
      wx.enableAlertBeforeUnload({
        message: "退出时会尝试保存。为避免网络失败，请先完成保存并确认成功。",
      });
    } else if (this.data.answers.length === 0) {
      wx.disableAlertBeforeUnload();
    }
  },

  onKeyboardHeightChange(event: { detail: { height: number } }) {
    this.setData({ keyboardHeight: event.detail.height });
  },

  async send() {
    if(this.data.captureReadOnly)return;
    if(this.data.captureEntry){
      if(this.data.captureBusy || this.data.importing || this.data.captureRecording)return;
      if(!this.data.captureDraft)await this.stageCapture([]);
      if(this.data.captureDraft)await this.sendCapture();
      return;
    }
    if(this.data.captureDraft){await this.sendCapture();return;}
    if (this.data.asking || this.data.organizing || this.data.importing || this.data.saving) return;
    const answer = this.data.inputText.trim();
    if (!answer) {
      wx.showToast({ title: "先说一句吧，短一点也行", icon: "none" });
      return;
    }

    const previousAnswers = this.data.answers;
    // 小忆问过的话也要交给 AI，它才知道哪些已经问过、用户已经答过。
    const conversation: InterviewTurn[] = this.data.messages.map((message) => ({
      role: message.kind === "answer" ? "user" : "assistant",
      text: message.text,
    }));
    const answers = previousAnswers.concat([answer]);
    this.pushMessage("answer", answer);
    this.setData({ answers, inputText: "", asking: true });

    wx.enableAlertBeforeUnload({
      message: "退出时会尝试保存。为避免网络失败，请先完成保存并确认成功。",
    });

    try {
      const prompt = await generateInterviewPrompt({
        answer,
        askedDimensions: this.data.askedDimensions,
        mode: this.data.sharedFamilyId ? "family" : "personal",
        memoryType: this.data.memoryType,
        memberName: this.data.memberName,
        storyTitle: this.data.storyTitle,
        // Both entry points can guide the user's own answers without reading or rewriting an objective book.
        storyId: this.data.writingMode === "objective" ? undefined : this.data.storyId,
        previousAnswers,
        conversation,
        ...(this.sourceText ? {sourceText: this.sourceText, sourceOnly: true} : {}),
      });
      this.setData({
        asking: false,
        askedDimensions: this.data.askedDimensions.concat([prompt.dimension]),
      });
      const label = prompt.generationMode === "cloud-ai" ? CLOUD_FOLLOW_UP_LABEL
        : prompt.fallbackReason === "moderation-quota-exhausted" ? QUOTA_EXHAUSTED_FOLLOW_UP_LABEL : FOLLOW_UP_LABEL;
      this.pushMessage("followup", prompt.text, label);
    } catch (error) {
      console.warn("追问生成失败", error);
      this.setData({ asking: false });
      wx.showToast({ title: "小忆刚刚走神了，再试一次", icon: "none" });
    }
  },

  /**
   * 先存原话再整理：不管 AI 整理成不成功，answers 先落一条 spoken 记忆并拿到
   * memoryId——这样 organizeMemory 才能按 ID 在服务端读到本人原话（见
   * memoryOrganizerService.ts），AI 不可用/失败时原话也已经保存，不会丢。
   */
  async persistSpokenAnswers(answers: string[]): Promise<MemoryContribution> {
    const shared = this.data.sharedFamilyId ? await loadSharedFamilyRoom(this.data.sharedFamilyId) : undefined;
    const state = shared?.state ?? await loadRoomStateRemoteFirst();
    const member = shared
      ? state.members.find(candidate => candidate.id === shared.viewerMemberId)
      : authorFor(state, await loadCurrentMemberRemoteFirst(state));
    if (!member) throw new Error("成员身份已失效，请重新接受邀请");

    const spokenText = normalizeMemoryText(answers.join(" "));
    if (this.pendingContribution && !this.data.sharedFamilyId) {
      const saved = state.contributions.find(item => item.id === this.pendingContribution!.id && !item.deletedAt);
      if (!saved && this.persistedContributionId === this.pendingContribution.id) throw new Error('这段记忆已变动，请重新打开');
      if (saved) this.pendingContribution = {...this.pendingContribution, photoIds:saved.photoIds};
    }
    const base = this.pendingContribution ?? createContribution({
      authorMemberId: member.id,
      authorName: member.name,
      relation: member.relation,
      text: spokenText,
      title: draftTitleFromAnswers(answers),
      memoryType: this.data.memoryType,
      storyTitle: this.data.storyTitle,
      relatedMemberIds: this.data.relatedMemberIds,
      sharedWithMemberIds: this.data.sharedFamilyId ? [] : this.data.audienceMemberIds,
      scope: this.data.sharedFamilyId ? "family" : "personal",
      visibility: this.data.sharedFamilyId ? "family" : "private",
    });
    const contribution = this.pendingContribution
      ? appendAiRevision(base, "spoken", spokenText, base.title, base.organizationMode)
      : base;

    if (this.data.sharedFamilyId) await submitSharedContribution(this.data.sharedFamilyId, contribution);
    else await appendContributionRemoteFirst(contribution, {learn:false});
    this.pendingContribution = contribution;
    this.persistedContributionId = contribution.id;
    return contribution;
  },

  async finish() {
    if (this.data.organizing || this.data.asking || this.data.importing || this.data.saving) return;
    const unsentText = this.data.inputText.trim();
    const answers = this.data.answers.concat(unsentText ? [unsentText] : []);
    if (answers.length === 0) {
      wx.showToast({ title: "还没有讲述内容", icon: "none" });
      return;
    }

    this.setData({ organizing: true });

    try {
      const spoken = await this.persistSpokenAnswers(answers);
      const draft = await organizeMemory({
        transcript: [spoken.text],
        memoryType: this.data.memoryType,
        memberName: this.data.memberName,
        storyTitle: this.data.storyTitle,
        // The organizer authorizes personal memories; shared-family records stay as spoken text.
        useAi: this.data.writingMode === "creative" && !this.data.sharedFamilyId,
        memoryId: spoken.id,
        expectedSavedText: spoken.text,
        writingMode: "compose",
        conversation: this.data.messages.slice(-10).map(message => ({
          role: message.kind === "answer" ? "user" as const : "assistant" as const,
          content: message.text,
        })),
      });
      const covered = detectCoveredDimensions(draft.body);

      if (draft.generationMode === "cloud-ai") {
        this.pendingContribution = appendAiRevision(spoken, "ai", draft.body, draft.title, draft.generationMode);
      }

      this.setData({
        stage: "save",
        answers,
        inputText: "",
        draftTitle: draft.title,
        draftSummary: draft.summary,
        draftAiLabel: this.pendingContribution ? memoryAiLabel(this.pendingContribution) : "",
        draftText: draft.body,
        draftLength: draft.body.length,
        draftEmotions: draft.emotions,
        draftPeople: draft.people,
        draftPlaces: draft.places,
        draftOrganizationMode: draft.generationMode,
        tooLong: draft.body.length > MAX_MEMORY_LENGTH,
        coveredChips: covered.map((dimension) => DIMENSION_CHIPS[dimension]),
      });
    } catch (error) {
      console.warn("整理成片段失败", error);
      wx.showToast({ title: "暂时无法整理，请稍后再试", icon: "none" });
    } finally {
      this.setData({ organizing: false });
    }
  },

  backToChat() {
    this.setData({ stage: "chat" });
  },

  openXiaoyi() {
    if (this.data.stage !== "save" || this.data.saving || this.data.saved) return;
    const text = this.data.draftText.trim();
    this.setData({
      xiaoyiOpen: true,
      xiaoyiStatus: "",
      xiaoyiContextPreview: text ? (text.length > 100 ? text.slice(0, 100) + "…" : text) : "这段记忆还没写正文，小忆会从你接下来要说的话问起。",
    });
  },
  closeXiaoyi: resetXiaoyiPanel,
  /** 就地小忆共享机制要读的场景参数。 */
  xiaoyiConfig(): XiaoyiConfig {
    return {
      memoryType: this.data.memoryType,
      memberName: this.data.memberName,
      storyTitle: this.data.storyTitle,
      storyId: this.data.writingMode === "objective" ? undefined : this.data.storyId,
      mode: this.data.sharedFamilyId ? "family" : "personal",
    };
  },
  /** 就地小忆共享机制要读的当前文本：这段记忆正在写的草稿。 */
  xiaoyiContextText() {
    return this.data.draftText.trim();
  },
  xiaoyiContextKey() { return [this.data.storyId, this.data.sharedFamilyId, this.pendingContribution?.id ?? "new"].join(":"); },
  xiaoyiMessagesAppend,
  askXiaoyiQuestion,
  onXiaoyiAnswerInput,
  onXiaoyiDraftInput,
  onXiaoyiWritingInstruction,
  useXiaoyiOriginal,
  organizeXiaoyiAnswer,
  useXiaoyiDraft,
  /** 就地小忆共享机制的落回目标：接到这段记忆的草稿末尾，保存时才真正持久化。 */
  xiaoyiLand(text: string): Promise<boolean> {
    const next = normalizeMemoryText([this.data.draftText.trim(), text.trim()].filter(Boolean).join("\n\n"));
    const previewLabel = this.pendingContribution ? memoryAiLabel({ ...this.pendingContribution, text: next }) : this.data.draftAiLabel;
    this.setData({ draftText: next, draftLength: next.length, tooLong: next.length > MAX_MEMORY_LENGTH, draftAiLabel: previewLabel, xiaoyiAnswer: "", xiaoyiDraftText: "", xiaoyiStatus: "已接到草稿后面，你还可以继续改。" });
    return Promise.resolve(true);
  },

  onTitleInput(event: { detail: { value: string } }) {
    this.data.draftTitle = event.detail.value;
  },

  onDraftInput(event: { detail: { value: string } }) {
    const draftText = event.detail.value;
    // 手改之后立刻打「已由你修改」，避免用户等到点保存才看到标签变化；
    // 真正的 manual revision 记录在 save() 里追加，这里只是显示态。
    const previewLabel = this.pendingContribution
      ? memoryAiLabel({ ...this.pendingContribution, text: draftText })
      : this.data.draftOrganizationMode === "cloud-ai" ? "文字 AI 生成 · 已由你修改" : "";
    this.data.draftText = draftText;
    this.setData({
      draftAiLabel: previewLabel,
      draftLength: draftText.length,
      tooLong: draftText.length > MAX_MEMORY_LENGTH,
    });
  },

  chooseType(event: { currentTarget: { dataset: { type: MemoryType } } }) {
    this.setData({ memoryType: event.currentTarget.dataset.type });
  },

  beginInterview() {
    if(this.data.memoryType==='note' && !this.data.sharedFamilyId){wx.redirectTo({url:'/pages/interview/interview?capture=1'});return;}
    this.setData({ stage: "chat" });
  },

  chooseFragment() {
    this.setData({
      storyTitle: "", storyId: "", selectedStoryKey: "",
      storyOptions: this.data.storyOptions.map((option) => ({
        ...option,
        selected: false,
      })),
    });
  },

  chooseStory(event: { currentTarget: { dataset: { key?: string; title?: string } } }) {
    const { key, title } = event.currentTarget.dataset;
    const selected = this.data.storyOptions.find(option => key ? option.key === key : option.title === title);
    if (!selected) return;
    this.setData({
      storyTitle: selected.title, storyId: selected.storyId || "", selectedStoryKey: this.data.sharedFamilyId ? "" : selected.key,
      storyOptions: this.data.storyOptions.map(option => ({ ...option, selected: option.key === selected.key })),
    });
  },

  onStoryTitleInput(event: { detail: { value: string } }) {
    this.data.storyTitle = event.detail.value;
    this.setData({
      storyId: "", selectedStoryKey: "",
      storyOptions: this.data.storyOptions.map(option => ({ ...option, selected: false })),
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

  importMemory() {
    if (this.data.importing) return;
    if (this.data.sharedFamilyId) {
      wx.showToast({ title: "请回到自己的记忆里导入", icon: "none" });
      return;
    }
    wx.showActionSheet({
      itemList: ["从相册或拍照选照片", "从微信聊天选文件", "AI生成配图", "录一段声音", "把输入文字整理成记忆"],
      success: result => {
        if (result.tapIndex === 0) void this.importFromAlbum();
        if (result.tapIndex === 1) void this.importFromMessage();
        if (result.tapIndex === 2) void this.generateMemoryPhotos();
        if (result.tapIndex === 3) void this.recordCapture();
        if (result.tapIndex === 4) void this.startTextCapture();
      },
    });
  },

  async generateMemoryPhotos() {
    if (this.data.importing || this.data.organizing || this.data.asking || this.data.saving || this.data.sharedFamilyId) return;
    this.setData({importing:true});
    try {
      const unsent = this.data.inputText.trim();
      const answers = this.data.answers.concat(unsent ? [unsent] : []);
      if (this.data.stage !== 'save' && !answers.length) {
        wx.showToast({title:'先写几句回忆，再请小忆配图', icon:'none'}); return;
      }
      if (!this.data.saved) {
        const confirmed = await new Promise<boolean>(resolve => wx.showModal({
          title:'先保存这段回忆', content:'配图会根据保存的文字生成。这段回忆会独立保存，之后还能继续修改。',
          confirmText:'保存配图', success:result => resolve(result.confirm), fail:() => resolve(false),
        }));
        if (!confirmed || this.interviewUnloaded) return;
      }
      if (this.data.stage === 'save') {
        await this.save({stayOnPage:true});
        if (!this.data.saved || this.interviewUnloaded) return;
      } else {
        // Saving continues if the user leaves; onUnload must not start a duplicate save.
        this.setData({saving:true});
        try { await this.persistSpokenAnswers(answers); }
        finally { if (!this.interviewUnloaded) this.setData({saving:false}); }
        if (this.interviewUnloaded) return;
        if (unsent) this.pushMessage('answer', unsent);
        this.setData({answers, inputText:''});
      }
      if (this.pendingContribution) await new Promise<void>((resolve, reject) => wx.navigateTo({
        url:`/pages/story-images/story-images?memoryId=${encodeURIComponent(this.pendingContribution!.id)}`,
        success:() => resolve(), fail:() => reject(new Error('回忆已保存，配图页暂时打不开，请从记忆列表重试')),
      }));
    } catch (error) { if (!this.interviewUnloaded) this.showImportError(error); }
    finally { if (!this.interviewUnloaded) this.setData({importing:false}); }
  },

  async importFromAlbum() {
    try {
      const response = await new Promise<WechatMiniprogram.ChooseMediaSuccessCallbackResult>((resolve, reject) => wx.chooseMedia({
        count: 9,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        sizeType: ["compressed"],
        success: resolve,
        fail: reject,
      }));
      await this.saveImportedFiles(response.tempFiles.map((file, index) => ({
        name: `照片${index + 1}.jpg`, path: file.tempFilePath, size: file.size, type: "image",
      })));
    } catch (error) {
      this.showImportError(error);
    }
  },

  async importFromMessage() {
    try {
      const response = await new Promise<WechatMiniprogram.ChooseMessageFileSuccessCallbackResult>((resolve, reject) => wx.chooseMessageFile({
        count: 10,
        type: "all",
        success: resolve,
        fail: reject,
      }));
      await this.saveImportedFiles(response.tempFiles.map(file => ({
        name: file.name, path: file.path, size: file.size, type: file.type,
      })));
    } catch (error) {
      this.showImportError(error);
    }
  },

  showImportError(error: unknown) {
    const message = String((error as { errMsg?: string; message?: string })?.errMsg || (error as Error)?.message || error);
    if (/cancel/i.test(message)) return;
    wx.showModal({ title: "没能导入", content: message || "导入失败，请重试", showCancel: false });
  },

  async saveImportedFiles(files: ImportFileLike[]) {
    await this.stageCapture(files);
  },

  async stageCapture(files:ImportFileLike[]) {
    if(this.data.captureReadOnly || this.data.captureBusy || this.data.importing)return;
    this.setData({importing:true,captureError:''});
    try {const captureDraft=await stageCaptureFiles(files,this.data.captureDraft || undefined,this.data.captureEntry?this.data.captureSessionId:undefined);captureDraft.composerText=this.data.inputText;await storeCaptureDraft(captureDraft);if(!this.interviewUnloaded)this.setData({captureDraft,captureSessionId:captureDraft.sessionId || this.data.captureSessionId});}
    catch(error){const captureDraft=await loadCaptureDraft(this.data.captureSessionId || undefined);if(!this.interviewUnloaded)this.setData({captureDraft:captureDraft || this.data.captureDraft,captureError:error instanceof Error?error.message:'没能添加素材'});}
    finally {if(!this.interviewUnloaded)this.setData({importing:false});}
  },
  async startTextCapture(){await this.stageCapture([]);},
  async recordCapture(){
    if(this.data.captureRecording || this.data.captureBusy)return;
    this.setData({captureRecording:true,captureError:''});
    try {const file=await recordCaptureAudio();if(!this.interviewUnloaded)await this.stageCapture([file]);}
    catch(error){if(!this.interviewUnloaded)this.setData({captureError:error instanceof Error?error.message:'录音中断'});}
    finally {if(!this.interviewUnloaded)this.setData({captureRecording:false});}
  },
  stopCaptureRecording(){stopCaptureAudio();},
  async removeCaptureFile(event:{currentTarget:{dataset:{kind:string;index:number}}}){
    const draft=this.data.captureDraft;if(!draft || draft.submitted || this.data.captureBusy)return;
    const index=Number(event.currentTarget.dataset.index);
    if(event.currentTarget.dataset.kind==='photo'){draft.photoIds.splice(index,1);draft.photoPaths.splice(index,1);}else draft.audio.splice(index,1);
    await storeCaptureDraft(draft);this.setData({captureDraft:{...draft}});
  },
  async cancelEmptyCapture(){const draft=this.data.captureDraft;if(!draft || draft.submitted || draft.audio.length || draft.photoIds.length || draft.text)return;await storeCaptureDraft(undefined,draft.familyId,draft.id,draft.sessionId);this.setData({captureDraft:null});},
  updateCaptureReceipt(receipt:MemoryCaptureReceipt,localStatus:''|'sending'|'failed'=''){
    if(this.interviewUnloaded)return;
    const rows=[...this.data.captureReceipts],index=rows.findIndex(item=>item.id===receipt.id);
    const message:CaptureMessageView={...receipt,localStatus,photoPaths:index>=0?rows[index].photoPaths:this.data.captureDraft?.id===receipt.id?this.data.captureDraft.photoPaths:[]};
    if(index>=0)rows[index]=message;else rows.push(message);
    this.setData({captureReceipts:rows,...(receipt.memoryId?{captureMemoryId:receipt.memoryId}:{}),scrollIntoView:`capture-message-${receipt.id}`});
    if(receipt.photoIds.length && !message.photoPaths.length)void this.loadCapturePhotos(receipt);
  },
  async loadCapturePhotos(receipt:MemoryCaptureReceipt){
    try{
      await assertCaptureScope(receipt.familyId);
      const photos=await readLocalPhotos(receipt.photoIds);
      await assertCaptureScope(receipt.familyId);
      if(this.interviewUnloaded)return;
      this.setData({captureReceipts:this.data.captureReceipts.map(item=>item.id===receipt.id?{...item,photoPaths:receipt.photoIds.map(id=>photos.photoPaths[id]).filter(Boolean)}:item)});
    }catch{/* Keep the saved message visible even when a photo cannot load. */}
  },
  async retryCapturePhotos(event:{currentTarget:{dataset:{id:string}}}){
    const receipt=this.data.captureReceipts.find(item=>item.id===event.currentTarget.dataset.id);
    if(receipt)await this.loadCapturePhotos(receipt);
  },
  async refreshPendingCaptures(){
    const drafts=await pendingCaptureDrafts();
    if(!this.interviewUnloaded)this.setData({capturePending:drafts.filter(draft=>draft.sessionId!==this.data.captureSessionId).map(draft=>({id:draft.id,sessionId:draft.sessionId,label:(draft.composerText || draft.text || `${draft.photoIds.length}张照片、${draft.audio.length}段录音`).slice(0,36)}))});
  },
  async restoreCaptureSession(id:string){
    const session=await readCaptureSession(id);
    if(this.interviewUnloaded)return;
    this.setData({captureSessionId:session.sessionId,captureReceipts:[],captureMemoryId:'',captureReadOnly:!session.sessionId});
    session.items.forEach(receipt=>this.updateCaptureReceipt(receipt));
    const draft=session.sessionId?await loadCaptureDraft(session.sessionId):undefined;
    if(!this.interviewUnloaded)this.setData({captureDraft:draft || null,inputText:draft?.composerText || ''});
  },
  async recoverCaptureDraft(event:{currentTarget:{dataset:{id:string;session?:string}}}){
    if(this.data.captureBusy || this.data.importing || this.data.captureRecording)return;
    this.setData({captureBusy:true,captureError:''});
    try{
      const current=this.data.captureDraft;
      if(current)await storeCaptureDraft({...current,composerText:this.data.inputText});
      const draft=await loadCaptureDraft(event.currentTarget.dataset.session || undefined);
      if(!draft || draft.id!==event.currentTarget.dataset.id)return;
      // Only a submitted draft (or a later message) has an existing cloud session.
      this.setData({captureReceipts:[],captureMemoryId:''});
      if(draft.sessionId && (draft.submitted || draft.id!==draft.sessionId)){
        try{await this.restoreCaptureSession(draft.sessionId);}
        catch{if(!this.interviewUnloaded)this.setData({captureError:'已恢复本机原件，云端消息暂未读到，可以重试发送。'});}
      }
      if(!this.interviewUnloaded)this.setData({captureDraft:draft,captureSessionId:draft.sessionId || '',captureReadOnly:false,inputText:draft.composerText || ''});
      await this.refreshPendingCaptures();
    }catch(error){if(!this.interviewUnloaded)this.setData({captureError:error instanceof Error?error.message:'恢复未完成，请重试'});}
    finally{if(!this.interviewUnloaded)this.setData({captureBusy:false});}
  },
  startNewCapture(){if(!this.data.captureBusy && !this.data.importing && !this.data.captureRecording)wx.redirectTo({url:'/pages/interview/interview?capture=1'});},
  chatAboutCapture(){
    if(this.data.captureBusy || !this.data.captureMemoryId)return;
    const draft=this.data.captureDraft;
    if(this.data.inputText.trim() || draft?.text || draft?.photoIds.length || draft?.audio.length){wx.showToast({title:'先发送当前内容，再一起聊',icon:'none'});return;}
    wx.navigateTo({url:`/pages/interview/interview?sourceId=${encodeURIComponent(this.data.captureMemoryId)}`});
  },
  async sendCapture(){
    if(!this.data.captureDraft || this.data.captureBusy || this.data.captureRecording)return;
    const originalText=this.data.inputText;
    const draft=this.data.captureDraft;
    if(!draft.submitted && !draft.text.trim() && !originalText.trim() && !draft.photoIds.length && !draft.audio.length){this.setData({captureError:'先添加文字、图片或录音'});return;}
    this.setData({captureBusy:true,captureError:''});
    this.updateCaptureReceipt({id:draft.id,sessionId:draft.sessionId,familyId:draft.familyId,text:draft.submittedText || [draft.text,originalText].filter(Boolean).join('\n'),photoIds:draft.photoIds,audio:draft.audio,status:'received',evidence:[],memoryId:'',message:'',createdAtMs:Date.now()},'sending');
    try {await sendMemoryCapture(this.data.captureDraft,originalText,receipt=>this.updateCaptureReceipt(receipt));if(!this.interviewUnloaded)this.setData({captureDraft:null,...(this.data.inputText===originalText?{inputText:''}:{})});}
    catch(error){if(!this.interviewUnloaded){const receipt=this.data.captureReceipts.find(item=>item.id===draft.id);if(receipt)this.updateCaptureReceipt(receipt,'failed');this.setData({captureError:error instanceof Error?error.message:'素材已保留，请稍后继续'});}}
    finally {if(!this.interviewUnloaded)this.setData({captureBusy:false});}
    if(!this.interviewUnloaded && this.data.captureEntry && !this.data.captureDraft){
      if(!draft.sessionId)this.setData({captureReadOnly:true});
      else await this.stageCapture([]);
    }
  },
  async continueCapture(event:{currentTarget:{dataset:{id:string;original?:boolean}}}){
    if(this.data.captureBusy)return;
    const receipt=this.data.captureReceipts.find(item=>item.id===event.currentTarget.dataset.id);if(!receipt)return;
    this.setData({captureBusy:true,captureError:''});
    try {if(event.currentTarget.dataset.original)this.updateCaptureReceipt(await saveCaptureOriginal(receipt.id,receipt.familyId));else await continueMemoryCapture(receipt,next=>this.updateCaptureReceipt(next));}
    catch(error){if(!this.interviewUnloaded)this.setData({captureError:error instanceof Error?error.message:'尚未完成'});}
    finally {if(!this.interviewUnloaded)this.setData({captureBusy:false});}
  },
  toggleCaptureSource(event:{currentTarget:{dataset:{id:string}}}){
    const id=event.currentTarget.dataset.id;
    this.setData({captureExpandedId:this.data.captureExpandedId===id?'':id});
  },
  previewCapturedPhoto(event:{currentTarget:{dataset:{url:string;id?:string}}}){const {url,id}=event.currentTarget.dataset;const urls=this.data.captureReceipts.find(item=>item.id===id)?.photoPaths || [url];wx.previewImage({current:url,urls});},
  openCapturedMemory(event:{currentTarget:{dataset:{id:string}}}){wx.navigateTo({url:`/pages/archive/archive?id=${encodeURIComponent(event.currentTarget.dataset.id)}`});},
  async playCapturedAudio(event:{currentTarget:{dataset:{id:string;fileid:string}}}){
    try {const url=await captureAudioUrl(event.currentTarget.dataset.id,event.currentTarget.dataset.fileid);if(this.interviewUnloaded)return;this.capturePlayer?.destroy();const player=wx.createInnerAudioContext();this.capturePlayer=player;player.src=url;player.onError(()=>wx.showToast({title:'录音暂时无法播放',icon:'none'}));player.play();}catch(error){this.showImportError(error);}
  },

  async save(options: {stayOnPage?: boolean} = {}) {
    if (this.data.saving || this.data.saved) return;
    this.setData({ saving: true, saveError: "" });

    try {
      const shared = this.data.sharedFamilyId ? await loadSharedFamilyRoom(this.data.sharedFamilyId) : undefined;
      const state = shared?.state ?? await loadRoomStateRemoteFirst();
      const member = shared
        ? state.members.find(candidate => candidate.id === shared.viewerMemberId)
        : authorFor(state, await loadCurrentMemberRemoteFirst(state));
      if (!member) throw new Error("成员身份已失效，请重新接受邀请");
      if (!member.id) throw new Error("请先写下你的名字");
      const availableMemberIds = new Set(
        state.members
          .filter((candidate) => candidate.id !== member.id && !candidate.deletedAt)
          .map((candidate) => candidate.id),
      );
      const selectedMemberIds = this.data.relatedMemberIds.concat(
        this.data.audienceMemberIds,
      );
      if (selectedMemberIds.some((memberId) => !availableMemberIds.has(memberId))) {
        throw new Error("选的人有变动，请重新打开本页再选");
      }
      if (this.data.selectedStoryKey && !storyShelf(state).some(item => item.key === this.data.selectedStoryKey)) {
        throw new Error("这个故事已变动，请重新选择");
      }
      // 已经先存过原话（finish() persist-first），这里更新同一条记忆而不是新建：
      // 若草稿文字跟最后一条历史不一样，说明用户手改过，补一条 manual 记录；
      // 没改过（比如 AI 整理失败走本地兜底，草稿=原话）就不重复追加历史。
      if (this.pendingContribution && !this.data.sharedFamilyId) {
        const saved = state.contributions.find(item => item.id === this.pendingContribution!.id && !item.deletedAt);
        if (!saved && this.persistedContributionId === this.pendingContribution.id) throw new Error('这段记忆已变动，请重新打开');
        if (saved) this.pendingContribution = {...this.pendingContribution, photoIds:saved.photoIds};
      }
      const base = this.pendingContribution ?? createContribution({
        authorMemberId: member.id,
        authorName: member.name,
        relation: member.relation,
        text: this.data.draftText,
        title: this.data.draftTitle,
        organizationMode: this.data.draftOrganizationMode,
        memoryType: this.data.memoryType,
        storyTitle: this.data.storyTitle,
        relatedMemberIds: this.data.relatedMemberIds,
        sharedWithMemberIds: this.data.sharedFamilyId ? [] : this.data.audienceMemberIds,
        scope: this.data.sharedFamilyId ? "family" : "personal",
        visibility: this.data.sharedFamilyId ? "family" : "private",
      });
      const revisions = memoryAiRevisions(base);
      const lastText = revisions.length > 0 ? revisions[revisions.length - 1].text : base.text;
      const draftText = normalizeMemoryText(this.data.draftText);
      const withRevision = draftText !== lastText.trim()
        ? appendAiRevision(base, "manual", draftText, this.data.draftTitle, base.organizationMode)
        : { ...base, text: draftText, title: this.data.draftTitle || base.title };
      const storyTitle = this.data.storyTitle.trim();
      const relatedMemberIds = this.data.relatedMemberIds.length > 0 ? this.data.relatedMemberIds : undefined;
      const sharedWithMemberIds = this.data.sharedFamilyId
        ? undefined
        : this.data.audienceMemberIds.length > 0 ? this.data.audienceMemberIds : undefined;
      this.pendingContribution = {
        ...withRevision,
        summary: this.data.draftSummary?.trim() || undefined,
        emotions: this.data.draftEmotions.length > 0 ? this.data.draftEmotions : undefined,
        people: this.data.draftPeople.length > 0 ? this.data.draftPeople : undefined,
        places: this.data.draftPlaces.length > 0 ? this.data.draftPlaces : undefined,
        memoryType: this.data.memoryType,
        storyTitle: storyTitle || undefined,
        relatedMemberIds,
        sharedWithMemberIds,
        scope: this.data.sharedFamilyId ? "family" : "personal",
        visibility: this.data.sharedFamilyId ? "family" : "private",
      };
      if (this.data.sharedFamilyId) await submitSharedContribution(this.data.sharedFamilyId, this.pendingContribution);
      else {
        const savedState = await appendContributionRemoteFirst(this.pendingContribution);
        this.persistedContributionId = this.pendingContribution.id;
        if (this.data.storyId) await linkStoryMemories(activeStory(savedState, this.data.storyId), [this.pendingContribution.id]);
      }

      this.setData({
        saved: true,
        saving: false,
        storageLabel: this.data.sharedFamilyId ? "已提交到微信记忆之家" : roomDataModeLabel(),
        saveMessage: this.data.sharedFamilyId
          ? "已交给主人确认；确认后会出现在大家的记忆之家。"
          : this.data.selectedStoryKey
            ? `记忆已保存。接下来选择「${this.data.storyTitle.trim()}」的章节，预览后再写入正文。`
            : this.data.storyTitle.trim() ? `已归入「${this.data.storyTitle.trim()}」的记忆，之后可以整理进正文。`
            : "已保存到“记忆”，暂未归入故事。以后再整理也可以。",
      });
      wx.disableAlertBeforeUnload();
      wx.showToast({
        title: this.data.sharedFamilyId
          ? "已提交，等待确认"
          : this.data.storyTitle.trim()
            ? "记忆已保存"
            : "已存入未整理片段",
        icon: "none",
        duration: 2400,
      });
      if (this.data.selectedStoryKey && !options.stayOnPage) this.continueToChapter();
    } catch (error) {
      this.setData({
        saving: false,
        saveError: "暂未确认保存结果。文字仍在本页，请重试，不必重新讲一遍。",
      });
      wx.showToast({ title: error instanceof Error ? error.message : "暂时无法确认保存", icon: "none" });
    }
  },

  continueToChapter() {
    if (!this.data.saved || !this.pendingContribution || !this.data.selectedStoryKey || this.data.sharedFamilyId) return;
    const selected = this.data.storyOptions.find(item => item.key === this.data.selectedStoryKey);
    if (!selected) return;
    const query = `storyId=${encodeURIComponent(selected.key)}&memoryIds=${encodeURIComponent(this.pendingContribution.id)}`
      + (selected.memberId ? `&memberId=${encodeURIComponent(selected.memberId)}` : "");
    wx.navigateTo({ url: `/pages/book/book?${query}`, fail: () => {
      this.setData({ saveMessage: "记忆已保存，打开章节暂时失败，请点“继续选择章节”重试。" });
    } });
  },

  viewSavedMemory() {
    if (!this.data.saved || !this.pendingContribution) return;
    if (this.data.sharedFamilyId) {
      wx.redirectTo({ url: `/pages/room/room?familyId=${encodeURIComponent(this.data.sharedFamilyId)}` });
      return;
    }
    wx.redirectTo({ url: `/pages/archive/archive?id=${encodeURIComponent(this.pendingContribution.id)}` });
  },

  leaveSavedMemory() {
    wx.navigateBack();
  },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
