import {
  contributionStoryTitle,
  MemoryContribution,
  personalBookContributions,
} from "../../domain/biography";
import {
  loadCurrentMember,
  loadRoomState,
} from "../../services/roomStorage";

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
  },

  onLoad(options: { tab?: string }) {
    this.setData({ activeTab: options.tab === "memoir" ? "memoir" : "note" });
  },

  onShow() {
    this.refresh();
  },

  selectArchiveTab(event: {
    currentTarget: { dataset: { tab: ArchiveTab } };
  }) {
    const activeTab = event.currentTarget.dataset.tab === "memoir" ? "memoir" : "note";
    this.setData({ activeTab });
    this.refresh();
  },

  refresh() {
    const state = loadRoomState();
    const member = loadCurrentMember(state);
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
});
