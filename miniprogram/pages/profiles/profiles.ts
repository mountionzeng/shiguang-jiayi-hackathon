import {
  FamilyMember,
  FamilyRoomState,
} from "../../domain/biography";
import {
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  saveCurrentMemberIdLocal,
} from "../../services/roomRepository";

interface ProfileView {
  id: string;
  name: string;
  relation: string;
  avatarText: string;
  roleLabel: string;
  current: boolean;
}

function roleLabel(member: FamilyMember): string {
  return member.role === "elder" ? "人生之书主人公" : "亲友档案";
}

function profileViews(state: FamilyRoomState, currentMemberId: string): ProfileView[] {
  return state.members.map((member) => ({
    id: member.id,
    name: member.name,
    relation: member.relation,
    avatarText: member.avatarText,
    roleLabel: roleLabel(member),
    current: member.id === currentMemberId,
  }));
}

Page({
  data: {
    profiles: [] as ProfileView[],
  },

  onShow() {
    void this.refresh();
  },

  async refresh(state?: FamilyRoomState) {
    const currentState = state ?? await loadRoomStateRemoteFirst();
    const currentMember = await loadCurrentMemberRemoteFirst(currentState);
    this.setData({ profiles: profileViews(currentState, currentMember.id) });
  },

  async chooseProfile(event: { currentTarget: { dataset: { id: string } } }) {
    const memberId = event.currentTarget.dataset.id;
    const state = await loadRoomStateRemoteFirst();
    const member = state.members.find((item) => item.id === memberId);

    if (!member) {
      wx.showToast({ title: "没有找到这个档案", icon: "none" });
      return;
    }

    saveCurrentMemberIdLocal(member.id);
    wx.showToast({ title: `已切换到${member.name}`, icon: "none" });
    wx.navigateBack();
  },
});
