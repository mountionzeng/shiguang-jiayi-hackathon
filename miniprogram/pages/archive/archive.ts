import {
  contributionStoryTitle,
  MemoryContribution,
  personalBookContributions,
} from "../../domain/biography";
import {
  loadCurrentMemberRemoteFirst,
  deleteContributionRemoteFirst,
  loadRoomStateRemoteFirst,
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
  },

  swipeStartX: 0,
  swipeStartY: 0,
  swipeActiveId: "",

  onLoad(options: { tab?: string }) {
    this.setData({ activeTab: options.tab === "memoir" ? "memoir" : "note" });
  },

  onShow() {
    void this.refresh();
  },

  selectArchiveTab(event: {
    currentTarget: { dataset: { tab: ArchiveTab } };
  }) {
    const activeTab = event.currentTarget.dataset.tab === "memoir" ? "memoir" : "note";
    this.setData({ activeTab, swipedItemId: "" });
    void this.refresh();
  },

  async refresh() {
    const state = await loadRoomStateRemoteFirst();
    const member = await loadCurrentMemberRemoteFirst(state);
    const personal = personalBookContributions(state.contributions, member.id);
    const toViews = (memoryType: ArchiveTab) => personal
      .filter((memory) => (memory.memoryType ?? "note") === memoryType)
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
    const archiveItems = this.data.activeTab === "memoir" ? memoirs : notes;

    this.setData({
      memberName: member.name,
      notes,
      noteCount: notes.length,
      hasNotes: notes.length > 0,
      memoirCount: memoirs.length,
      archiveItems,
      hasItems: archiveItems.length > 0,
    });
  },

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
      content: `确定删除「${title}」吗？删除后不可恢复。`,
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
      wx.showToast({
        title: error instanceof Error ? error.message : "暂时无法删除",
        icon: "none",
      });
    }
  },
});
