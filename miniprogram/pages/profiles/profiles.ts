import {
  FamilyMember,
  FamilyRoomState,
  isActiveMember,
  isRecordingProfile,
} from "../../domain/biography";
import {
  addFamilyMemberRemoteFirst,
  loadCurrentMemberRemoteFirst,
  loadRoomStateRemoteFirst,
  resetCurrentUserRoomRemoteFirst,
  restoreMemberRemoteFirst,
  saveCurrentMemberIdLocal,
  updateMemberRemoteFirst,
} from "../../services/roomRepository";
import { deleteMemberWithConfirm } from "../../services/memberActions";
import { logLoadError } from "../../services/loadErrorLog";

/**
 * 「家人和朋友」：本账号就是主笔，这里只管拉人进来，并在每个人旁边标出权限。
 * 书的切换留在首页；`mode=new-book` 或还没有任何一本书时，改为新建一本书。
 */

/** A book told as "自己" is the account owner's own; the owner is the author, not a listed person. */
const isSelf = (member: FamilyMember) => member.relation === "自己";

interface PersonRow {
  id: string;
  name: string;
  relation: string;
  avatarText: string;
  permission: string;
  canDelete: boolean;
}

interface TrashRow {
  id: string;
  name: string;
  relation: string;
  deletedLabel: string;
}

// Real invitations (reader / editor / answerer) are not built yet, so nobody has access.
function permissionLabel(_member: FamilyMember): string {
  return "还没邀请";
}

function deletedLabel(iso?: string): string {
  const date = new Date(iso ?? "");
  return Number.isNaN(date.getTime()) ? "已删除" : `${date.getMonth() + 1}月${date.getDate()}日删除`;
}

type IdEvent = { currentTarget: { dataset: { id: string } } };

Page({
  data: {
    view: "people" as "people" | "new-book",
    people: [] as PersonRow[],
    trash: [] as TrashRow[],
    trashOpen: false,
    busyId: "",
    nameInput: "",
    relationInput: "",
    adding: false,
    editMemberId: "",
    editNameInput: "",
    editRelationInput: "",
    savingEdit: false,
    loadError: "",
  },

  requestedNewBook: false,
  refreshGeneration: 0,
  pageActive: true,

  onLoad(options: { mode?: string } = {}) {
    this.requestedNewBook = options.mode === "new-book";
    this.setData({ view: this.requestedNewBook ? "new-book" : "people" });
  },

  onShow() {
    this.pageActive = true;
    const generation = ++this.refreshGeneration;
    void this.refresh(undefined, generation).catch((error) => {
      if (!this.pageActive || generation !== this.refreshGeneration) return;
      logLoadError("profiles", error);
      this.setData({ loadError: "名单暂时没加载出来，请重试。" });
    });
  },

  onHide() { this.pageActive = false; this.refreshGeneration += 1; },
  onUnload() { this.pageActive = false; this.refreshGeneration += 1; },

  async refresh(state?: FamilyRoomState, generation?: number) {
    const requestedGeneration = generation ?? ++this.refreshGeneration;
    const currentState = state ?? await loadRoomStateRemoteFirst();
    const current = await loadCurrentMemberRemoteFirst(currentState);
    // People belong to a book; with no book yet, start one first.
    const view = this.requestedNewBook || !currentState.members.some(isRecordingProfile) ? "new-book" : "people";
    if (view === "new-book" && typeof wx.setNavigationBarTitle === "function") {
      wx.setNavigationBarTitle({ title: "新建一本书" });
    }
    if (!this.pageActive || requestedGeneration !== this.refreshGeneration) return;
    this.setData({
      view,
      people: currentState.members.filter(member => isActiveMember(member) && !isSelf(member)).map(member => ({
        id: member.id,
        name: member.name,
        relation: member.relation,
        avatarText: member.avatarText,
        permission: permissionLabel(member),
        canDelete: member.id !== current.id,
      })),
      trash: currentState.members.filter(member => member.deletedAt).map(member => ({
        id: member.id, name: member.name, relation: member.relation, deletedLabel: deletedLabel(member.deletedAt),
      })),
      loadError: "",
    });
  },

  retryLoad() { this.onShow(); },

  onNameInput(event: WechatMiniprogram.Input) { this.setData({ nameInput: event.detail.value }); },
  onRelationInput(event: WechatMiniprogram.Input) { this.setData({ relationInput: event.detail.value }); },
  onEditNameInput(event: WechatMiniprogram.Input) { this.setData({ editNameInput: event.detail.value }); },
  onEditRelationInput(event: WechatMiniprogram.Input) { this.setData({ editRelationInput: event.detail.value }); },

  startEdit(event: IdEvent) {
    const person = this.data.people.find((item) => item.id === event.currentTarget.dataset.id);
    if (!person || this.data.savingEdit || this.data.adding || this.data.busyId) return;
    this.setData({ editMemberId: person.id, editNameInput: person.name, editRelationInput: person.relation });
  },

  cancelEdit() {
    if (this.data.savingEdit) return;
    this.setData({ editMemberId: "", editNameInput: "", editRelationInput: "" });
  },

  async saveEdit() {
    if (!this.data.editMemberId || this.data.savingEdit || this.data.adding || this.data.busyId) return;
    this.setData({ savingEdit: true });
    try {
      const state = await updateMemberRemoteFirst(
        this.data.editMemberId,
        this.data.editNameInput,
        this.data.editRelationInput,
      );
      if (!this.pageActive) return;
      this.setData({ editMemberId: "", editNameInput: "", editRelationInput: "" });
      wx.showToast({ title: "人物已更新", icon: "success" });
      await this.refresh(state);
    } catch (error) {
      if (this.pageActive) wx.showToast({ title: error instanceof Error ? error.message : "没有保存成功，请重试", icon: "none" });
    } finally { if (this.pageActive) this.setData({ savingEdit: false }); }
  },

  async addPerson() {
    if (this.data.adding || this.data.savingEdit || this.data.busyId) return;
    const name = this.data.nameInput.trim();
    const relation = this.data.relationInput.trim();
    if (!name) { wx.showToast({ title: "请写下名字", icon: "none" }); return; }
    if (relation === "自己") { wx.showToast({ title: "你自己就是主笔，不用再加", icon: "none" }); return; }
    this.setData({ adding: true });
    try {
      const state = await addFamilyMemberRemoteFirst(name, relation, "person");
      if (!this.pageActive) return;
      wx.showToast({ title: `${name} 已加进来`, icon: "none" });
      this.setData({ nameInput: "", relationInput: "" });
      await this.refresh(state);
    } catch (error) {
      if (this.pageActive) wx.showToast({ title: error instanceof Error ? error.message : "没有加成功，请重试", icon: "none" });
    } finally { if (this.pageActive) this.setData({ adding: false }); }
  },

  async createBook() {
    if (this.data.adding) return;
    const name = this.data.nameInput.trim();
    if (!name) { wx.showToast({ title: "请写这本书写的是谁", icon: "none" }); return; }
    this.setData({ adding: true });
    try {
      const state = await addFamilyMemberRemoteFirst(name, this.data.relationInput.trim() || "自己", "recording-profile");
      const book = state.members[state.members.length - 1];
      if (book) saveCurrentMemberIdLocal(book.id);
      wx.showToast({ title: `已新建${name}的人生之书`, icon: "none" });
      this.setData({ nameInput: "", relationInput: "" });
      wx.navigateBack({ fail: () => wx.reLaunch({ url: "/pages/index/index" }) });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "没有建成功，请重试", icon: "none" });
    } finally { this.setData({ adding: false }); }
  },

  async removeMember(event: IdEvent) {
    if (this.data.busyId || this.data.adding || this.data.savingEdit) return;
    const { id } = event.currentTarget.dataset;
    try {
      const state = await loadRoomStateRemoteFirst();
      const member = state.members.find(item => item.id === id && isActiveMember(item));
      if (!member) throw new Error("没有找到，请刷新后重试");
      this.setData({ busyId: id });
      const next = await deleteMemberWithConfirm(member, state);
      if (next) await this.refresh(next);
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "删除没有完成，请重试", icon: "none" });
    } finally { this.setData({ busyId: "" }); }
  },

  async restoreMember(event: IdEvent) {
    if (this.data.busyId || this.data.adding || this.data.savingEdit) return;
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
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
