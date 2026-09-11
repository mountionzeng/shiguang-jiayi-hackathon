import {
  FamilyMember,
  FamilyRoomState,
  contributionRelatedMemberIds,
  isActiveMember,
  isPerson,
  isRecordingProfile,
  needsClassification,
  personalBookContributions,
  personalShareTargetMemberIds,
} from "../../domain/biography";
import {
  addFamilyMemberRemoteFirst,
  classifyMemberRemoteFirst,
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  resetCurrentUserRoomRemoteFirst,
  restoreMemberRemoteFirst,
  saveCurrentMemberIdLocal,
  updatePersonalShareTargetsRemoteFirst,
} from "../../services/roomRepository";
import { deleteMemberWithConfirm } from "../../services/memberActions";
import { currentManuscript } from "../../services/manuscript";

interface ProfileView {
  id: string;
  name: string;
  relation: string;
  avatarText: string;
  roleLabel: string;
  current: boolean;
}

interface TrashView {
  id: string;
  name: string;
  relation: string;
  deletedLabel: string;
}

function roleLabel(member: FamilyMember): string {
  if (member.kind === "recording-profile") return "记录档案";
  if (member.kind === "person") return "亲友";
  return "旧版档案";
}

function profileView(member: FamilyMember, currentMemberId: string): ProfileView {
  return {
    id: member.id,
    name: member.name,
    relation: member.relation,
    avatarText: member.avatarText,
    roleLabel: roleLabel(member),
    current: member.id === currentMemberId,
  };
}

function deletedLabel(iso?: string): string {
  const date = new Date(iso ?? "");
  return Number.isNaN(date.getTime()) ? "已删除" : `${date.getMonth() + 1}月${date.getDate()}日删除`;
}

/** Classified records only: legacy ones wait in the sorting list, so nobody shows in both lists. */
function listed(member: FamilyMember, managingPeople: boolean): boolean {
  return managingPeople ? isPerson(member) : isActiveMember(member) && member.kind === "recording-profile";
}

function trashed(member: FamilyMember, managingPeople: boolean): boolean {
  return Boolean(member.deletedAt) && (managingPeople ? member.kind === "person" : member.kind !== "person");
}

type IdEvent = { currentTarget: { dataset: { id: string; kind?: string } } };

Page({
  data: {
    profiles: [] as ProfileView[],
    pending: [] as ProfileView[],
    trash: [] as TrashView[],
    trashOpen: false,
    busyId: "",
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
    const managing = this.data.managingPeople;
    const profiles = currentState.members.filter(member => listed(member, managing))
      .map(member => profileView(member, currentMember.id))
      .filter(profile => !managing || profile.id !== currentMember.id);
    const selected = profiles.find(profile => profile.id === this.data.selectedPersonId);
    this.setData({
      profiles,
      pending: currentState.members.filter(needsClassification).map(member => profileView(member, currentMember.id)),
      trash: currentState.members.filter(member => trashed(member, managing)).map(member => ({
        id: member.id, name: member.name, relation: member.relation, deletedLabel: deletedLabel(member.deletedAt),
      })),
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

  async chooseProfile(event: IdEvent) {
    const memberId = event.currentTarget.dataset.id;
    if (this.data.managingPeople) {
      this.setData({ selectedPersonId: memberId });
      await this.refresh().catch(() => this.setData({ loadError: "读取失败，请重试" }));
      return;
    }
    const state = await loadRoomStateRemoteFirst();
    const member = state.members.find((item) => item.id === memberId && isRecordingProfile(item));

    if (!member) {
      wx.showToast({ title: "没有找到这个档案", icon: "none" });
      return;
    }

    saveCurrentMemberIdLocal(member.id);
    wx.showToast({ title: `已切换到${member.name}`, icon: "none" });
    wx.navigateBack();
  },

  retryLoad() { this.onShow(); },

  /** Sorts one legacy record. Only its kind changes; the dialog says where it will appear. */
  async classify(event: IdEvent) {
    if (this.data.busyId) return;
    const { id } = event.currentTarget.dataset;
    const kind = event.currentTarget.dataset.kind === "person" ? "person" : "recording-profile";
    try {
      const state = await loadRoomStateRemoteFirst();
      const member = state.members.find(item => item.id === id && needsClassification(item));
      if (!member) throw new Error("它已经分好类了，请刷新");
      const hasBook = Boolean(currentManuscript(state, member.id).draft);
      const content = kind === "person"
        ? `「${member.name}」以后只出现在亲友名单里，不会出现在首页「切换档案」里。` + (hasBook ? "它名下有一本书稿，归为亲友后这本书不再显示（内容保留）。" : "")
        : `「${member.name}」以后只出现在首页「切换档案」里，有自己的一本书，不再出现在亲友名单里。`;
      const confirmed = await new Promise<boolean>(resolve => wx.showModal({
        title: kind === "person" ? "归为亲友？" : "归为记录档案？", content,
        success: result => resolve(result.confirm), fail: () => resolve(false),
      }));
      if (!confirmed) return;
      this.setData({ busyId: id });
      const next = await classifyMemberRemoteFirst(id, kind);
      wx.showToast({ title: kind === "person" ? "已归为亲友" : "已归为记录档案", icon: "none" });
      await this.refresh(next);
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "分类没有完成，请重试", icon: "none" });
    } finally { this.setData({ busyId: "" }); }
  },

  async removeMember(event: IdEvent) {
    if (this.data.busyId) return;
    const { id } = event.currentTarget.dataset;
    try {
      const state = await loadRoomStateRemoteFirst();
      const member = state.members.find(item => item.id === id && isActiveMember(item));
      if (!member) throw new Error("没有找到，请刷新后重试");
      this.setData({ busyId: id });
      const next = await deleteMemberWithConfirm(member, state);
      if (!next) return;
      if (this.data.selectedPersonId === id) this.setData({ selectedPersonId: "" });
      await this.refresh(next);
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "删除没有完成，请重试", icon: "none" });
    } finally { this.setData({ busyId: "" }); }
  },

  async restoreMember(event: IdEvent) {
    if (this.data.busyId) return;
    const { id } = event.currentTarget.dataset;
    this.setData({ busyId: id });
    try {
      const next = await restoreMemberRemoteFirst(id);
      wx.showToast({ title: "已恢复", icon: "none" });
      await this.refresh(next);
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "恢复没有完成，请重试", icon: "none" });
    } finally { this.setData({ busyId: "" }); }
  },

  toggleTrash() { this.setData({ trashOpen: !this.data.trashOpen }); },

  async toggleReading(event: IdEvent) {
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
});
