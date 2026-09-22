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
  saveRoomProfileRemoteFirst,
} from "../../services/roomRepository";
import { clearAiConsent, requestAiConsent } from "../../services/aiConsent";
import { formatComputeBalance, loadCurrentAccount, saveCurrentAccountName } from "../../services/accountService";
import { JoinedFamilyRoom, loadJoinedFamilyRooms } from "../../services/familyInviteService";
import { logLoadError } from "../../services/loadErrorLog";
import { clearPhotoUploadQueue, deleteMyCloudPhotos, loadCloudPhotoSummary, pendingPhotoUploads } from "../../services/photoCloud";

function formatPhotoBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

Page({
  data: {
    memberName: "",
    memberRelation: "",
    memberAvatarText: "",
    memoryCount: 0,
    sharedCount: 0,
    familyCount: 0,
    accountName: "",
    accountAvatarText: "忆",
    editingAccount: false,
    accountNameInput: "",
    accountAvatarPreview: "忆",
    accountSaving: false,
    roomName: "",
    protagonistName: "",
    editingRoom: false,
    roomNameInput: "",
    protagonistNameInput: "",
    roomSaving: false,
    computeBalance: "0.00 算力",
    computeRate: "¥1 = 2 算力",
    joinedRooms: [] as JoinedFamilyRoom[],
    cloudPhotoCount: 0,
    cloudPhotoBytes: "0 KB",
    checkingPhotoCount: 0,
    pendingPhotoCount: 0,
    deletingPhotos: false,
  },

  onShow() {
    void this.refresh().catch((error) => { logLoadError("me", error); wx.showToast({ title: "数据加载失败，请重新打开本页重试", icon: "none" }); });
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
      roomName: currentState.roomName ?? "",
      protagonistName: currentState.protagonistName ?? "",
      memberRelation: member.relation,
      memberAvatarText: member.avatarText,
      memoryCount: memoryPool(currentState.contributions).length,
      sharedCount,
      familyCount,
      pendingPhotoCount: pendingPhotoUploads().length,
    });
    if (!wx.cloud) {
      this.setData({ accountName: member.name, accountAvatarText: member.avatarText });
      return;
    }
    try {
      try {
        const photos = await loadCloudPhotoSummary();
        this.setData({
          cloudPhotoCount: photos.count,
          cloudPhotoBytes: formatPhotoBytes(photos.bytes),
          checkingPhotoCount: photos.checking,
        });
      } catch (error) {
        console.warn("云端照片统计暂未加载", error);
      }
      const account = await loadCurrentAccount();
      this.setData({
        accountName: account.displayName || member.name,
        accountAvatarText: account.avatarText || member.avatarText,
        accountNameInput: account.displayName || member.name,
        accountAvatarPreview: account.avatarText || member.avatarText,
        computeBalance: formatComputeBalance(account.computeBalanceMicros),
        computeRate: account.computeRate,
      });
      try {
        this.setData({ joinedRooms: await loadJoinedFamilyRooms() });
      } catch (error) {
        console.warn("已加入的记忆之家暂未加载", error);
      }
    } catch (error) {
      console.warn("拾光账号资料暂未加载", error);
      this.setData({ accountName: member.name, accountAvatarText: member.avatarText });
    }
  },

  editAccountProfile() {
    this.setData({ editingAccount: true, accountAvatarPreview: this.data.accountAvatarText });
  },

  cancelAccountProfile() {
    if (!this.data.accountSaving) this.setData({ editingAccount: false, accountNameInput: this.data.accountName });
  },

  onAccountNameInput(event: WechatMiniprogram.Input) {
    this.setData({
      accountNameInput: event.detail.value,
      accountAvatarPreview: Array.from(event.detail.value.trim())[0] || "忆",
    });
  },

  startEditRoom() {
    this.setData({
      editingRoom: true,
      roomNameInput: this.data.roomName,
      protagonistNameInput: this.data.protagonistName,
    });
  },

  cancelEditRoom() {
    if (!this.data.roomSaving) this.setData({ editingRoom: false });
  },

  onRoomNameInput(event: WechatMiniprogram.Input) { this.setData({ roomNameInput: event.detail.value }); },
  onProtagonistNameInput(event: WechatMiniprogram.Input) { this.setData({ protagonistNameInput: event.detail.value }); },

  async saveRoomProfile() {
    if (this.data.roomSaving) return;
    this.setData({ roomSaving: true });
    try {
      const state = await saveRoomProfileRemoteFirst({
        roomName: this.data.roomNameInput.trim(),
        protagonistName: this.data.protagonistNameInput.trim(),
      });
      await this.refresh(state);
      this.setData({ editingRoom: false });
      wx.showToast({ title: "记忆之家已更新", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "修改失败，请重试", icon: "none" });
    } finally {
      this.setData({ roomSaving: false });
    }
  },

  async saveAccountProfile() {
    if (this.data.accountSaving) return;
    this.setData({ accountSaving: true });
    try {
      const account = await saveCurrentAccountName(this.data.accountNameInput);
      this.setData({
        accountName: account.displayName,
        accountAvatarText: account.avatarText,
        accountNameInput: account.displayName,
        accountAvatarPreview: account.avatarText,
        editingAccount: false,
      });
      wx.showToast({ title: "个人信息已更新", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "修改失败，请重试", icon: "none" });
    } finally {
      this.setData({ accountSaving: false });
    }
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
  openAccountLink() { wx.navigateTo({ url: "/pages/account-link/account-link" }); },

  openJoinedRoom(event: { currentTarget: { dataset: { id: string } } }) {
    wx.navigateTo({
      url: `/pages/room/room?familyId=${encodeURIComponent(event.currentTarget.dataset.id)}`,
    });
  },

  notYet() {
    wx.showToast({ title: "后续版本接入", icon: "none" });
  },

  openPersonalMemory() { wx.navigateTo({url:"/pages/personal-memory/personal-memory"}); },

  async configureAiPrivacy() {
    clearAiConsent();
    const allowed = await requestAiConsent();
    wx.showToast({ title: allowed ? "本次可使用在线 AI" : "本次不使用在线 AI", icon: "none" });
  },

  deleteCloudPhotos() {
    if (this.data.deletingPhotos || this.data.cloudPhotoCount <= 0) return;
    wx.showModal({
      title: "删除云端照片？",
      content: `会删除你存在云端的全部 ${this.data.cloudPhotoCount} 张照片，约 ${this.data.cloudPhotoBytes}。之后在别的手机上、在家人那里，这些照片都会显示“照片已删除”。这台手机上的原图不受影响。`,
      confirmText: "继续",
      confirmColor: "#c44738",
      success: result => { if (result.confirm) this.confirmDeleteCloudPhotos(); },
    });
  },

  confirmDeleteCloudPhotos() {
    wx.showModal({
      title: "确认删除",
      content: `删除后无法恢复。确定删除这 ${this.data.cloudPhotoCount} 张云端照片吗？`,
      confirmText: "删除",
      confirmColor: "#c44738",
      success: result => { if (result.confirm) void this.performDeleteCloudPhotos(); },
    });
  },

  async performDeleteCloudPhotos() {
    this.setData({ deletingPhotos: true });
    wx.showLoading({ title: "正在删除" });
    try {
      await deleteMyCloudPhotos();
      clearPhotoUploadQueue();
      this.setData({ cloudPhotoCount: 0, cloudPhotoBytes: "0 KB", checkingPhotoCount: 0, pendingPhotoCount: 0 });
      wx.hideLoading();
      wx.showToast({ title: "云端照片已删除", icon: "success" });
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: error instanceof Error ? error.message : "删除失败，请稍后再试", icon: "none" });
    } finally {
      this.setData({ deletingPhotos: false });
    }
  },

  clearCurrentAccountData() {
    wx.showModal({
      title: "清空当前账号云端档案",
      content: "将删除当前微信账号的云端档案、人物、记忆、书稿版本和云端照片，无法撤销。本机照片文件不会一并删除。请确认已自行保留重要内容。",
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
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
