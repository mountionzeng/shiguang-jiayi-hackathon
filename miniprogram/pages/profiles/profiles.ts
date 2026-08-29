import {
  FamilyMember,
  FamilyRoomState,
} from "../../domain/biography";
import {
  loadCurrentMember,
  loadRoomState,
  saveCurrentMemberId,
} from "../../services/roomStorage";

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

function profileViews(state: FamilyRoomState): ProfileView[] {
  const current = loadCurrentMember(state);
  return state.members.map((member) => ({
    id: member.id,
    name: member.name,
    relation: member.relation,
    avatarText: member.avatarText,
    roleLabel: roleLabel(member),
    current: member.id === current.id,
  }));
}

Page({
  data: {
    profiles: [] as ProfileView[],
  },

  onShow() {
    this.refresh();
  },

  refresh(state: FamilyRoomState = loadRoomState()) {
    this.setData({ profiles: profileViews(state) });
  },

  chooseProfile(event: { currentTarget: { dataset: { id: string } } }) {
    const memberId = event.currentTarget.dataset.id;
    const state = loadRoomState();
    const member = state.members.find((item) => item.id === memberId);

    if (!member) {
      wx.showToast({ title: "没有找到这个档案", icon: "none" });
      return;
    }

    saveCurrentMemberId(member.id);
    wx.showToast({ title: `已切换到${member.name}`, icon: "none" });
    wx.navigateBack();
  },
});
