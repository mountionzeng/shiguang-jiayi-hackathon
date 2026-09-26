import {
  appendAiRevision,
  contributionStoryTitle,
  MemoryContribution,
  memoryAiLabel,
  memoryAiRevisions,
  memoryOriginalSpokenText,
  memoryPool,
  normalizeMemoryText,
  revertMemoryToSpoken,
  MAX_MEMORY_LENGTH,
} from "../../domain/biography";
import {
  loadCurrentMemberRemoteFirst,
  softDeleteMemoryRemoteFirst,
  loadRoomStateRemoteFirst,
  replaceContributionRemoteFirst,
  roomDataModeLabel,
} from "../../services/roomRepository";
import { memoryPlacements } from "../../services/manuscript";
import { storyShelf } from "../../services/storyShelf";
import { logLoadError } from "../../services/loadErrorLog";
import { loadCurrentStoryId } from "../../services/storySelection";
import { generateInterviewPrompt } from "../../services/interviewService";
import { InterviewDimension, InterviewTurn } from "../../domain/interview";
import { organizeMemory } from "../../services/memoryOrganizerService";

type ArchiveTab = "note" | "memoir";

interface NoteView {
  id: string;
  title: string;
  excerpt: string;
  dateLabel: string;
  archiveLabel: string;
  /** Written into at least one book. */
  recorded: boolean;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

const HISTORY_KIND_LABELS: Record<string, string> = {
  spoken: "原话",
  ai: "AI 整理",
  manual: "人工修改",
  restore: "撤回到原话",
};

function historyRows(revisions: ReturnType<typeof memoryAiRevisions>) {
  return revisions
    .slice()
    .reverse()
    .map((revision, index) => ({
      id: revision.id,
      kindLabel: revision.versionLabel || HISTORY_KIND_LABELS[revision.kind] || revision.kind,
      text: revision.text,
      dateLabel: formatDate(revision.createdAt),
      current: index === 0,
    }));
}

function memoryVersionLabel(revision: ReturnType<typeof memoryAiRevisions>[number] | undefined): string {
  return revision?.versionLabel || (revision ? `${HISTORY_KIND_LABELS[revision.kind] || revision.kind} · ${formatDate(revision.createdAt)}` : "当前保存版本");
}

function revisionAiLabel(revisions: ReturnType<typeof memoryAiRevisions>, revisionId: string): string {
  const index = revisions.findIndex(revision => revision.id === revisionId);
  if (index < 0) return "";
  const revision = revisions[index];
  if (revision.kind === "ai") return "文字 AI 生成";
  return revision.kind === "manual" && revisions.slice(0, index + 1).some(item => item.kind === "ai")
    ? "文字 AI 生成 · 已由你修改"
    : "";
}

function normalizeStoryName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 30);
}

function storyNameKey(value: string): string {
  return normalizeStoryName(value).toLocaleLowerCase();
}

function uniqueStoryNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  names.forEach((name) => {
    const title = normalizeStoryName(name);
    const key = storyNameKey(title);
    if (!title || seen.has(key)) return;
    seen.add(key);
    result.push(title);
  });
  return result;
}

function storyGroupingState(storyOptions: string[], editStory: string) {
  const query = normalizeStoryName(editStory);
  const queryKey = storyNameKey(query);
  const options = uniqueStoryNames(storyOptions);
  const storySuggestions = queryKey
    ? options.filter((title) => storyNameKey(title).includes(queryKey))
    : options;
  const hasExactMatch = Boolean(queryKey && options.some((title) => storyNameKey(title) === queryKey));
  return {
    storySuggestions,
    storyCreateTitle: queryKey && !hasExactMatch ? query : "",
    storyCreateHint: queryKey && !hasExactMatch
      ? storySuggestions.length
        ? "没有完全同名的故事，可以继续选择已有故事，或新建一个。"
        : "没有找到同名故事，可以新建一个。"
      : "",
  };
}

function noteTitle(memory: MemoryContribution): string {
  const storedTitle = typeof memory.title === "string" ? memory.title.trim() : "";
  if (storedTitle) return storedTitle;
  const firstSentence = memory.text.split(/[。！？!?]/)[0].trim();
  return firstSentence.slice(0, 18) || "一段随手记";
}

function waitForSaveConfirmation() {
  return new Promise(resolve => setTimeout(resolve, 300));
}

Page({
  data: {
    placements: [] as Array<{ storyId?: string; memberId: string; bookName: string; bookTitle: string; chapter: string; chapterId: string }>,
    memberName: "",
    notes: [] as NoteView[],
    noteCount: 0,
    hasNotes: false,
    memoirCount: 0,
    activeTab: "note" as ArchiveTab,
    archiveItems: [] as NoteView[],
    unrecordedItems: [] as NoteView[],
    recordedItems: [] as NoteView[],
    hasItems: false,
    swipedItemId: "",
    deletingItemId: "",
    editingId: "",
    editTitle: "",
    editText: "",
    selectedRevisionId: "",
    selectedVersionLabel: "当前保存版本",
    isCurrentVersion: true,
    editStory: "",
    storyOptions: [] as string[],
    storySuggestions: [] as string[],
    storyCreateTitle: "",
    storyCreateHint: "",
    savingEdit: false,
    isEditingDocument: false,
    chatExpanded: false,
    chatMessages: [] as Array<{ id: string; role: "assistant" | "user"; text: string; label: string }>,
    chatInput: "",
    chatAsking: false,
    chatNotice: "",
    coeditingAskedDimensions: [] as InterviewDimension[],
    organizingPreview: false,
    previewOpen: false,
    previewTitle: "",
    previewText: "",
    previewNotice: "",
    previewAiLabel: "",
    loadError: "",
    storageLabel: "",
    editAiLabel: "",
    showOriginal: false,
    originalText: "",
    canRevertToSpoken: false,
    reverting: false,
    historyItems: [] as Array<{ id: string; kindLabel: string; text: string; dateLabel: string }>,
    showHistory: false,
  },

  swipeStartX: 0,
  swipeStartY: 0,
  swipeActiveId: "",
  chatRequestId: 0,
  organizeRequestId: 0,
  openMemoryRequestId: 0,
  pendingMemorySocialSend: false,
  editingOriginal: undefined as MemoryContribution | undefined,

  onLoad(options: { tab?: string; id?: string }) {
    this.setData({ activeTab: options.tab === "memoir" ? "memoir" : "note" });
    if (options.id) this.setData({ editingId: options.id });
  },

  onShow() {
    void this.refresh().catch((error) => { logLoadError("archive", error); this.setData({ loadError: "记忆暂时未加载成功，请重试。原有记录不会被清空。" }); });
  },

  onHide() {
    this.chatRequestId++;
    this.organizeRequestId++;
    this.openMemoryRequestId++;
    this.setData({ chatAsking: false, organizingPreview: false });
  },

  selectArchiveTab(event: {
    currentTarget: { dataset: { tab: ArchiveTab } };
  }) {
    const activeTab = event.currentTarget.dataset.tab === "memoir" ? "memoir" : "note";
    this.setData({ activeTab, swipedItemId: "" });
    this.onShow();
  },

  async refresh() {
    const state = await loadRoomStateRemoteFirst();
    const member = await loadCurrentMemberRemoteFirst(state);
    // One pool for every book. A memory is either not written yet, or written into
    // one or more books; the label says where.
    const personal = memoryPool(state.contributions);
    const deletedStoryTitles = new Set((state.deletedStories ?? []).map((story) => story.title));
    const placements = memoryPlacements(state);
    const toViews = (memoryType?: ArchiveTab) => personal
      .filter((memory) => !memoryType || (memory.memoryType ?? "note") === memoryType)
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((memory) => {
        const storyTitle = contributionStoryTitle(memory);
        const places = placements.get(memory.id) ?? [];
        return {
          id: memory.id,
          title: noteTitle(memory),
          excerpt: memory.text,
          dateLabel: formatDate(memory.createdAt),
          archiveLabel: (storyTitle ? `故事「${storyTitle}」 · ` : "")
            + (places.length ? "写进了 " + places.map((place) => `${place.bookName}的书${place.chapter}`).join("、") : "还没写进书"),
          recorded: places.length > 0,
        };
      });
    const notes = toViews("note");
    const memoirs = toViews("memoir");
    const archiveItems = toViews();

    const storyOptions = uniqueStoryNames(storyShelf(state)
      .map((story) => story.title)
      .concat(personal.map(contributionStoryTitle))
      .filter((title) => Boolean(title) && !deletedStoryTitles.has(title)));
    this.setData({
      placements: placements.get(this.data.editingId) ?? [],
      memberName: member.name,
      notes,
      noteCount: notes.length,
      hasNotes: notes.length > 0,
      memoirCount: memoirs.length,
      archiveItems,
      unrecordedItems: archiveItems.filter((item) => !item.recorded),
      recordedItems: archiveItems.filter((item) => item.recorded),
      hasItems: archiveItems.length > 0,
      storyOptions,
      ...storyGroupingState(storyOptions, this.data.editStory),
      storageLabel: roomDataModeLabel(),
      loadError: "",
    });
    if (this.data.editingId && !this.editingOriginal) {
      const memory = personal.find(item => item.id === this.data.editingId);
      if (memory) this.showEditor(memory);
      else {
        this.setData({ editingId: "" });
        wx.showToast({ title: "这段记忆已不存在，请查看当前列表", icon: "none" });
      }
    }
  },

  retryLoad() { this.onShow(); },

  showEditor(memory: MemoryContribution) {
    this.editingOriginal = memory;
    this.chatRequestId++;
    this.organizeRequestId++;
    const revisions = memoryAiRevisions(memory);
    const currentRevision = revisions[revisions.length - 1];
    const original = memoryOriginalSpokenText(memory);
    const editStory = contributionStoryTitle(memory);
    this.setData({
      editingId: memory.id,
      isEditingDocument: false,
      chatExpanded: false,
      chatMessages: [{ id: "welcome-" + memory.id, role: "assistant", text: "我会围绕上方这段记忆和你聊。可以补充细节，也可以告诉我想怎么改。", label: "" }],
      chatInput: "",
      chatAsking: false,
      chatNotice: "",
      coeditingAskedDimensions: [],
      organizingPreview: false,
      previewOpen: false,
      previewTitle: "",
      previewText: "",
      previewNotice: "",
      previewAiLabel: "",
      editTitle: memory.title || "",
      editText: memory.text,
      selectedRevisionId: currentRevision?.id || "",
      selectedVersionLabel: memoryVersionLabel(currentRevision),
      isCurrentVersion: true,
      editStory,
      ...storyGroupingState(this.data.storyOptions, editStory),
      swipedItemId: "",
      editAiLabel: memoryAiLabel(memory),
      showOriginal: false,
      originalText: original,
      canRevertToSpoken: revisions.length > 0 && original !== memory.text,
      historyItems: historyRows(revisions),
      showHistory: false,
    });
  },

  toggleOriginal() {
    this.setData({ showOriginal: !this.data.showOriginal });
  },

  toggleHistory() {
    this.setData({ showHistory: !this.data.showHistory });
  },

  toggleChat() {
    this.setData({ chatExpanded: !this.data.chatExpanded });
  },

  startDocumentEdit() {
    this.setData({ isEditingDocument: true });
  },

  cancelDocumentEdit() {
    const original = this.editingOriginal;
    if (!original) return;
    const selected = memoryAiRevisions(original).find(revision => revision.id === this.data.selectedRevisionId);
    this.setData({
      editTitle: selected?.title || original.title || "",
      editText: selected?.text || original.text,
      editStory: contributionStoryTitle(original),
      ...storyGroupingState(this.data.storyOptions, contributionStoryTitle(original)),
      isEditingDocument: false,
    });
  },

  selectMemoryRevision(event: { currentTarget: { dataset: { id: string } } }) {
    const original = this.editingOriginal;
    const revisionId = event.currentTarget.dataset.id || "";
    const revisions = original ? memoryAiRevisions(original) : [];
    const selected = revisions.find(revision => revision.id === revisionId);
    if (!original || !selected) return;
    const currentSelection = revisions.find(revision => revision.id === this.data.selectedRevisionId);
    const changed = this.data.editTitle !== (currentSelection?.title || original.title || "")
      || this.data.editText !== (currentSelection?.text || original.text)
      || this.data.chatInput.trim().length > 0
      || this.data.chatMessages.some(message => message.role === "user");
    const apply = () => this.setData({
      selectedRevisionId: selected.id,
      selectedVersionLabel: memoryVersionLabel(selected),
      isCurrentVersion: selected.id === revisions[revisions.length - 1]?.id,
      editTitle: selected.title || original.title || "",
      editText: selected.text,
      editAiLabel: revisionAiLabel(revisions, selected.id),
      isEditingDocument: false,
      chatExpanded: false,
      chatMessages: [{ id: "welcome-" + original.id + "-" + selected.id, role: "assistant", text: "我会围绕当前选中的保存版本和你聊。", label: "" }],
      chatInput: "",
      chatNotice: "",
      coeditingAskedDimensions: [],
    });
    if (changed) {
      wx.showModal({ title: "切换保存版本？", content: "本次未保存的正文与对话会清除，已保存版本不会变化。", success: result => { if (result.confirm) apply(); } });
      return;
    }
    apply();
  },

  selectCurrentMemoryRevision() {
    const original = this.editingOriginal;
    if (!original) return;
    const revisions = memoryAiRevisions(original);
    const current = revisions[revisions.length - 1];
    if (current) {
      this.selectMemoryRevision({ currentTarget: { dataset: { id: current.id } } });
      return;
    }
    const changed = this.data.editTitle !== (original.title || "") || this.data.editText !== original.text
      || this.data.chatInput.trim().length > 0 || this.data.chatMessages.some(message => message.role === "user");
    const apply = () => this.setData({ editTitle: original.title || "", editText: original.text,
      selectedRevisionId: "", selectedVersionLabel: memoryVersionLabel(undefined), isCurrentVersion: true,
      editAiLabel: "", isEditingDocument: false, chatExpanded: false, chatInput: "", chatNotice: "",
      chatMessages: [{ id: "welcome-" + original.id, role: "assistant", text: "我会围绕上方这段记忆和你聊。", label: "" }] });
    if (changed) {
      wx.showModal({ title: "回到当前版本？", content: "本次未保存的正文与对话会清除。", success: result => { if (result.confirm) apply(); } });
      return;
    }
    this.setData({
      selectedRevisionId: "",
      selectedVersionLabel: memoryVersionLabel(undefined),
      isCurrentVersion: true,
      editTitle: original.title || "",
      editText: original.text,
      editAiLabel: memoryAiLabel(original),
      isEditingDocument: false,
    });
  },

  onChatInput(event: WechatMiniprogram.Input) {
    this.setData({ chatInput: event.detail.value });
  },

  async sendCoeditingMessage() {
    const answer = this.data.chatInput.trim();
    if (!answer || this.data.chatAsking || this.data.organizingPreview) return;
    const requestId = ++this.chatRequestId;
    const baseText = this.data.editText;
    const messages = this.data.chatMessages;
    const conversation: InterviewTurn[] = messages.map(message => ({ role: message.role, text: message.text }));
    const previousAnswers = messages.filter(message => message.role === "user").map(message => message.text);
    const memory = this.editingOriginal;
    this.setData({ chatAsking: true, chatNotice: "" });
    try {
      const reply = await generateInterviewPrompt({
        answer,
        askedDimensions: this.data.coeditingAskedDimensions,
        mode: "personal",
        memoryType: memory?.memoryType ?? "note",
        memberName: this.data.memberName,
        storyTitle: this.data.editStory || (memory ? contributionStoryTitle(memory) : ""),
        previousAnswers,
        conversation,
        sourceText: baseText,
        sourceOnly: true,
      });
      if (requestId !== this.chatRequestId || !this.editingOriginal || this.editingOriginal.id !== memory?.id) return;
      const userMessage = { id: "coedit-user-" + requestId, role: "user" as const, text: answer, label: "" };
      const assistantMessage = {
        id: "coedit-assistant-" + requestId,
        role: "assistant" as const,
        text: reply.text,
        label: reply.generationMode === "cloud-ai" ? "文字 AI 生成" : "本地续聊提示",
      };
      this.setData({
        chatMessages: this.data.chatMessages.concat([userMessage, assistantMessage]),
        coeditingAskedDimensions: this.data.coeditingAskedDimensions.concat([reply.dimension]),
        chatInput: this.data.chatInput.trim() === answer ? "" : this.data.chatInput,
        chatNotice: reply.generationMode === "cloud-ai" ? "" : "云端 AI 暂不可用，已保留你的输入；这是本地续聊提示。",
      });
    } catch (error) {
      if (requestId !== this.chatRequestId) return;
      this.setData({ chatNotice: error instanceof Error ? error.message : "暂时无法继续对话，你的输入还在。" });
    } finally {
      if (requestId === this.chatRequestId) this.setData({ chatAsking: false });
    }
  },

  async createDocumentPreview() {
    if (this.data.organizingPreview || this.data.savingEdit || !this.editingOriginal) return;
    const text = normalizeMemoryText(this.data.editText);
    if (!text || text.length > MAX_MEMORY_LENGTH) {
      wx.showToast({ title: "请保留 1—500 字的记忆", icon: "none" });
      return;
    }
    const requestId = ++this.organizeRequestId;
    const memory = this.editingOriginal;
    const selectedRevision = memoryAiRevisions(memory).find(revision => revision.id === this.data.selectedRevisionId);
    const sourceText = selectedRevision?.text || memory.text;
    const draftText = text;
    const draftTitle = this.data.editTitle;
    const draftStory = this.data.editStory;
    const userAdditions = this.data.chatMessages.filter(message => message.role === "user").map(message => message.text);
    this.setData({ organizingPreview: true, previewNotice: "正在整理，原记忆不会因此改变。" });
    try {
      const draft = await organizeMemory({
        transcript: [draftText, ...userAdditions],
        memoryType: memory.memoryType ?? "note",
        memberName: this.data.memberName,
        storyTitle: this.data.editStory.trim() || undefined,
        memoryId: memory.id,
        expectedSavedText: sourceText,
        expectedSourceRevisionId: this.data.selectedRevisionId || undefined,
      });
      if (requestId !== this.organizeRequestId || !this.editingOriginal || this.editingOriginal.id !== memory.id) return;
      if (normalizeMemoryText(this.data.editText) !== draftText
        || this.data.editTitle !== draftTitle || this.data.editStory !== draftStory) {
        wx.showToast({ title: "文档已有新修改，未采用旧整理结果；请重新整理预览", icon: "none" });
        this.setData({ previewNotice: "文档已更新，请重新整理预览。" });
        return;
      }
      const aiSucceeded = draft.generationMode === "cloud-ai";
      this.setData({
        previewOpen: true,
        previewTitle: draft.title || this.data.editTitle || noteTitle(memory),
        previewText: draft.body,
        previewAiLabel: aiSucceeded ? "文字 AI 生成" : "",
        previewNotice: aiSucceeded
          ? "这是文档预览。确认保存后才会更新记忆。"
          : draft.fallbackReason === "consent-declined"
            ? "未获得 AI 整理授权，已保留当前草稿供你预览和保存。"
            : "云端 AI 整理未完成，以下是当前草稿预览；不会标记为 AI 整理结果。",
      });
    } catch (error) {
      if (requestId === this.organizeRequestId) {
        this.setData({ previewNotice: error instanceof Error ? error.message : "整理失败，草稿仍保留在本页。" });
      }
    } finally {
      if (requestId === this.organizeRequestId) this.setData({ organizingPreview: false });
    }
  },

  closeDocumentPreview() {
    this.pendingMemorySocialSend = false;
    this.setData({ previewOpen: false });
  },

  onPreviewTitleInput(event: WechatMiniprogram.Input) { this.setData({ previewTitle: event.detail.value }); },
  onPreviewTextInput(event: WechatMiniprogram.Input) { this.setData({ previewText: event.detail.value, previewAiLabel: "" }); },

  async savePreview(event: { currentTarget: { dataset: { mode: "update-current" | "dated-version" } } }) {
    const mode = event.currentTarget.dataset.mode;
    if (!this.data.previewOpen || this.data.savingEdit || !this.editingOriginal || !["update-current", "dated-version"].includes(mode)) return;
    this.setData({ savingEdit: true, loadError: "" });
    try {
      const title = this.data.previewTitle.trim().slice(0, 40) || undefined;
      const text = normalizeMemoryText(this.data.previewText);
      if (!text || text.length > MAX_MEMORY_LENGTH) throw new Error("请保留 1—500 字的记忆");
      const state = await loadRoomStateRemoteFirst();
      const latest = memoryPool(state.contributions).find(item => item.id === this.editingOriginal?.id);
      if (!latest) throw new Error("这段记忆已不存在，请刷新列表");
      const original = this.editingOriginal;
      const currentRevisionId = memoryAiRevisions(latest).slice(-1)[0]?.id || "";
      const originalRevisionId = memoryAiRevisions(original).slice(-1)[0]?.id || "";
      if (latest.text !== original.text || latest.title !== original.title || latest.storyTitle !== original.storyTitle || currentRevisionId !== originalRevisionId) {
        throw new Error("这段记忆已有新修改，请重新打开后再保存");
      }
      const nextBase = { ...latest, title, storyTitle: this.data.editStory.trim().slice(0, 30) || undefined, summary: undefined };
      const generatedByAi = this.data.previewAiLabel === "文字 AI 生成";
      const appended = appendAiRevision(nextBase, generatedByAi ? "ai" : "manual", text, title, generatedByAi ? "cloud-ai" : "local-demo");
      const revisions = memoryAiRevisions(appended);
      const now = new Date();
      const sameDay = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日版本`;
      const count = revisions.filter(revision => revision.versionLabel?.startsWith(sameDay)).length;
      const versionLabel = mode === "dated-version" ? `${sameDay}${count ? `（${count + 1}）` : ""}` : undefined;
      const savedRevision = { ...revisions[revisions.length - 1], saveKind: mode, ...(versionLabel ? { versionLabel } : {}) };
      const next = { ...appended, aiRevisions: [...revisions.slice(0, -1), savedRevision] };
      const returned = await replaceContributionRemoteFirst(next);
      let resultState = returned;
      let confirmed = memoryPool(returned.contributions).find(item => item.id === next.id);
      let confirmedRevisionId = confirmed && memoryAiRevisions(confirmed).slice(-1)[0]?.id;
      for (let attempt = 0; (!confirmed || confirmed.text !== next.text || confirmedRevisionId !== savedRevision.id) && attempt < 3; attempt += 1) {
        await waitForSaveConfirmation();
        resultState = await loadRoomStateRemoteFirst();
        confirmed = memoryPool(resultState.contributions).find(item => item.id === next.id);
        confirmedRevisionId = confirmed && memoryAiRevisions(confirmed).slice(-1)[0]?.id;
      }
      if (!confirmed || confirmed.text !== next.text || confirmedRevisionId !== savedRevision.id) {
        throw new Error("保存结果暂未确认，草稿仍保留；请重试前先重新加载核对");
      }
      this.editingOriginal = confirmed;
      this.setData({
        editTitle: confirmed.title || "",
        editText: confirmed.text,
        selectedRevisionId: savedRevision.id,
        selectedVersionLabel: memoryVersionLabel(savedRevision),
        isCurrentVersion: true,
        editStory: contributionStoryTitle(confirmed),
        ...storyGroupingState(this.data.storyOptions, contributionStoryTitle(confirmed)),
        editAiLabel: memoryAiLabel(confirmed),
        originalText: memoryOriginalSpokenText(confirmed),
        historyItems: historyRows(memoryAiRevisions(confirmed)),
        canRevertToSpoken: memoryAiRevisions(confirmed).length > 0 && memoryOriginalSpokenText(confirmed) !== confirmed.text,
        showOriginal: false,
        showHistory: false,
        isEditingDocument: false,
        previewOpen: false,
        previewNotice: "",
      });
      const nextPlacements = memoryPlacements(resultState).get(confirmed.id) ?? [];
      this.setData({ placements: nextPlacements });
      wx.showToast({ title: mode === "dated-version" ? "新版本已保存" : "当前记忆已更新", icon: "success" });
      if (this.pendingMemorySocialSend) {
        this.pendingMemorySocialSend = false;
        this.navigateMemorySocial(confirmed, savedRevision.id);
      }
    } catch (error) {
      this.setData({ previewNotice: error instanceof Error ? error.message : "保存未确认，草稿仍保留。" });
      wx.showToast({ title: error instanceof Error ? error.message : "保存未确认，草稿仍保留。", icon: "none" });
    } finally {
      this.setData({ savingEdit: false });
    }
  },

  revertToSpoken() {
    if (this.data.reverting || !this.editingOriginal) return;
    wx.showModal({
      title: "撤回到原话？",
      content: "会把这段记忆恢复成你最初说的原话，AI 整理和后续修改仍保留在历史里，可以随时查看。",
      confirmText: "撤回",
      success: (result) => {
        if (result.confirm) void this.confirmRevertToSpoken();
      },
    });
  },

  async confirmRevertToSpoken() {
    this.setData({ reverting: true });
    try {
      const state = await loadRoomStateRemoteFirst();
      const latest = memoryPool(state.contributions).find(item => item.id === this.data.editingId);
      if (!latest) throw new Error("这段记忆已不存在，请刷新列表");
      const reverted = revertMemoryToSpoken(latest);
      await replaceContributionRemoteFirst(reverted);
      this.editingOriginal = reverted;
      this.setData({
        editText: reverted.text,
        editAiLabel: memoryAiLabel(reverted),
        canRevertToSpoken: false,
        showOriginal: false,
        historyItems: historyRows(memoryAiRevisions(reverted)),
      });
      wx.showToast({ title: "已撤回到原话", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "撤回未成功，请重试", icon: "none" });
    } finally {
      this.setData({ reverting: false });
    }
  },

  async openMemory(event: { currentTarget: { dataset: { id: string } } }) {
    if (this.data.swipedItemId) { this.closeSwipe(); return; }
    const requestId = ++this.openMemoryRequestId;
    const memoryId = event.currentTarget.dataset.id;
    try {
      const state = await loadRoomStateRemoteFirst();
      if (requestId !== this.openMemoryRequestId) return;
      const memory = memoryPool(state.contributions).find(item => item.id === memoryId);
      if (!memory) throw new Error("这段记忆已不存在，请刷新列表");
      this.showEditor(memory);
      this.setData({ placements: memoryPlacements(state).get(memory.id) ?? [] });
    } catch (error) {
      if (requestId === this.openMemoryRequestId) wx.showToast({ title: error instanceof Error ? error.message : "加载失败，请重试", icon: "none" });
    }
  },

  onEditTitle(event: WechatMiniprogram.Input) { this.setData({ editTitle: event.detail.value }); },
  onEditText(event: WechatMiniprogram.Input) { this.setData({ editText: event.detail.value }); },
  onEditStory(event: WechatMiniprogram.Input) {
    const editStory = event.detail.value;
    this.setData({ editStory, ...storyGroupingState(this.data.storyOptions, editStory) });
  },
  chooseEditStory(event: { currentTarget: { dataset: { title: string } } }) {
    const editStory = event.currentTarget.dataset.title || "";
    this.setData({ editStory, ...storyGroupingState(this.data.storyOptions, editStory) });
  },
  createEditStory() {
    const title = normalizeStoryName(this.data.storyCreateTitle || this.data.editStory);
    if (!title || this.data.savingEdit) return;
    wx.showModal({
      title: "新建故事？",
      content: `没有找到同名故事。要新建「${title}」并把这段记忆放进去吗？`,
      confirmText: "新建",
      success: (result) => {
        if (!result.confirm) return;
        const storyOptions = uniqueStoryNames(this.data.storyOptions.concat([title]));
        this.setData({ storyOptions, editStory: title, ...storyGroupingState(storyOptions, title) });
      },
    });
  },
  hasUnsavedEditorWork() {
    const original = this.editingOriginal;
    const selected = original && memoryAiRevisions(original).find(revision => revision.id === this.data.selectedRevisionId);
    const documentChanged = original && (this.data.editTitle !== (selected?.title || original.title || "")
      || this.data.editText !== (selected?.text || original.text) || this.data.editStory !== contributionStoryTitle(original));
    const chatChanged = this.data.chatInput.trim().length > 0 || this.data.chatMessages.some(message => message.role === "user");
    return Boolean(documentChanged || chatChanged || this.data.previewOpen);
  },
  sendMemorySocial() {
    const original = this.editingOriginal;
    if (!original || this.data.savingEdit || this.data.organizingPreview) return;
    if (this.hasUnsavedEditorWork()) {
      this.pendingMemorySocialSend = true;
      if (this.data.previewOpen) {
        this.setData({ previewNotice: "请先选择更新当前记忆或另存为日期版本，保存成功后会继续发送。" });
        return;
      }
      void this.createDocumentPreview();
      wx.showToast({ title: "请先确认保存方式，保存后继续发送", icon: "none" });
      return;
    }
    const selected = memoryAiRevisions(original).find(revision => revision.id === this.data.selectedRevisionId);
    this.navigateMemorySocial(original, selected?.id);
  },
  navigateMemorySocial(memory: MemoryContribution, revisionId?: string) {
    const query = [
      "memoryId=" + encodeURIComponent(memory.id),
      revisionId ? "revisionId=" + encodeURIComponent(revisionId) : "",
    ].filter(Boolean).join("&");
    wx.navigateTo({ url: "/packages/story-sharing/pages/social/index?" + query });
  },
  closeEditor() {
    if (this.data.savingEdit) return;
    if (this.hasUnsavedEditorWork()) {
      wx.showModal({ title: "放弃本次修改？", content: "尚未保存的正文和对话会清除，原来的记忆仍会保留。", success: result => { if (result.confirm) this.discardEditor(); } });
      return;
    }
    this.discardEditor();
  },
  discardEditor() {
    this.chatRequestId++;
    this.organizeRequestId++;
    this.openMemoryRequestId++;
    this.pendingMemorySocialSend = false;
    this.editingOriginal = undefined;
    this.setData({ editingId: "", chatInput: "", chatMessages: [], previewOpen: false });
    this.onShow();
  },
  openPlacement(event: { currentTarget: { dataset: { member: string; chapter: string } } }) {
    const placement = this.data.placements.find(item => item.chapterId === event.currentTarget.dataset.chapter);
    const bookParam = placement?.storyId
      ? "storyId=" + encodeURIComponent(placement.storyId)
      : "memberId=" + encodeURIComponent(event.currentTarget.dataset.member);
    wx.navigateTo({ url: "/pages/book/book?" + bookParam + "&chapterId=" + encodeURIComponent(event.currentTarget.dataset.chapter) });
  },
  organizeIntoBook() {
    if (this.data.savingEdit) return;
    const original = this.editingOriginal;
    if (original && (this.data.editTitle !== (original.title || "") || this.data.editText !== original.text || this.data.editStory !== contributionStoryTitle(original))) {
      wx.showToast({ title: "请先保存记忆修改，再整理进书", icon: "none" }); return;
    }
    const storyTitle = original ? contributionStoryTitle(original) : "";
    const storyId = loadCurrentStoryId();
    const memoryIds = this.data.editingId ? encodeURIComponent(this.data.editingId) : this.data.unrecordedItems.map(item => encodeURIComponent(item.id)).join(",");
    const storyParam = storyTitle
      ? "storyId=" + encodeURIComponent(`story:${storyTitle}`)
      : storyId ? "storyId=" + encodeURIComponent(storyId) : "";
    const query = [storyParam, "memoryIds=" + memoryIds].filter(Boolean).join("&");
    wx.navigateTo({ url: "/pages/book/book?" + query });
  },
  startRecording() { wx.navigateTo({ url: "/pages/interview/interview?memoryType=note" }); },

  onNoteTouchStart(event: {
    currentTarget: { dataset: { id: string } };
    touches: Array<{ clientX: number; clientY: number }>;
  }) {
    const touch = event.touches[0];
    if (!touch) return;
    this.swipeStartX = touch.clientX;
    this.swipeStartY = touch.clientY;
    this.swipeActiveId = event.currentTarget.dataset.id || "";
  },

  onNoteTouchEnd(event: {
    currentTarget: { dataset: { id: string } };
    changedTouches: Array<{ clientX: number; clientY: number }>;
  }) {
    const touch = event.changedTouches[0];
    const itemId = event.currentTarget.dataset.id || this.swipeActiveId;
    if (!touch || !itemId) return;

    const deltaX = touch.clientX - this.swipeStartX;
    const deltaY = touch.clientY - this.swipeStartY;
    if (Math.abs(deltaX) > Math.abs(deltaY) && deltaX < -42) {
      this.setData({ swipedItemId: itemId });
    } else if (deltaX > 24 || Math.abs(deltaY) > Math.abs(deltaX)) {
      this.setData({ swipedItemId: "" });
    }
  },

  closeSwipe() {
    if (this.data.swipedItemId) {
      this.setData({ swipedItemId: "" });
    }
  },

  deleteMemory(event: {
    currentTarget: { dataset: { id: string; title: string } };
  }) {
    const contributionId = event.currentTarget.dataset.id || "";
    const title = event.currentTarget.dataset.title || "这条记忆";
    if (!contributionId || this.data.deletingItemId) return;

    wx.showModal({
      title: "删除记忆",
      content: `删除「${title}」吗？它会放进人生之书的「最近删除」，随时可以恢复；已经写进书里的文字不受影响。`,
      confirmText: "删除",
      confirmColor: "#c54d3f",
      success: (result) => {
        if (!result.confirm) return;
        void this.confirmDeleteMemory(contributionId);
      },
    });
  },

  async confirmDeleteMemory(contributionId: string) {
    this.setData({ deletingItemId: contributionId });
    try {
      await softDeleteMemoryRemoteFirst(contributionId);
      this.setData({ swipedItemId: "", deletingItemId: "" });
      await this.refresh();
      wx.showToast({ title: "已放进最近删除", icon: "none" });
    } catch (error) {
      this.setData({ deletingItemId: "" });
      await this.refresh().catch((error) => { logLoadError("archive", error); this.setData({ loadError: "删除结果尚未确认，请刷新后重试。" }); });
      wx.showToast({
        title: error instanceof Error ? error.message : "暂时无法删除",
        icon: "none",
      });
    }
  },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
