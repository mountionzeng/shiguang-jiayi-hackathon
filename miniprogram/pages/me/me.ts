import {
  contributionScope,
  FamilyRoomState,
  personalBookContributions,
} from "../../domain/biography";
import {
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
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
});
