import {
  FamilyMember,
  FamilyRoomState,
  contributionRelatedMemberIds,
  personalBookContributions,
  personalShareTargetMemberIds,
} from "../../domain/biography";
import {
  addFamilyMemberRemoteFirst,
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  resetCurrentUserRoomRemoteFirst,
  saveCurrentMemberIdLocal,
  updatePersonalShareTargetsRemoteFirst,
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
  if (member.kind === "recording-profile") return "记录档案";
  if (member.kind === "person") return "亲友";
  return "旧版档案";
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
    managingPeople: false,
    selectedPersonId: "",
    selectedPersonName: "",
    permissions: [] as Array<{ id: string; title: string; related: boolean; canRead: boolean }>,
    permissionSaving: false,
    loadError: "",
  },

  onLoad(options: { mode?: string } = {}) {
    this.setData({ managingPeople: options.mode === "people" });
  },

  onShow() {
    void this.refresh().catch(() => this.setData({ loadError: "亲友档案暂时未加载成功，请重试。" }));
  },

  async refresh(state?: FamilyRoomState) {
    const currentState = state ?? await loadRoomStateRemoteFirst();
    const currentMember = await loadCurrentMemberRemoteFirst(currentState);
    const visibleState = { ...currentState, members: currentState.members.filter(member =>
      this.data.managingPeople ? member.kind !== "recording-profile" : member.kind !== "person") };
    const profiles = profileViews(visibleState, currentMember.id)
      .filter(profile => !this.data.managingPeople || profile.id !== currentMember.id);
    const selected = profiles.find(profile => profile.id === this.data.selectedPersonId);
    this.setData({
      profiles,
      hasProfiles: profiles.length > 0,
      selectedPersonId: selected?.id || "",
      selectedPersonName: selected?.name || "",
      permissions: selected ? personalBookContributions(currentState.contributions, currentMember.id).map(memory => ({
        id: memory.id, title: memory.title || memory.text.slice(0, 18),
        related: contributionRelatedMemberIds(memory).includes(selected.id),
        canRead: personalShareTargetMemberIds(memory).includes(selected.id),
      })) : [],
      loadError: "",
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
    const relation = this.data.managingPeople ? this.data.relationInput.trim() : "自己";
    if (!name) {
      wx.showToast({ title: "请填写名字", icon: "none" });
      return;
    }

    try {
      const state = await addFamilyMemberRemoteFirst(name, relation, this.data.managingPeople ? "person" : "recording-profile");
      const member = state.members[state.members.length - 1];
      if (member && !this.data.managingPeople) saveCurrentMemberIdLocal(member.id);
      wx.showToast({ title: this.data.managingPeople ? "亲友已添加" : "记录档案已创建", icon: "success" });
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
    if (this.data.managingPeople) {
      this.setData({ selectedPersonId: memberId });
      await this.refresh().catch(() => this.setData({ loadError: "读取失败，请重试" }));
      return;
    }
    const state = await loadRoomStateRemoteFirst();
    const member = state.members.find((item) => item.id === memberId && item.kind !== "person");

    if (!member) {
      wx.showToast({ title: "没有找到这个档案", icon: "none" });
      return;
    }

    saveCurrentMemberIdLocal(member.id);
    wx.showToast({ title: `已切换到${member.name}`, icon: "none" });
    wx.navigateBack();
  },

  retryLoad() { this.onShow(); },

  async toggleReading(event: { currentTarget: { dataset: { id: string } } }) {
    if (this.data.permissionSaving || !this.data.selectedPersonId) return;
    this.setData({ permissionSaving: true });
    try {
      const state = await loadRoomStateRemoteFirst();
      const actor = await loadCurrentMemberRemoteFirst(state);
      const memory = personalBookContributions(state.contributions, actor.id).find(item => item.id === event.currentTarget.dataset.id);
      if (!memory) throw new Error("这段记忆已不存在，请刷新");
      const current = personalShareTargetMemberIds(memory);
      const personId = this.data.selectedPersonId;
      const targets = current.includes(personId) ? current.filter(id => id !== personId) : [...current, personId];
      const next = await updatePersonalShareTargetsRemoteFirst(memory.id, actor, targets);
      await this.refresh(next);
      wx.showToast({ title: "档案阅读范围已更新", icon: "none" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "修改失败，请重试", icon: "none" });
    } finally { this.setData({ permissionSaving: false }); }
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
  onShareAppMessage() { return { title: "拾光Ai｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光Ai｜把重要的故事慢慢写下来" }; },
});
