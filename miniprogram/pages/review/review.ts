import {
  biographySourceContributions,
  FamilyRoomState,
  MemoryContribution,
  reviewContribution,
  ReviewStatus,
  VISIBILITY_LABELS,
} from "../../domain/biography";
import { loadCurrentMember, loadRoomState, replaceContribution } from "../../services/roomStorage";

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
    this.refresh();
  },

  refresh(state: FamilyRoomState = loadRoomState()) {
    const viewer = loadCurrentMember(state);
    const isElder = viewer.role === "elder";
    const pending = state.contributions.filter((item) => item.reviewStatus === "pending");
    const handled = state.contributions.length - pending.length;
    const avatarByMember = new Map(
      state.members.map((member) => [member.id, member.avatarText]),
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
      protagonistName: state.protagonistName,
      isElder,
      viewerName: viewer.name,
      focus,
      pendingCount: pending.length,
      handledCount: handled,
      confirmedCount: biographySourceContributions(state.contributions).length,
      positionLabel:
        pending.length > 0 ? `还剩 ${pending.length} 条，一次只看一条` : "",
    });
  },

  reviewMemory(event: {
    currentTarget: { dataset: { status: Exclude<ReviewStatus, "pending"> } };
  }) {
    const focus = this.data.focus;
    if (!focus) return;

    const { status } = event.currentTarget.dataset;
    const state = loadRoomState();
    const viewer = loadCurrentMember(state);
    const target = state.contributions.find((item) => item.id === focus.id);
    if (!target) {
      wx.showToast({ title: "没有找到这一条", icon: "none" });
      return;
    }

    try {
      // 确认权由领域层按真实身份判定，页面不再代传 elder。
      const nextState = replaceContribution(
        reviewContribution(target, status, viewer.role),
        state,
      );
      wx.showToast({ title: actionLabels[status], icon: "none" });
      this.refresh(nextState);
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

  goBack() {
    wx.navigateBack();
  },
});
