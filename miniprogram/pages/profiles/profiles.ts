import {
  FamilyMember,
  FamilyRoomState,
} from "../../domain/biography";
import {
  addFamilyMemberRemoteFirst,
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  resetCurrentUserRoomRemoteFirst,
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
    memberNameInput: "",
    relationInput: "",
    hasProfiles: false,
  },

  onShow() {
    void this.refresh();
  },

  async refresh(state?: FamilyRoomState) {
    const currentState = state ?? await loadRoomStateRemoteFirst();
    const currentMember = await loadCurrentMemberRemoteFirst(currentState);
    const profiles = profileViews(currentState, currentMember.id);
    this.setData({
      profiles,
      hasProfiles: profiles.length > 0,
    });
  },

  onMemberNameInput(event: WechatMiniprogram.Input) {
    this.setData({ memberNameInput: event.detail.value });
  },

  onRelationInput(event: WechatMiniprogram.Input) {
    this.setData({ relationInput: event.detail.value });
  },

  async addProfile() {
    const name = this.data.memberNameInput.trim();
    const relation = this.data.relationInput.trim();
    if (!name) {
      wx.showToast({ title: "请填写名字", icon: "none" });
      return;
    }

    try {
      const state = await addFamilyMemberRemoteFirst(name, relation);
      const member = state.members[state.members.length - 1];
      if (member) saveCurrentMemberIdLocal(member.id);
      wx.showToast({ title: "档案已创建", icon: "success" });
      this.setData({
        memberNameInput: "",
        relationInput: "",
      });
      await this.refresh(state);
    } catch (error) {
      wx.showToast({
        title: error instanceof Error ? error.message : "创建失败",
        icon: "none",
      });
    }
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

  clearCurrentFamilyData() {
    wx.showModal({
      title: "清空当前账号数据",
      content: "会删除当前微信账号下的家庭成员、记忆、草稿和生成内容。删除后不能恢复。",
      confirmText: "清空",
      confirmColor: "#c75245",
      success: async (result) => {
        if (!result.confirm) return;
        wx.showLoading({ title: "正在清空", mask: true });
        try {
          const state = await resetCurrentUserRoomRemoteFirst();
          saveCurrentMemberIdLocal("");
          await this.refresh(state);
          wx.hideLoading();
          wx.showToast({ title: "已清空", icon: "success" });
          setTimeout(() => wx.switchTab({ url: "/pages/index/index" }), 450);
        } catch (error) {
          wx.hideLoading();
          wx.showToast({
            title: error instanceof Error ? error.message : "清空失败",
            icon: "none",
          });
        }
      },
    });
  },
});
