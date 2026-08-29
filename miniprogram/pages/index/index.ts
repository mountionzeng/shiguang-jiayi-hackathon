import {
  FamilyMember,
  FamilyRoomState,
  MEMORY_TYPE_LABELS,
  MemoryContribution,
  contributionStoryTitle,
  personalBookContributions,
  personalShareTargetMemberIds,
  sharedPersonalContributionsForMember,
} from "../../domain/biography";
import {
  pickInterviewQuestion,
  SharedQuestion,
  sharedQuestionSeed,
} from "../../domain/interview";
import { CLOUD_AI_ENABLED } from "../../config/runtime";
import {
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  resetDemoRoomRemoteFirst,
  saveCurrentMemberIdLocal,
  updatePersonalShareTargetsRemoteFirst,
} from "../../services/roomRepository";

interface FragmentView {
  id: string;
  text: string;
  typeLabel: string;
  dateLabel: string;
  shareLabel: string;
  storyLabel: string;
}

interface SharedStoryView {
  id: string;
  text: string;
  authorName: string;
  relation: string;
  typeLabel: string;
  dateLabel: string;
}

interface ShareTargetView {
  id: string;
  name: string;
  relation: string;
  avatarText: string;
  selected: boolean;
}

interface IdentityView {
  id: string;
  name: string;
  relation: string;
  avatarText: string;
  isElder: boolean;
  roleLabel: string;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function toFragmentViews(
  contributions: MemoryContribution[],
  members: FamilyMember[],
): FragmentView[] {
  const memberNames = new Map(members.map((member) => [member.id, member.name]));
  return contributions
    .slice()
    .reverse()
    .map((contribution) => {
      const targetMemberIds = personalShareTargetMemberIds(contribution);
      const targetNames = targetMemberIds.map(
        (memberId) => memberNames.get(memberId) ?? "一位亲友",
      );
      return {
        id: contribution.id,
        text: contribution.text,
        typeLabel: MEMORY_TYPE_LABELS[contribution.memoryType ?? "note"],
        dateLabel: formatDate(contribution.createdAt),
        shareLabel: targetNames.length > 0
          ? `可见：${targetNames.join("、")}`
          : "仅自己可见",
        storyLabel: contributionStoryTitle(contribution) || "未整理片段",
      };
    });
}

function toSharedStoryViews(contributions: MemoryContribution[]): SharedStoryView[] {
  return contributions
    .slice()
    .reverse()
    .map((contribution) => ({
      id: contribution.id,
      text: contribution.text,
      authorName: contribution.authorName,
      relation: contribution.relation,
      typeLabel: MEMORY_TYPE_LABELS[contribution.memoryType ?? "note"],
      dateLabel: formatDate(contribution.createdAt),
    }));
}

function toIdentityView(member: FamilyMember): IdentityView {
  const isElder = member.role === "elder";
  return {
    id: member.id,
    name: member.name,
    relation: member.relation,
    avatarText: member.avatarText,
    isElder,
    roleLabel: "正在看我的人生之书",
  };
}

function toShareTargetView(member: FamilyMember): ShareTargetView {
  return {
    id: member.id,
    name: member.name,
    relation: member.relation,
    avatarText: member.avatarText,
    selected: false,
  };
}

Page({
  data: {
    protagonistName: "",
    identity: null as IdentityView | null,
    identityOptions: [] as IdentityView[],
    showIdentityPicker: false,

    memoryCount: 0,
    fragmentCount: 0,
    storyCount: 0,
    memberCount: 0,
    hasFragments: false,

    todayQuestion: null as SharedQuestion | null,
    recentFragments: [] as FragmentView[],
    sharedStories: [] as SharedStoryView[],
    hasSharedStories: false,

    showSharePicker: false,
    sharePickerStoryId: "",
    sharePickerSelectedMemberIds: [] as string[],
    sharePickerOptions: [] as ShareTargetView[],

    chapterReady: false,
    chapterCount: 0,
    chapterLabel: "",
    localDemoOnly: !CLOUD_AI_ENABLED,
  },

  onShow() {
    // custom-tab-bar 是独立组件，切回本页时要自己同步选中态。
    const tabBar = (this as unknown as { getTabBar?: () => { setData: (d: object) => void } | undefined })
      .getTabBar;
    if (typeof tabBar === "function") {
      const bar = tabBar.call(this);
      if (bar) bar.setData({ selected: 0 });
    }
    void this.refresh();
  },

  async refresh(state?: FamilyRoomState) {
    const currentState = state ?? await loadRoomStateRemoteFirst();
    const member = await loadCurrentMemberRemoteFirst(currentState);
    const identity = toIdentityView(member);
    const personal = personalBookContributions(currentState.contributions, member.id);
    const storyTitles = new Set(
      personal.map(contributionStoryTitle).filter(Boolean),
    );
    const looseFragments = personal.filter((memory) => !contributionStoryTitle(memory));
    const sharedWithMe = sharedPersonalContributionsForMember(
      currentState.contributions,
      member.id,
    );
    const personalDraft = currentState.personalDrafts?.[member.id];

    this.setData({
      protagonistName: member.name,
      identity,
      identityOptions: currentState.members.map(toIdentityView),
      memoryCount: personal.length,
      fragmentCount: looseFragments.length,
      storyCount: storyTitles.size,
      memberCount: currentState.members.length,
      hasFragments: personal.length > 0,
      recentFragments: toFragmentViews(personal, currentState.members),
      sharedStories: toSharedStoryViews(sharedWithMe),
      hasSharedStories: sharedWithMe.length > 0,
      todayQuestion: pickInterviewQuestion(sharedQuestionSeed(), "personal"),
      chapterReady: personal.length > 0,
      chapterCount: personalDraft ? 1 : 0,
      chapterLabel: personalDraft?.title ?? "还没有整理成章节",
    });
  },

  startInterview() {
    wx.navigateTo({ url: "/pages/interview/interview" });
  },

  async changeShareTarget(event: { currentTarget: { dataset: { id: string } } }) {
    const state = await loadRoomStateRemoteFirst();
    const member = await loadCurrentMemberRemoteFirst(state);
    const story = personalBookContributions(
      state.contributions,
      member.id,
    ).find((contribution) => contribution.id === event.currentTarget.dataset.id);
    if (!story) {
      wx.showToast({ title: "没有找到这段个人故事", icon: "none" });
      return;
    }

    this.setData({
      showSharePicker: true,
      sharePickerStoryId: story.id,
      sharePickerSelectedMemberIds: personalShareTargetMemberIds(story),
      sharePickerOptions: state.members
        .filter((candidate) => candidate.id !== member.id)
        .map((candidate) => ({
          ...toShareTargetView(candidate),
          selected: personalShareTargetMemberIds(story).includes(candidate.id),
        })),
    });
  },

  closeSharePicker() {
    this.setData({
      showSharePicker: false,
      sharePickerStoryId: "",
      sharePickerSelectedMemberIds: [],
      sharePickerOptions: [],
    });
  },

  stopSharePickerTap() {
    // 阻止点击面板内容时触发遮罩关闭。
  },

  choosePrivateShare() {
    this.setData({
      sharePickerSelectedMemberIds: [],
      sharePickerOptions: this.data.sharePickerOptions.map((option) => ({
        ...option,
        selected: false,
      })),
    });
  },

  toggleShareTarget(event: { currentTarget: { dataset: { id: string } } }) {
    const memberId = event.currentTarget.dataset.id;
    const selected = this.data.sharePickerSelectedMemberIds;
    const sharePickerSelectedMemberIds = selected.includes(memberId)
      ? selected.filter((id) => id !== memberId)
      : selected.concat(memberId);
    this.setData({
      sharePickerSelectedMemberIds,
      sharePickerOptions: this.data.sharePickerOptions.map((option) => ({
        ...option,
        selected: sharePickerSelectedMemberIds.includes(option.id),
      })),
    });
  },

  async confirmShareTargets() {
    const storyId = this.data.sharePickerStoryId;
    if (!storyId) return;

    try {
      const latestState = await loadRoomStateRemoteFirst();
      const latestMember = await loadCurrentMemberRemoteFirst(latestState);
      const next = await updatePersonalShareTargetsRemoteFirst(
        storyId,
        latestMember,
        this.data.sharePickerSelectedMemberIds,
      );
      const selectedCount = this.data.sharePickerSelectedMemberIds.length;
      this.closeSharePicker();
      wx.showToast({
        title: selectedCount > 0
          ? `已允许 ${selectedCount} 位亲友阅读`
          : "已改为仅自己可见",
        icon: "none",
      });
      void this.refresh(next);
    } catch (error) {
      wx.showToast({
        title: error instanceof Error ? error.message : "暂时无法修改",
        icon: "none",
      });
    }
  },

  showSharedStory(event: { currentTarget: { dataset: { id: string } } }) {
    const story = this.data.sharedStories.find(
      (candidate) => candidate.id === event.currentTarget.dataset.id,
    );
    if (!story) return;

    wx.showModal({
      title: `${story.authorName}分享给你的故事`,
      content: story.text,
      showCancel: false,
      confirmText: "读完了",
    });
  },

  openBook() {
    if (!this.data.chapterReady) {
      wx.showToast({ title: "还没有可用来源，先记下第一段回忆", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/book/book" });
  },

  openMemoryHome() {
    wx.switchTab({ url: "/pages/room/room" });
  },

  toggleIdentityPicker() {
    this.setData({ showIdentityPicker: !this.data.showIdentityPicker });
  },

  async chooseIdentity(event: { currentTarget: { dataset: { id: string } } }) {
    saveCurrentMemberIdLocal(event.currentTarget.dataset.id);
    this.setData({ showIdentityPicker: false });
    await this.refresh();
  },

  async resetDemo() {
    const state = await resetDemoRoomRemoteFirst();
    wx.showToast({ title: "演示家庭已重置", icon: "none" });
    void this.refresh(state);
  },
});
