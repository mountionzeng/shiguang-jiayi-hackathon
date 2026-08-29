import {
  biographySourceContributions,
  contributionScope,
  contributionRelatedMemberIds,
  contributionStoryTitle,
  FamilyMember,
  MEMORY_TYPE_LABELS,
  FamilyRoomState,
  MemoryContribution,
  pendingContributionsFor,
  personalShareTargetMemberIds,
  revokeFamilyVisibility,
} from "../../domain/biography";
import {
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  replaceContributionRemoteFirst,
  updatePersonalShareTargetsRemoteFirst,
} from "../../services/roomRepository";

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
  storyLabel: string;
  accessLabel: string;
  isPersonal: boolean;
}

interface MemberFilter {
  id: string;
  name: string;
  avatarText: string;
  count: number;
  isElder: boolean;
}

const ALL = "all";

function memoryMatchesMember(
  memory: MemoryContribution,
  memberId: string,
): boolean {
  return (
    memory.authorMemberId === memberId ||
    contributionRelatedMemberIds(memory).includes(memberId)
  );
}

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
    void this.refresh();
  },

  async refresh(state?: FamilyRoomState) {
    const currentState = state ?? await loadRoomStateRemoteFirst();
    const viewer = await loadCurrentMemberRemoteFirst(currentState);

    // 新记录按每段故事的阅读名单进入记忆之家；旧版家庭时间线继续兼容。
    // 仅自己可见的记录和未确认的旧家庭投稿都不会出现在这里。
    const legacyFamilyMemories = biographySourceContributions(currentState.contributions);
    const permissionedMemories = currentState.contributions.filter((memory) => {
      if (contributionScope(memory) !== "personal") return false;
      const readers = personalShareTargetMemberIds(memory);
      return readers.includes(viewer.id) || (
        memory.authorMemberId === viewer.id && readers.length > 0
      );
    });
    const qualified = legacyFamilyMemories.concat(permissionedMemories);
    const avatarByMember = new Map(
      currentState.members.map((member) => [member.id, member.avatarText]),
    );

    const filters: MemberFilter[] = [
      { id: ALL, name: "全部", avatarText: "全", count: qualified.length, isElder: false },
      ...currentState.members.map((member: FamilyMember) => ({
        id: member.id,
        name: member.name,
        avatarText: member.avatarText,
        count: qualified.filter((item) => memoryMatchesMember(item, member.id)).length,
        isElder: member.role === "elder",
      })),
    ];

    const activeFilter = filters.some((filter) => filter.id === this.data.activeFilter)
      ? this.data.activeFilter
      : ALL;

    const shown =
      activeFilter === ALL
        ? qualified
        : qualified.filter((item) => memoryMatchesMember(item, activeFilter));

    const timeline: TimelineItem[] = shown
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((item: MemoryContribution) => ({
        id: item.id,
        text: item.text,
        title: item.title ?? "",
        typeLabel: MEMORY_TYPE_LABELS[item.memoryType ?? "note"],
        storyLabel: contributionStoryTitle(item) || "未整理片段",
        accessLabel: contributionScope(item) === "personal"
          ? `指定 ${personalShareTargetMemberIds(item).length} 人可看`
          : "旧版家庭可见",
        isPersonal: contributionScope(item) === "personal",
        authorName: item.authorName,
        relation: item.relation,
        avatarText: avatarByMember.get(item.authorMemberId) ?? item.authorName.slice(0, 1),
        dateLabel: formatDate(item.createdAt),
        timeLabel: formatTime(item.createdAt),
        isMine: item.authorMemberId === viewer.id,
      }));

    this.setData({
      roomName: currentState.roomName,
      protagonistName: currentState.protagonistName,
      viewerId: viewer.id,
      viewerName: viewer.name,
      filters,
      activeFilter,
      totalCount: qualified.length,
      timeline,
      hasAnyQualified: qualified.length > 0,
      myPendingCount: pendingContributionsFor(currentState.contributions, viewer).length,
      pendingCount: currentState.contributions.filter(
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
    void this.refresh();
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

  /** 新故事清空阅读名单；旧版家庭记忆沿用撤下家庭时间线的兼容逻辑。 */
  async revokeSharing() {
    const detail = this.data.detail;
    if (!detail) return;

    await new Promise<void>((resolve) => {
      wx.showModal({
        title: "停止分享这段故事",
        content: "已授权的亲友将不再看到这一段。原始记录仍会留在你的故事或未整理片段里。",
        confirmText: "撤下",
        cancelText: "再想想",
        success: async (result) => {
          if (!result.confirm) {
            resolve();
            return;
          }

          const state = await loadRoomStateRemoteFirst();
          const target = state.contributions.find((item) => item.id === detail.id);
          const viewer = await loadCurrentMemberRemoteFirst(state);
          if (!target) {
            wx.showToast({ title: "没有找到这一段", icon: "none" });
            resolve();
            return;
          }

          try {
            const nextState = contributionScope(target) === "personal"
              ? await updatePersonalShareTargetsRemoteFirst(target.id, viewer, [])
              : await replaceContributionRemoteFirst(revokeFamilyVisibility(target, viewer));
            this.setData({ detail: null });
            await this.refresh(nextState);
            wx.showToast({ title: "已停止分享", icon: "none", duration: 2200 });
          } catch (error) {
            wx.showToast({
              title: error instanceof Error ? error.message : "暂时无法撤下",
              icon: "none",
            });
          } finally {
            resolve();
          }
        },
        fail: () => resolve(),
      });
    });
  },

  startInterview() {
    wx.navigateTo({ url: "/pages/interview/interview" });
  },

  openReview() {
    wx.navigateTo({ url: "/pages/review/review" });
  },

  goHome() {
    wx.switchTab({ url: "/pages/index/index" });
  },
});
