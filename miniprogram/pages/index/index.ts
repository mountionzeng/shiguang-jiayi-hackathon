import {
  FamilyMember,
  FamilyRoomState,
  MEMORY_TYPE_LABELS,
  MemoryContribution,
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
  loadCurrentMember,
  loadRoomState,
  resetDemoRoom,
  saveCurrentMemberId,
  updatePersonalShareTarget,
} from "../../services/roomStorage";

interface FragmentView {
  id: string;
  text: string;
  typeLabel: string;
  dateLabel: string;
  shareLabel: string;
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
      const targetMemberId = personalShareTargetMemberIds(contribution)[0];
      return {
        id: contribution.id,
        text: contribution.text,
        typeLabel: MEMORY_TYPE_LABELS[contribution.memoryType ?? "note"],
        dateLabel: formatDate(contribution.createdAt),
        shareLabel: targetMemberId
          ? `分享给${memberNames.get(targetMemberId) ?? "一位家人"}`
          : "仅自己",
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
  };
}

Page({
  data: {
    protagonistName: "",
    identity: null as IdentityView | null,
    identityOptions: [] as IdentityView[],
    showIdentityPicker: false,

    fragmentCount: 0,
    memberCount: 0,
    hasFragments: false,

    todayQuestion: null as SharedQuestion | null,
    recentFragments: [] as FragmentView[],
    sharedStories: [] as SharedStoryView[],
    hasSharedStories: false,

    showSharePicker: false,
    sharePickerStoryId: "",
    sharePickerSelectedMemberId: "",
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
    this.refresh();
  },

  refresh(state: FamilyRoomState = loadRoomState()) {
    const member = loadCurrentMember(state);
    const identity = toIdentityView(member);
    const personal = personalBookContributions(state.contributions, member.id);
    const sharedWithMe = sharedPersonalContributionsForMember(
      state.contributions,
      member.id,
    );
    const personalDraft = state.personalDrafts?.[member.id];

    this.setData({
      protagonistName: member.name,
      identity,
      identityOptions: state.members.map(toIdentityView),
      fragmentCount: personal.length,
      memberCount: state.members.length,
      hasFragments: personal.length > 0,
      recentFragments: toFragmentViews(personal, state.members),
      sharedStories: toSharedStoryViews(sharedWithMe),
      hasSharedStories: sharedWithMe.length > 0,
      todayQuestion: pickInterviewQuestion(sharedQuestionSeed(), "personal"),
      chapterReady: personal.length > 0,
      chapterCount: personalDraft ? 1 : 0,
      chapterLabel: personalDraft?.title ?? "还没有整理成章节",
    });
  },

  startInterview() {
    wx.navigateTo({ url: "/pages/interview/interview?mode=personal" });
  },

  quickCapture() {
    wx.navigateTo({ url: "/pages/quick-note/quick-note" });
  },

  changeShareTarget(event: { currentTarget: { dataset: { id: string } } }) {
    const state = loadRoomState();
    const member = loadCurrentMember(state);
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
      sharePickerSelectedMemberId:
        personalShareTargetMemberIds(story)[0] ?? "",
      sharePickerOptions: state.members
        .filter((candidate) => candidate.id !== member.id)
        .map(toShareTargetView),
    });
  },

  closeSharePicker() {
    this.setData({
      showSharePicker: false,
      sharePickerStoryId: "",
      sharePickerSelectedMemberId: "",
      sharePickerOptions: [],
    });
  },

  stopSharePickerTap() {
    // 阻止点击面板内容时触发遮罩关闭。
  },

  chooseShareTarget(event: { currentTarget: { dataset: { id?: string } } }) {
    const storyId = this.data.sharePickerStoryId;
    const targetMemberId = event.currentTarget.dataset.id || undefined;
    if (!storyId) return;

    try {
      const latestState = loadRoomState();
      const latestMember = loadCurrentMember(latestState);
      const target = targetMemberId
        ? latestState.members.find((member) => member.id === targetMemberId)
        : undefined;
      const next = updatePersonalShareTarget(
        storyId,
        latestMember,
        targetMemberId,
      );
      this.closeSharePicker();
      wx.showToast({
        title: target ? `已分享给${target.name}` : "已改为仅自己可见",
        icon: "none",
      });
      this.refresh(next);
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

  chooseIdentity(event: { currentTarget: { dataset: { id: string } } }) {
    saveCurrentMemberId(event.currentTarget.dataset.id);
    this.setData({ showIdentityPicker: false });
    this.refresh();
  },

  resetDemo() {
    const state = resetDemoRoom();
    wx.showToast({ title: "演示家庭已重置", icon: "none" });
    this.refresh(state);
  },
});
