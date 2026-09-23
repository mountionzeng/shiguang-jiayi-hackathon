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
import { logLoadError } from "../../services/loadErrorLog";
import { loadCurrentStoryId } from "../../services/storySelection";

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
    .map((revision) => ({
      id: revision.id,
      kindLabel: HISTORY_KIND_LABELS[revision.kind] || revision.kind,
      text: revision.text,
      dateLabel: formatDate(revision.createdAt),
    }));
}

function noteTitle(memory: MemoryContribution): string {
  const storedTitle = typeof memory.title === "string" ? memory.title.trim() : "";
  if (storedTitle) return storedTitle;
  const firstSentence = memory.text.split(/[。！？!?]/)[0].trim();
  return firstSentence.slice(0, 18) || "一段随手记";
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
    editStory: "",
    storyOptions: [] as string[],
    savingEdit: false,
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
  editingOriginal: undefined as MemoryContribution | undefined,

  onLoad(options: { tab?: string; id?: string }) {
    this.setData({ activeTab: options.tab === "memoir" ? "memoir" : "note" });
    if (options.id) this.setData({ editingId: options.id });
  },

  onShow() {
    void this.refresh().catch((error) => { logLoadError("archive", error); this.setData({ loadError: "记忆暂时未加载成功，请重试。原有记录不会被清空。" }); });
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
      storyOptions: [...new Set(personal.map(contributionStoryTitle)
        .filter((title) => Boolean(title) && !deletedStoryTitles.has(title)))],
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
    const revisions = memoryAiRevisions(memory);
    const original = memoryOriginalSpokenText(memory);
    this.setData({
      editingId: memory.id,
      editTitle: memory.title || "",
      editText: memory.text,
      editStory: contributionStoryTitle(memory),
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
    try {
      const state = await loadRoomStateRemoteFirst();
      const memory = memoryPool(state.contributions).find(item => item.id === event.currentTarget.dataset.id);
      if (!memory) throw new Error("这段记忆已不存在，请刷新列表");
      this.showEditor(memory);
      this.setData({ placements: memoryPlacements(state).get(memory.id) ?? [] });
    } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "加载失败，请重试", icon: "none" }); }
  },

  onEditTitle(event: WechatMiniprogram.Input) { this.setData({ editTitle: event.detail.value }); },
  onEditText(event: WechatMiniprogram.Input) { this.setData({ editText: event.detail.value }); },
  onEditStory(event: WechatMiniprogram.Input) { this.setData({ editStory: event.detail.value }); },
  chooseEditStory(event: { currentTarget: { dataset: { title: string } } }) {
    this.setData({ editStory: event.currentTarget.dataset.title || "" });
  },
  closeEditor() {
    if (this.data.savingEdit) return;
    const original = this.editingOriginal;
    if (original && (this.data.editTitle !== (original.title || "") || this.data.editText !== original.text || this.data.editStory !== contributionStoryTitle(original))) {
      wx.showModal({ title: "放弃本次修改？", content: "原来的记忆仍会保留。", success: result => { if (result.confirm) this.discardEditor(); } });
      return;
    }
    this.discardEditor();
  },
  discardEditor() {
    this.editingOriginal = undefined;
    this.setData({ editingId: "" });
    this.onShow();
  },
  async saveEdit() {
    if (this.data.savingEdit || !this.editingOriginal) return;
    this.setData({ savingEdit: true });
    try {
      const text = normalizeMemoryText(this.data.editText);
      if (!text || text.length > MAX_MEMORY_LENGTH) throw new Error("请保留 1—500 字的记忆");
      const state = await loadRoomStateRemoteFirst();
      const latest = memoryPool(state.contributions).find(item => item.id === this.data.editingId);
      if (!latest) throw new Error("这段记忆已不存在，请刷新列表");
      const original = this.editingOriginal;
      if (latest.text !== original.text || latest.title !== original.title || latest.storyTitle !== original.storyTitle) {
        throw new Error("这段记忆已有新修改，请重新打开后编辑");
      }
      const title = this.data.editTitle.trim().slice(0, 40) || undefined;
      const textChanged = text !== latest.text;
      const withEdits = { ...latest, title, storyTitle: this.data.editStory.trim().slice(0, 30) || undefined,
        summary: textChanged ? undefined : latest.summary };
      // 只有正文真的改了才追加一条 manual 历史；只改标题/分组不会假装成一次人工修改。
      const next = textChanged && memoryAiRevisions(latest).length > 0
        ? appendAiRevision(withEdits, "manual", text, title, latest.organizationMode)
        : { ...withEdits, text };
      await replaceContributionRemoteFirst(next);
      this.editingOriginal = next;
      this.setData({
        editAiLabel: memoryAiLabel(next),
        originalText: memoryOriginalSpokenText(next),
        canRevertToSpoken: memoryAiRevisions(next).length > 0 && memoryOriginalSpokenText(next) !== next.text,
        historyItems: historyRows(memoryAiRevisions(next)),
      });
      wx.showToast({ title: "修改已保存", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "修改未确认，请重试", icon: "none" });
    } finally { this.setData({ savingEdit: false }); }
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
    const storyId = loadCurrentStoryId();
    const memoryIds = this.data.editingId ? encodeURIComponent(this.data.editingId) : this.data.unrecordedItems.map(item => encodeURIComponent(item.id)).join(",");
    const query = [storyId ? "storyId=" + encodeURIComponent(storyId) : "", "memoryIds=" + memoryIds].filter(Boolean).join("&");
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
