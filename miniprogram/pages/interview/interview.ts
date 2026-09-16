import {
  accountOwner,
  createContribution,
  createContributionFromSegments,
  contributionScope,
  contributionStoryTitle,
  FamilyMember,
  FamilyRoomState,
  isActiveMember,
  MAX_MEMORY_LENGTH,
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
  FOLLOW_UP_LABEL,
  INTERVIEW_DIMENSIONS,
  InterviewDimension,
  InterviewTurn,
  pickInterviewQuestion,
  sharedQuestionSeed,
} from "../../domain/interview";
import { generateInterviewPrompt } from "../../services/interviewService";
import { organizeMemory } from "../../services/memoryOrganizerService";
import {
  appendContributionRemoteFirst,
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  roomDataModeLabel,
} from "../../services/roomRepository";
import { loadSharedFamilyRoom, submitSharedContribution } from "../../services/familyInviteService";
import { discardLocalPhotos, saveLocalPhoto } from "../../services/bookImages";
import { classifyImportFiles, ImportFileLike, readImportTextFile } from "../../services/memoryImport";
import { CAPTION_EDITED_LABEL, CAPTION_LABEL, storyImageApi } from "../../services/storyImageService";
import { resumePhotoUploads } from "../../services/photoCloud";

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
    title,
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
    saveMessage: "",
    saveError: "",
    storageLabel: "",

    keyboardHeight: 0,
    sharedFamilyId: "",
    importing: false,
    importDraftOpen: false,
    importPhotoIds: [] as string[],
    importPhotoPaths: [] as string[],
    importCaption: "",
    importAiOriginal: "",
    importAiLabel: "",
    importAiLoading: false,
  },

  messageSeq: 0,
  pendingContribution: undefined as MemoryContribution | undefined,

  async onLoad(options: InterviewLoadOptions = {}) {
    try {
    const sharedFamilyId = decodeQueryValue(options.familyId);
    const shared = sharedFamilyId ? await loadSharedFamilyRoom(sharedFamilyId) : undefined;
    const state = shared?.state ?? await loadRoomStateRemoteFirst();
    const member = shared
      ? state.members.find(candidate => candidate.id === shared.viewerMemberId)
      : authorFor(state, await loadCurrentMemberRemoteFirst(state));
    if (!member) throw new Error("成员身份已失效，请重新接受邀请");
    if (!member.id) {
      wx.showToast({ title: "先写下你的名字，就可以开始聊了", icon: "none" });
      wx.redirectTo({ url: "/pages/profiles/profiles" });
      return;
    }
    const question = pickInterviewQuestion(sharedQuestionSeed(), sharedFamilyId ? "family" : "personal");
    const requestedStoryTitle = decodeQueryValue(options.storyTitle);
    const requestedSourceId = decodeQueryValue(options.sourceId);
    const requestedMemoryType: MemoryType | undefined =
      options.memoryType === "memoir"
        ? "memoir"
        : options.memoryType === "note"
          ? "note"
          : undefined;
    // 记忆库是共用的：接着聊的那一段可以是任何人讲的。
    const source = (sharedFamilyId ? state.contributions : memoryPool(state.contributions)).find((memory) => (
      memory.id === requestedSourceId &&
      (!sharedFamilyId || (
        memory.authorMemberId === member.id && contributionScope(memory) === "family"
      ))
    ));
    const sourceStoryTitle = source ? contributionStoryTitle(source) : "";
    const storyTitle = sourceStoryTitle || requestedStoryTitle;
    const sourcePreview = source
      ? `${source.text.slice(0, 72)}${source.text.length > 72 ? "……" : ""}`
      : "";
    // 从首页推荐问点进来时，第一句就是用户刚才点的那个问题，不换成泛泛的“后来你又想起了什么”。
    const requestedQuestion = decodeQueryValue(options.question).slice(0, 80);
    const requestedDimension = INTERVIEW_DIMENSIONS.find(
      (dimension) => dimension === options.dimension,
    );
    const continuation = requestedQuestion ||
      (storyTitle ? "这一次，你还想补充什么？" : "后来你又想起了什么？");
    const opening = source
      ? storyTitle
        ? `我们继续聊「${storyTitle}」吧。\n上次你讲到：“${sourcePreview}”\n${continuation}`
        : `我们接着这段往下聊吧。\n上次你讲到：“${sourcePreview}”\n${continuation}`
      : requestedMemoryType === "note"
        ? "先把这一刻想到的留下来吧。几句话也可以，聊完后再决定放进哪个故事。"
        : `${requestedQuestion || question.text}\n想到自己、家人或朋友都可以。先慢慢讲，聊完后再决定放进哪个故事。`;

    this.setData({
      memberName: member.name,
      memberRelation: member.relation,
      sharedFamilyId,
      stage: source || storyTitle || requestedMemoryType ? "chat" : "choose",
      memoryType: requestedMemoryType ?? this.data.memoryType,
      askedDimensions: requestedQuestion && requestedDimension ? [requestedDimension] : [],
      dateLabel: today(),
      storyTitle,
      storyOptions: storyOptionsFor(
        state.contributions,
        storyTitle,
        Boolean(sharedFamilyId),
        (state.deletedStories ?? []).map(story => story.title),
      ),
      relatedOptions: memberOptionsFor(state.members, member.id),
      audienceOptions: memberOptionsFor(state.members, member.id),
    });

    this.pushMessage("opening", opening);
    } catch (error) {
      wx.showModal({ title: "暂时无法加载", content: "请返回后重新打开，不会切换到另一份本地数据。", showCancel: false, success: () => wx.navigateBack() });
    }
  },

  /**
   * 没点「整理成片段」就直接退出时，聊天记录不能白讲。
   * 未完成归档时先存为只有自己可见的片段，避免强迫用户过早分类。
   */
  onUnload() {
    wx.disableAlertBeforeUnload();
    if (this.data.importDraftOpen) {
      void discardLocalPhotos(this.data.importPhotoIds.map((id, index) => ({ id, path: this.data.importPhotoPaths[index] })));
    }
    const unsentText = this.data.inputText.trim();
    const rawAnswers = this.data.answers.concat(unsentText ? [unsentText] : []);
    if (this.data.saved || this.data.saving || rawAnswers.length === 0) return;

    void this.saveRecoverableAnswers(rawAnswers);
  },

  async saveRecoverableAnswers(rawAnswers: string[]) {
    try {
      if (this.pendingContribution) {
        if (this.data.sharedFamilyId) await submitSharedContribution(this.data.sharedFamilyId, this.pendingContribution);
        else await appendContributionRemoteFirst(this.pendingContribution);
        return;
      }
      const shared = this.data.sharedFamilyId ? await loadSharedFamilyRoom(this.data.sharedFamilyId) : undefined;
      const state = shared?.state ?? await loadRoomStateRemoteFirst();
      const member = shared
        ? state.members.find(candidate => candidate.id === shared.viewerMemberId)
        : authorFor(state, await loadCurrentMemberRemoteFirst(state));
      if (!member) throw new Error("成员身份已失效");
      const recoverableText = normalizeMemoryText(
        this.data.stage === "save" && this.data.draftText
          ? this.data.draftText
          : rawAnswers.join(" "),
      );
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
    this.setData({ inputText });
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
        previousAnswers,
        conversation,
      });
      this.setData({
        asking: false,
        askedDimensions: this.data.askedDimensions.concat([prompt.dimension]),
      });
      this.pushMessage("followup", prompt.text, FOLLOW_UP_LABEL);
    } catch (error) {
      console.warn("追问生成失败", error);
      this.setData({ asking: false });
      wx.showToast({ title: "小忆刚刚走神了，再试一次", icon: "none" });
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
        draftTitle: draft.title,
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

  importMemory() {
    if (this.data.importing) return;
    if (this.data.sharedFamilyId) {
      wx.showToast({ title: "请回到自己的记忆里导入", icon: "none" });
      return;
    }
    wx.showActionSheet({
      itemList: ["从相册或拍照选照片", "从微信聊天选文件"],
      success: result => {
        if (result.tapIndex === 0) void this.importFromAlbum();
        if (result.tapIndex === 1) void this.importFromMessage();
      },
    });
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

  onImportCaptionInput(event: { detail: { value: string } }) {
    const importCaption = event.detail.value.slice(0, MAX_MEMORY_LENGTH);
    const importAiLabel = !importCaption || !this.data.importAiOriginal
      ? ""
      : importCaption === this.data.importAiOriginal ? CAPTION_LABEL : CAPTION_EDITED_LABEL;
    this.setData({ importCaption, importAiLabel });
  },

  async generateImportCaption() {
    if (this.data.importAiLoading || !this.data.importPhotoIds.length) return;
    this.setData({ importAiLoading: true });
    try {
      await resumePhotoUploads();
      const result = await storyImageApi.captionPhotos({ photoIds: this.data.importPhotoIds.slice(0, 3) });
      if (!result.aiGenerated || !result.caption) throw new Error(result.message || "没看出来，自己写一句吧");
      this.setData({
        importCaption: result.caption,
        importAiOriginal: result.caption,
        importAiLabel: CAPTION_LABEL,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "没看出来，自己写一句吧";
      wx.showToast({ title: message, icon: "none", duration: 3000 });
    } finally {
      this.setData({ importAiLoading: false });
    }
  },

  closePhotoImport() {
    this.setData({
      importDraftOpen: false,
      importPhotoIds: [],
      importPhotoPaths: [],
      importCaption: "",
      importAiOriginal: "",
      importAiLabel: "",
    });
  },

  async cancelPhotoImport() {
    if (this.data.importAiLoading || this.data.importing) return;
    const photos = this.data.importPhotoIds.map((id, index) => ({ id, path: this.data.importPhotoPaths[index] }));
    this.closePhotoImport();
    await discardLocalPhotos(photos);
  },

  async savePhotoImport() {
    if (this.data.importing || !this.data.importPhotoIds.length) return;
    this.setData({ importing: true });
    wx.showLoading({ title: "正在保存" });
    try {
      await this.persistImportedMemory({
        title: `照片 · ${new Date().getMonth() + 1}月${new Date().getDate()}日`,
        text: this.data.importCaption,
        photoIds: this.data.importPhotoIds,
        organizationMode: this.data.importAiLabel ? "cloud-ai" : undefined,
      });
      this.closePhotoImport();
      wx.hideLoading();
      wx.showToast({ title: "已导入到记忆", icon: "success" });
    } catch (error) {
      wx.hideLoading();
      this.setData({ importing: false });
      this.showImportError(error);
    }
  },

  async persistImportedMemory(input: {
    title: string;
    text: string;
    photoIds: string[];
    segments?: string[];
    organizationMode?: OrganizationMode;
  }) {
    const state = await loadRoomStateRemoteFirst();
    const member = authorFor(state, await loadCurrentMemberRemoteFirst(state));
    if (!member?.id) throw new Error("请先写下你的名字");
    const contributionInput = {
      authorMemberId: member.id,
      authorName: member.name,
      relation: member.relation,
      text: input.segments?.[0] || input.text,
      title: input.title,
      organizationMode: input.organizationMode,
      memoryType: "note" as const,
      scope: "personal" as const,
      visibility: "private" as const,
      photoIds: input.photoIds,
    };
    const contribution = input.segments
      ? createContributionFromSegments(contributionInput, input.segments, "import")
      : createContribution(contributionInput);
    await appendContributionRemoteFirst(contribution);
    this.setData({ importing: false });
  },

  async saveImportedFiles(files: ImportFileLike[]) {
    if (this.data.importing) return;
    this.setData({ importing: true });
    wx.showLoading({ title: "正在导入" });
    try {
      const classified = classifyImportFiles(files);
      if (!classified.images.length && !classified.text) {
        throw new Error("这一版只能导入图片和 .txt、.md 文字文件");
      }
      const importedText = classified.text ? await readImportTextFile(classified.text) : undefined;
      const savedPhotos = [] as Array<{ id: string; path: string }>;
      for (const image of classified.images) savedPhotos.push(await saveLocalPhoto(image.path, "import"));
      if (!importedText) {
        wx.hideLoading();
        this.setData({
          importing: false,
          importDraftOpen: true,
          importPhotoIds: savedPhotos.map(photo => photo.id),
          importPhotoPaths: savedPhotos.map(photo => photo.path),
          importCaption: "",
          importAiOriginal: "",
          importAiLabel: "",
        });
        return;
      }
      await this.persistImportedMemory({
        title: importedText.title,
        text: importedText.segments[0],
        segments: importedText.segments,
        photoIds: savedPhotos.map(photo => photo.id),
      });
      wx.hideLoading();
      if (classified.unsupportedNames.length) {
        wx.showModal({
          title: "支持的内容已导入",
          content: `${classified.unsupportedNames.join("、")} 这一版还不能导入。Word、PDF 可以打开后复制文字，粘贴到聊天框里。`,
          showCancel: false,
        });
      } else {
        wx.showToast({ title: "已导入到记忆", icon: "success" });
      }
    } catch (error) {
      wx.hideLoading();
      this.setData({ importing: false });
      throw error;
    }
  },

  async save() {
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
      const contribution = createContribution({
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
          sharedWithMemberIds: this.data.sharedFamilyId ? [] : this.data.audienceMemberIds,
          scope: this.data.sharedFamilyId ? "family" : "personal",
          visibility: this.data.sharedFamilyId ? "family" : "private",
        });
      this.pendingContribution = {
        ...contribution,
        id: this.pendingContribution?.id ?? contribution.id,
        createdAt: this.pendingContribution?.createdAt ?? contribution.createdAt,
      };
      if (this.data.sharedFamilyId) await submitSharedContribution(this.data.sharedFamilyId, this.pendingContribution);
      else await appendContributionRemoteFirst(this.pendingContribution);

      this.setData({
        saved: true,
        saving: false,
        storageLabel: this.data.sharedFamilyId ? "已提交到微信记忆之家" : roomDataModeLabel(),
        saveMessage: this.data.sharedFamilyId
          ? "已交给主人确认；确认后会出现在大家的记忆之家。"
          : this.data.storyTitle.trim()
            ? `已保存到「${this.data.storyTitle.trim()}」，也可在“记忆”中找到。`
            : "已保存到“记忆”，暂未归入故事。以后再整理也可以。",
      });
      wx.disableAlertBeforeUnload();
      wx.showToast({
        title: this.data.sharedFamilyId
          ? "已提交，等待确认"
          : this.data.storyTitle.trim()
            ? `已放进「${this.data.storyTitle.trim()}」`
            : "已存入未整理片段",
        icon: "none",
        duration: 2400,
      });
    } catch (error) {
      this.setData({
        saving: false,
        saveError: "暂未确认保存结果。文字仍在本页，请重试，不必重新讲一遍。",
      });
      wx.showToast({ title: error instanceof Error ? error.message : "暂时无法确认保存", icon: "none" });
    }
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
