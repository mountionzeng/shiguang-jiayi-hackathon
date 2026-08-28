import {
  biographySourceContributions,
  FamilyRoomState,
  MemoryContribution,
  reviewContribution,
  ReviewStatus,
  VISIBILITY_LABELS,
} from "../../domain/biography";
import {
  loadRoomStateRemoteFirst,
  replaceContributionRemoteFirst,
} from "../../services/roomRepository";

interface PendingMemoryView extends MemoryContribution {
  visibilityLabel: string;
  reviewQuestion: string;
  confirmLabel: string;
}

const actionLabels: Record<Exclude<ReviewStatus, "pending">, string> = {
  confirmed: "已确认为事实",
  conflict: "已保留不同说法",
  rejected: "已标记为不采用",
};

Page({
  data: {
    protagonistName: "",
    pending: [] as PendingMemoryView[],
    confirmedCount: 0,
    handledCount: 0,
  },

  async onShow() {
    await this.refresh();
  },

  async refresh(state?: FamilyRoomState) {
    const roomState = state ?? (await loadRoomStateRemoteFirst());
    this.setData({
      protagonistName: roomState.protagonistName,
      pending: roomState.contributions
        .filter((item) => item.reviewStatus === "pending")
        .map((item) => ({
          ...item,
          visibilityLabel: VISIBILITY_LABELS[item.visibility],
          reviewQuestion:
            item.visibility === "private"
              ? "这件事属实吗？私密内容确认后仍不会写入传记。"
              : "这件事可以写进你的传记吗？",
          confirmLabel:
            item.visibility === "private" ? "确认属实，继续保密" : "是的，这是事实",
        })),
      confirmedCount: biographySourceContributions(roomState.contributions).length,
      handledCount: roomState.contributions.filter(
        (item) => item.reviewStatus !== "pending",
      ).length,
    });
  },

  async reviewMemory(event: {
    currentTarget: {
      dataset: { id: string; status: Exclude<ReviewStatus, "pending"> };
    };
  }) {
    const { id, status } = event.currentTarget.dataset;
    const state = await loadRoomStateRemoteFirst();
    const target = state.contributions.find((item) => item.id === id);
    if (!target) {
      wx.showToast({ title: "没有找到这段回忆", icon: "none" });
      return;
    }

    try {
      const nextState = await replaceContributionRemoteFirst(
        reviewContribution(target, status, "elder"),
      );
      wx.showToast({ title: actionLabels[status], icon: "none" });
      await this.refresh(nextState);
    } catch (error) {
      wx.showToast({
        title: error instanceof Error ? error.message : "暂时无法核对",
        icon: "none",
      });
    }
  },

  goToBook() {
    wx.navigateTo({ url: "/pages/book/book" });
  },

  goBackToRoom() {
    wx.navigateBack();
  },
});
