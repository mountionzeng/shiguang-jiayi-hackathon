import {
  FamilyRoomState,
  MemoryContribution,
  biographySourceContributions,
  pendingFamilyContributions,
  reviewContribution,
  ReviewStatus,
  VISIBILITY_LABELS,
} from "../../domain/biography";
import {
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  replaceContributionRemoteFirst,
} from "../../services/roomRepository";

interface FocusView {
  id: string;
  text: string;
  authorName: string;
  relation: string;
  avatarText: string;
  dateLabel: string;
  visibilityLabel: string;
  isPrivate: boolean;
  confirmLabel: string;
}

const actionLabels: Record<Exclude<ReviewStatus, "pending">, string> = {
  confirmed: "已确认属实",
  conflict: "已保留不同说法",
  rejected: "已记为不是这样",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

Page({
  data: {
    protagonistName: "",
    // 只有老人本人可以进入核对流程，其他身份看到的是解释而不是操作。
    isElder: false,
    viewerName: "",

    focus: null as FocusView | null,
    pendingCount: 0,
    handledCount: 0,
    confirmedCount: 0,
    positionLabel: "",
  },

  onShow() {
    void this.refresh();
  },

  async refresh(state?: FamilyRoomState) {
    const currentState = state ?? await loadRoomStateRemoteFirst();
    const viewer = await loadCurrentMemberRemoteFirst(currentState);
    const isElder = viewer.role === "elder";
    const familyContributions = currentState.contributions.filter(
      (item) => item.scope !== "personal",
    );
    const pending = pendingFamilyContributions(familyContributions);
    const handled = familyContributions.length - pending.length;
    const avatarByMember = new Map(
      currentState.members.map((member) => [member.id, member.avatarText]),
    );

    const next: MemoryContribution | undefined = pending[0];
    const focus: FocusView | null =
      isElder && next
        ? {
            id: next.id,
            text: next.text,
            authorName: next.authorName,
            relation: next.relation,
            avatarText:
              avatarByMember.get(next.authorMemberId) ?? next.authorName.slice(0, 1),
            dateLabel: formatDate(next.createdAt),
            visibilityLabel: VISIBILITY_LABELS[next.visibility],
            isPrivate: next.visibility === "private",
            confirmLabel: next.visibility === "private" ? "属实，但继续只给我看" : "对，是这样",
          }
        : null;

    this.setData({
      protagonistName: currentState.protagonistName,
      isElder,
      viewerName: viewer.name,
      focus,
      pendingCount: pending.length,
      handledCount: handled,
      confirmedCount: biographySourceContributions(currentState.contributions).length,
      positionLabel:
        pending.length > 0 ? `还剩 ${pending.length} 条，一次只看一条` : "",
    });
  },

  async reviewMemory(event: {
    currentTarget: { dataset: { status: Exclude<ReviewStatus, "pending"> } };
  }) {
    const focus = this.data.focus;
    if (!focus) return;

    const { status } = event.currentTarget.dataset;
    const state = await loadRoomStateRemoteFirst();
    const viewer = await loadCurrentMemberRemoteFirst(state);
    const target = state.contributions.find((item) => item.id === focus.id);
    if (!target) {
      wx.showToast({ title: "没有找到这一条", icon: "none" });
      return;
    }

    try {
      // 确认权由领域层按真实身份判定，页面不再代传 elder。
      const nextState = await replaceContributionRemoteFirst(
        reviewContribution(target, status, viewer.role),
      );
      wx.showToast({ title: actionLabels[status], icon: "none" });
      void this.refresh(nextState);
    } catch (error) {
      wx.showToast({
        title: error instanceof Error ? error.message : "暂时无法核对",
        icon: "none",
      });
    }
  },

  goToMemoryHome() {
    wx.switchTab({ url: "/pages/room/room" });
  },

  goBack() {
    wx.navigateBack();
  },
});
