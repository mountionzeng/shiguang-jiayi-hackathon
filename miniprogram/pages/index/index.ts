import {
  FamilyMember,
  FamilyRoomState,
  MEMORY_TYPE_LABELS,
  MemoryContribution,
  personalBookContributions,
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
} from "../../services/roomStorage";

interface FragmentView {
  id: string;
  text: string;
  typeLabel: string;
  dateLabel: string;
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

function toFragmentViews(contributions: MemoryContribution[]): FragmentView[] {
  return contributions
    .slice()
    .reverse()
    .slice(0, 3)
    .map((contribution) => ({
      id: contribution.id,
      text: contribution.text,
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
    const personalDraft = state.personalDrafts?.[member.id];

    this.setData({
      protagonistName: member.name,
      identity,
      identityOptions: state.members.map(toIdentityView),
      fragmentCount: personal.length,
      memberCount: state.members.length,
      hasFragments: personal.length > 0,
      recentFragments: toFragmentViews(personal),
      todayQuestion: pickInterviewQuestion(sharedQuestionSeed(), "personal"),
      chapterReady: personal.length > 0,
      chapterCount: personalDraft ? 1 : 0,
      chapterLabel: personalDraft?.title ?? "还没有整理成章节",
    });
  },

  startInterview() {
    wx.navigateTo({ url: "/pages/interview/interview?mode=personal" });
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
