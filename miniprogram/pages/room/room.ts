import {
  createContribution,
  FamilyMember,
  FamilyRoomState,
  MAX_MEMORY_LENGTH,
  MemoryContribution,
  ReviewStatus,
  VISIBILITY_LABELS,
  Visibility,
  visibleContributionsForMember,
} from "../../domain/biography";
import { appendContribution, loadRoomState } from "../../services/roomStorage";

interface ContributionView extends MemoryContribution {
  avatarText: string;
  visibilityLabel: string;
  statusLabel: string;
}

const reviewStatusLabels: Record<ReviewStatus, string> = {
  pending: "待本人核对",
  confirmed: "本人已确认",
  conflict: "保留不同说法",
  rejected: "本人未采纳",
};

const CURRENT_MEMBER_ID = "owner";

function toContributionViews(
  contributions: MemoryContribution[],
  members: FamilyMember[],
): ContributionView[] {
  const avatarByMemberId = new Map(
    members.map((member) => [member.id, member.avatarText]),
  );

  return contributions.map((contribution) => ({
    ...contribution,
    avatarText:
      avatarByMemberId.get(contribution.authorMemberId) ?? contribution.authorName.slice(0, 1),
    visibilityLabel: VISIBILITY_LABELS[contribution.visibility],
    statusLabel:
      contribution.visibility === "private" && contribution.reviewStatus === "confirmed"
        ? "本人已确认 · 仍为私密，不进入传记"
        : reviewStatusLabels[contribution.reviewStatus],
  }));
}

Page({
  data: {
    roomName: "",
    protagonistName: "",
    members: [] as FamilyMember[],
    contributions: [] as ContributionView[],
    inputText: "",
    visibility: "family" as Visibility,
    maxLength: MAX_MEMORY_LENGTH,
    remaining: MAX_MEMORY_LENGTH,
  },

  onShow() {
    this.refresh();
  },

  refresh(state: FamilyRoomState = loadRoomState()) {
    const currentMember = state.members.find((member) => member.id === CURRENT_MEMBER_ID);
    const visibleContributions = currentMember
      ? visibleContributionsForMember(state.contributions, currentMember)
      : state.contributions.filter((contribution) => contribution.visibility === "family");

    this.setData({
      roomName: state.roomName,
      protagonistName: state.protagonistName,
      members: state.members,
      contributions: toContributionViews(visibleContributions, state.members),
    });
  },

  onInput(event: { detail: { value: string } }) {
    const inputText = event.detail.value;
    this.setData({
      inputText,
      remaining: Math.max(0, MAX_MEMORY_LENGTH - inputText.length),
    });
  },

  chooseVisibility(event: { currentTarget: { dataset: { visibility: Visibility } } }) {
    this.setData({ visibility: event.currentTarget.dataset.visibility });
  },

  submitMemory() {
    try {
      const contribution = createContribution({
        authorMemberId: CURRENT_MEMBER_ID,
        authorName: "林岚",
        relation: "外孙女",
        text: this.data.inputText,
        visibility: this.data.visibility,
      });
      const nextState = appendContribution(contribution, loadRoomState());
      this.setData({ inputText: "", remaining: MAX_MEMORY_LENGTH });
      this.refresh(nextState);
      wx.showToast({ title: "已交给外公核对", icon: "none" });
    } catch (error) {
      wx.showToast({
        title: error instanceof Error ? error.message : "暂时无法保存",
        icon: "none",
      });
    }
  },

  goToReview() {
    wx.navigateTo({ url: "/pages/review/review" });
  },
});
