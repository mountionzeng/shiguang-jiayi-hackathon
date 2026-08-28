import {
  biographySourceContributions,
  FamilyMember,
  MEMORY_TYPE_LABELS,
  FamilyRoomState,
  MemoryContribution,
  pendingContributionsFor,
  revokeFamilyVisibility,
} from "../../domain/biography";
import {
  loadCurrentMember,
  loadRoomState,
  replaceContribution,
} from "../../services/roomStorage";

interface TimelineItem {
  id: string;
  text: string;
  authorName: string;
  relation: string;
  avatarText: string;
  dateLabel: string;
  timeLabel: string;
  isMine: boolean;
  title: string;
  typeLabel: string;
}

interface MemberFilter {
  id: string;
  name: string;
  avatarText: string;
  count: number;
  isElder: boolean;
}

const ALL = "all";

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hh = `${date.getHours()}`.padStart(2, "0");
  const mm = `${date.getMinutes()}`.padStart(2, "0");
  return `${hh}:${mm}`;
}

Page({
  data: {
    roomName: "",
    protagonistName: "",
    viewerId: "",
    viewerName: "",

    filters: [] as MemberFilter[],
    activeFilter: ALL,
    totalCount: 0,

    timeline: [] as TimelineItem[],
    hasAnyQualified: false,

    myPendingCount: 0,
    pendingCount: 0,
    canReview: false,

    detail: null as TimelineItem | null,
  },

  onShow() {
    const tabBar = (this as unknown as { getTabBar?: () => { setData: (d: object) => void } | undefined })
      .getTabBar;
    if (typeof tabBar === "function") {
      const bar = tabBar.call(this);
      if (bar) bar.setData({ selected: 1 });
    }
    this.refresh();
  },

  refresh(state: FamilyRoomState = loadRoomState()) {
    const viewer = loadCurrentMember(state);

    // 记忆之家只呈现"家庭故事 + 已确认 + 家庭可见"的片段。
    // personal 作用域的内容永远只留在各自的人生之书。
    // 待确认、拒绝、冲突和私密投稿一律不进入这条时间线。
    const qualified = biographySourceContributions(state.contributions);
    const avatarByMember = new Map(
      state.members.map((member) => [member.id, member.avatarText]),
    );

    const filters: MemberFilter[] = [
      { id: ALL, name: "全部", avatarText: "全", count: qualified.length, isElder: false },
      ...state.members.map((member: FamilyMember) => ({
        id: member.id,
        name: member.name,
        avatarText: member.avatarText,
        count: qualified.filter((item) => item.authorMemberId === member.id).length,
        isElder: member.role === "elder",
      })),
    ];

    const activeFilter = filters.some((filter) => filter.id === this.data.activeFilter)
      ? this.data.activeFilter
      : ALL;

    const shown =
      activeFilter === ALL
        ? qualified
        : qualified.filter((item) => item.authorMemberId === activeFilter);

    const timeline: TimelineItem[] = shown
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((item: MemoryContribution) => ({
        id: item.id,
        text: item.text,
        title: item.title ?? "",
        typeLabel: MEMORY_TYPE_LABELS[item.memoryType ?? "note"],
        authorName: item.authorName,
        relation: item.relation,
        avatarText: avatarByMember.get(item.authorMemberId) ?? item.authorName.slice(0, 1),
        dateLabel: formatDate(item.createdAt),
        timeLabel: formatTime(item.createdAt),
        isMine: item.authorMemberId === viewer.id,
      }));

    this.setData({
      roomName: state.roomName,
      protagonistName: state.protagonistName,
      viewerId: viewer.id,
      viewerName: viewer.name,
      filters,
      activeFilter,
      totalCount: qualified.length,
      timeline,
      hasAnyQualified: qualified.length > 0,
      myPendingCount: pendingContributionsFor(state.contributions, viewer).length,
      pendingCount: state.contributions.filter(
        (item) => item.scope !== "personal" && item.reviewStatus === "pending",
      ).length,
      canReview: viewer.role === "elder",
      detail: this.data.detail
        ? timeline.find((item) => item.id === this.data.detail!.id) ?? null
        : null,
    });
  },

  chooseFilter(event: { currentTarget: { dataset: { id: string } } }) {
    this.setData({ activeFilter: event.currentTarget.dataset.id });
    this.refresh();
  },

  openDetail(event: { currentTarget: { dataset: { id: string } } }) {
    const detail = this.data.timeline.find(
      (item) => item.id === event.currentTarget.dataset.id,
    );
    if (detail) this.setData({ detail });
  },

  closeDetail() {
    this.setData({ detail: null });
  },

  copyDetail() {
    if (!this.data.detail) return;
    wx.setClipboardData({ data: this.data.detail.text });
  },

  /** 撤下只解除家庭可见，不会误塞进任何人的人生之书。 */
  revokeSharing() {
    const detail = this.data.detail;
    if (!detail) return;

    wx.showModal({
      title: "从记忆之家撤下",
      content: "其他家人将不再看到这一段。它不会进入任何人的人生之书，原始记录仍由你保留。",
      confirmText: "撤下",
      cancelText: "再想想",
      success: (result) => {
        if (!result.confirm) return;

        const state = loadRoomState();
        const target = state.contributions.find((item) => item.id === detail.id);
        const viewer = loadCurrentMember(state);
        if (!target) {
          wx.showToast({ title: "没有找到这一段", icon: "none" });
          return;
        }

        try {
          const nextState = replaceContribution(
            revokeFamilyVisibility(target, viewer),
            state,
          );
          this.setData({ detail: null });
          this.refresh(nextState);
          wx.showToast({ title: "已从记忆之家撤下", icon: "none", duration: 2200 });
        } catch (error) {
          wx.showToast({
            title: error instanceof Error ? error.message : "暂时无法撤下",
            icon: "none",
          });
        }
      },
    });
  },

  startInterview() {
    wx.navigateTo({ url: "/pages/interview/interview?mode=family" });
  },

  openReview() {
    wx.navigateTo({ url: "/pages/review/review" });
  },

  goHome() {
    wx.switchTab({ url: "/pages/index/index" });
  },
});
