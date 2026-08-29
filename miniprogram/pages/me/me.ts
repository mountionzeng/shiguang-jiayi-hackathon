import {
  contributionScope,
  FamilyRoomState,
  personalBookContributions,
} from "../../domain/biography";
import {
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  resetCurrentUserRoomRemoteFirst,
} from "../../services/roomRepository";

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
    void this.refresh();
  },

  async refresh(state?: FamilyRoomState) {
    const currentState = state ?? await loadRoomStateRemoteFirst();
    const member = await loadCurrentMemberRemoteFirst(currentState);
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
      memoryCount: personal.length,
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

  clearCurrentAccountData() {
    wx.showModal({
      title: "清空当前账号数据",
      content: "会删除当前微信账号下的家庭、档案、记忆和草稿，示例家庭不会受影响。",
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
