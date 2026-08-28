import {
  biographySourceContributions,
  FamilyMember,
  FamilyRoomState,
  MemoryContribution,
  pendingContributionsFor,
} from "../../domain/biography";
import {
  pickSharedQuestion,
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
  byline: string;
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
      byline: `${contribution.authorName} · ${contribution.relation}`,
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
    roleLabel: isElder ? "这本书的主人公" : "家人",
  };
}

Page({
  data: {
    protagonistName: "",
    identity: null as IdentityView | null,
    identityOptions: [] as IdentityView[],
    showIdentityPicker: false,

    fragmentCount: 0,
    pendingCount: 0,
    memberCount: 0,
    hasFragments: false,

    todayQuestion: null as SharedQuestion | null,
    recentFragments: [] as FragmentView[],

    chapterReady: false,
    chapterLabel: "",
    localDemoOnly: !CLOUD_AI_ENABLED,
  },

  onShow() {
    this.refresh();
  },

  refresh(state: FamilyRoomState = loadRoomState()) {
    const member = loadCurrentMember(state);
    const identity = toIdentityView(member);
    const qualified = biographySourceContributions(state.contributions);
    const pending = pendingContributionsFor(state.contributions, member);

    this.setData({
      protagonistName: state.protagonistName,
      identity,
      identityOptions: state.members.map(toIdentityView),
      fragmentCount: qualified.length,
      pendingCount: pending.length,
      memberCount: state.members.length,
      hasFragments: qualified.length > 0,
      recentFragments: toFragmentViews(qualified),
      todayQuestion: pickSharedQuestion(sharedQuestionSeed()),
      chapterReady: qualified.length > 0,
      chapterLabel: state.draft ? state.draft.title : "还没有整理成章节",
    });
  },

  startInterview() {
    wx.navigateTo({ url: "/pages/interview/interview" });
  },

  openBook() {
    if (!this.data.chapterReady) {
      wx.showToast({ title: "还没有可用来源，先记下第一段回忆", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/book/book" });
  },

  openFragments() {
    wx.navigateTo({ url: "/pages/room/room" });
  },

  openPending() {
    if (this.data.identity && this.data.identity.isElder) {
      wx.navigateTo({ url: "/pages/review/review" });
      return;
    }
    wx.showToast({
      title: "这些是你投稿后等待老人确认的内容",
      icon: "none",
      duration: 2200,
    });
    wx.navigateTo({ url: "/pages/room/room" });
  },

  openMemoryHome() {
    wx.navigateTo({ url: "/pages/room/room" });
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
