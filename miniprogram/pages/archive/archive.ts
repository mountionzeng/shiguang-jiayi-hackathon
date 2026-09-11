import {
  contributionStoryTitle,
  MemoryContribution,
  personalBookContributions,
  normalizeMemoryText,
  MAX_MEMORY_LENGTH,
} from "../../domain/biography";
import {
  loadCurrentMemberRemoteFirst,
  deleteContributionRemoteFirst,
  loadRoomStateRemoteFirst,
  replaceContributionRemoteFirst,
  roomDataModeLabel,
} from "../../services/roomRepository";

type ArchiveTab = "note" | "memoir";

interface NoteView {
  id: string;
  title: string;
  excerpt: string;
  dateLabel: string;
  archiveLabel: string;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function noteTitle(memory: MemoryContribution): string {
  const storedTitle = typeof memory.title === "string" ? memory.title.trim() : "";
  if (storedTitle) return storedTitle;
  const firstSentence = memory.text.split(/[。！？!?]/)[0].trim();
  return firstSentence.slice(0, 18) || "一段随手记";
}

Page({
  data: {
    memberName: "",
    notes: [] as NoteView[],
    noteCount: 0,
    hasNotes: false,
    memoirCount: 0,
    activeTab: "note" as ArchiveTab,
    archiveItems: [] as NoteView[],
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
    void this.refresh().catch(() => this.setData({ loadError: "记忆暂时未加载成功，请重试。原有记录不会被清空。" }));
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
    const personal = personalBookContributions(state.contributions, member.id);
    const toViews = (memoryType?: ArchiveTab) => personal
      .filter((memory) => !memoryType || (memory.memoryType ?? "note") === memoryType)
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((memory) => {
        const storyTitle = contributionStoryTitle(memory);
        return {
          id: memory.id,
          title: noteTitle(memory),
          excerpt: memory.text,
          dateLabel: formatDate(memory.createdAt),
          archiveLabel: storyTitle ? `已归入「${storyTitle}」` : "尚未归入故事",
        };
      });
    const notes = toViews("note");
    const memoirs = toViews("memoir");
    const archiveItems = toViews();

    this.setData({
      memberName: member.name,
      notes,
      noteCount: notes.length,
      hasNotes: notes.length > 0,
      memoirCount: memoirs.length,
      archiveItems,
      hasItems: archiveItems.length > 0,
      storyOptions: [...new Set(personal.map(contributionStoryTitle).filter(Boolean))],
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
    this.setData({ editingId: memory.id, editTitle: memory.title || "", editText: memory.text, editStory: contributionStoryTitle(memory), swipedItemId: "" });
  },

  async openMemory(event: { currentTarget: { dataset: { id: string } } }) {
    if (this.data.swipedItemId) { this.closeSwipe(); return; }
    try {
      const state = await loadRoomStateRemoteFirst();
      const member = await loadCurrentMemberRemoteFirst(state);
      const memory = personalBookContributions(state.contributions, member.id).find(item => item.id === event.currentTarget.dataset.id);
      if (!memory) throw new Error("这段记忆已不存在，请刷新列表");
      this.showEditor(memory);
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
      const member = await loadCurrentMemberRemoteFirst(state);
      const latest = personalBookContributions(state.contributions, member.id).find(item => item.id === this.data.editingId);
      if (!latest) throw new Error("这段记忆已不存在，请刷新列表");
      const original = this.editingOriginal;
      if (latest.text !== original.text || latest.title !== original.title || latest.storyTitle !== original.storyTitle) {
        throw new Error("这段记忆已有新修改，请重新打开后编辑");
      }
      const next = { ...latest, text, title: this.data.editTitle.trim().slice(0, 40) || undefined, storyTitle: this.data.editStory.trim().slice(0, 30) || undefined,
        summary: text === latest.text ? latest.summary : undefined };
      await replaceContributionRemoteFirst(next);
      this.editingOriginal = next;
      wx.showToast({ title: "修改已保存", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "修改未确认，请重试", icon: "none" });
    } finally { this.setData({ savingEdit: false }); }
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
      content: `确定删除「${title}」这条原始记录吗？已保存的书稿与历史版本仍保留。原始记录删除后不可恢复。`,
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
      await deleteContributionRemoteFirst(contributionId);
      this.setData({ swipedItemId: "", deletingItemId: "" });
      await this.refresh();
      wx.showToast({ title: "已删除", icon: "none" });
    } catch (error) {
      this.setData({ deletingItemId: "" });
      await this.refresh().catch(() => this.setData({ loadError: "删除结果尚未确认，请刷新后重试。" }));
      wx.showToast({
        title: error instanceof Error ? error.message : "暂时无法删除",
        icon: "none",
      });
    }
  },
});
