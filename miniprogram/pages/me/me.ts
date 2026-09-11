import {
  accountOwner,
  contributionScope,
  FamilyRoomState,
  memoryPool,
  personalBookContributions,
} from "../../domain/biography";
import {
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  resetCurrentUserRoomRemoteFirst,
} from "../../services/roomRepository";
import { clearAiConsent, requestAiConsent } from "../../services/aiConsent";

Page({
  data: {
    memberName: "",
    memberRelation: "",
    memberAvatarText: "",
    memoryCount: 0,
    sharedCount: 0,
    familyCount: 0,
  },

  onShow() {
    void this.refresh().catch(() => wx.showToast({ title: "数据加载失败，请重新打开本页重试", icon: "none" }));
  },

  async refresh(state?: FamilyRoomState) {
    const currentState = state ?? await loadRoomStateRemoteFirst();
    // 「我的」就是账号主人，和首页左上角头像是同一个人。
    const member = accountOwner(currentState.members) ?? await loadCurrentMemberRemoteFirst(currentState);
    const personal = personalBookContributions(currentState.contributions, member.id);
    const sharedCount = personal.filter(
      (memory) => (memory.sharedWithMemberIds ?? []).length > 0,
    ).length;
    const familyCount = currentState.contributions.filter(
      (memory) => contributionScope(memory) === "family",
    ).length;

    this.setData({
      memberName: member.name,
      memberRelation: member.relation,
      memberAvatarText: member.avatarText,
      memoryCount: memoryPool(currentState.contributions).length,
      sharedCount,
      familyCount,
    });
  },

  openProfiles() {
    wx.navigateTo({ url: "/pages/profiles/profiles" });
  },

  openArchive() {
    wx.navigateTo({ url: "/pages/archive/archive" });
  },

  openFamilyHome() {
    wx.navigateTo({ url: "/pages/room/room" });
  },

  notYet() {
    wx.showToast({ title: "后续版本接入", icon: "none" });
  },

  async configureAiPrivacy() {
    clearAiConsent();
    const allowed = await requestAiConsent();
    wx.showToast({ title: allowed ? "本次可使用在线 AI" : "本次不使用在线 AI", icon: "none" });
  },

  clearCurrentAccountData() {
    wx.showModal({
      title: "清空当前账号云端档案",
      content: "将删除当前微信账号的云端档案、人物、记忆和书稿版本，无法撤销。本机照片文件不会一并删除。请确认已自行保留重要内容。",
      confirmText: "清空",
      confirmColor: "#c44738",
      success: (result) => {
        if (!result.confirm) return;
        void this.confirmClearCurrentAccountData();
      },
    });
  },

  async confirmClearCurrentAccountData() {
    wx.showLoading({ title: "正在清空" });
    try {
      const state = await resetCurrentUserRoomRemoteFirst();
      wx.hideLoading();
      wx.showToast({ title: "已清空", icon: "success" });
      await this.refresh(state);
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: "清空失败，请稍后再试", icon: "none" });
      console.warn("清空当前账号失败", error);
    }
  },
});
