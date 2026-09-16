import { contributionStoryTitle, MemoryContribution, memoryPool } from "../../domain/biography";
import { memoryDisplayTitle } from "../../domain/memoryTitle";
import { loadRoomStateRemoteFirst } from "../../services/roomRepository";
import { logLoadError } from "../../services/loadErrorLog";

interface RecentMemoryView {
  id: string;
  title: string;
  excerpt: string;
  storyLabel: string;
  storyTitle: string;
}

/** 「回忆录」里先让你挑一段：最近三段直接列出来，其余去「全部回忆」挑。 */
const RECENT_MEMORY_COUNT = 3;

function recentMemories(contributions: MemoryContribution[]): RecentMemoryView[] {
  return memoryPool(contributions)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, RECENT_MEMORY_COUNT)
    .map((memory) => ({
      id: memory.id,
      title: memoryDisplayTitle(memory),
      excerpt: memory.text.slice(0, 40),
      storyLabel: contributionStoryTitle(memory) || "还没放进故事",
      storyTitle: contributionStoryTitle(memory),
    }));
}

Component({
  data: {
    chooserOpen: false,
    memoirOpen: false,
    recent: [] as RecentMemoryView[],
    recentLoaded: false,
    recentError: "",
  },

  properties: {
    current: {
      type: String,
      value: "home",
    },
  },

  methods: {
    /** 人生之书是你所有的故事，不是某一本书稿。 */
    openPersonal() {
      if (this.data.current === "personal") return;
      wx.reLaunch({ url: "/pages/stories/stories" });
    },

    openFamily() {
      if (this.data.current === "family") return;
      wx.reLaunch({ url: "/pages/room/room" });
    },

    startInterview() {
      this.setData({ chooserOpen: true, memoirOpen: false });
    },

    closeChooser() {
      this.setData({ chooserOpen: false, memoirOpen: false });
    },

    keepChooserOpen() {
      // 阻止点击古籍按钮区域时触发遮罩关闭。
    },

    /** 随手记：直接开一段新的，不用先挑。 */
    startQuickNote() {
      this.setData({ chooserOpen: false, memoirOpen: false });
      wx.navigateTo({ url: "/pages/interview/interview?memoryType=note" });
    },

    /** 回忆录：先想起哪一段，再接着聊。 */
    async openMemoir() {
      this.setData({ memoirOpen: true, recentError: "" });
      try {
        const state = await loadRoomStateRemoteFirst();
        this.setData({ recent: recentMemories(state.contributions), recentLoaded: true });
      } catch (error) {
        logLoadError("story-switcher", error);
        this.setData({ recentLoaded: true, recentError: "回忆暂时没加载出来，可以先随手记一段。" });
      }
    },

    continueMemory(event: { currentTarget: { dataset: { id: string; title: string } } }) {
      const { id, title } = event.currentTarget.dataset;
      this.setData({ chooserOpen: false, memoirOpen: false });
      wx.navigateTo({
        url: `/pages/interview/interview?memoryType=memoir&sourceId=${encodeURIComponent(id)}&storyTitle=${encodeURIComponent(title || "")}`,
      });
    },

    /** 第四个入口：从全部回忆里挑一段。 */
    openAllMemories() {
      this.setData({ chooserOpen: false, memoirOpen: false });
      wx.navigateTo({ url: "/pages/recall/recall" });
    },
  },
});
