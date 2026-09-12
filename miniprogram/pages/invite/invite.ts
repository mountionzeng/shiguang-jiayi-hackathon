import { loadCurrentAccount } from "../../services/accountService";
import {
  acceptFamilyInvitation,
  createFamilyInvitation,
  FamilyInvitation,
  loadFamilyInvitation,
} from "../../services/familyInviteService";

interface InviteLoadOptions {
  scene?: string;
  token?: string;
}

function decodeScene(value = ""): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

function firstCharacter(value: string): string {
  return Array.from(value.trim())[0] || "忆";
}

function environmentVersion(): "develop" | "trial" | "release" {
  try {
    const version = wx.getAccountInfoSync().miniProgram.envVersion;
    return version === "develop" || version === "trial" ? version : "release";
  } catch {
    return "release";
  }
}

function writeBase64Image(base64: string): Promise<string> {
  const path = `${wx.env.USER_DATA_PATH}/family-invite-code-${Date.now()}.png`;
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath: path,
      data: base64,
      encoding: "base64",
      success: () => resolve(path),
      fail: reject,
    });
  });
}

Page({
  data: {
    mode: "create" as "create" | "accept",
    loading: false,
    creating: false,
    accepting: false,
    inviteeName: "",
    inviteeAvatarText: "忆",
    relation: "",
    invitation: null as FamilyInvitation | null,
    invitationAvatarText: "忆",
    posterPath: "",
    codeReady: false,
    errorMessage: "",
  },

  async onLoad(options: InviteLoadOptions = {}) {
    const token = decodeScene(options.scene || options.token);
    if (!token) return;
    this.setData({ mode: "accept", loading: true });
    try {
      // getOpenId creates the trusted account shell. If this is a first visit,
      // accepting the invitation will fill its initial display name.
      await loadCurrentAccount();
      const result = await loadFamilyInvitation(token);
      this.setData({
        invitation: result.invitation,
        invitationAvatarText: firstCharacter(result.invitation.inviteeName),
      });
    } catch (error) {
      this.setData({
        errorMessage: error instanceof Error ? error.message : "这份邀请暂时打不开",
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  onInviteeNameInput(event: WechatMiniprogram.Input) {
    const inviteeName = event.detail.value;
    this.setData({ inviteeName, inviteeAvatarText: firstCharacter(inviteeName) });
  },

  onRelationInput(event: WechatMiniprogram.Input) {
    this.setData({ relation: event.detail.value });
  },

  async createInvitation() {
    if (this.data.creating) return;
    this.setData({ creating: true, errorMessage: "", posterPath: "" });
    try {
      const result = await createFamilyInvitation(
        this.data.inviteeName,
        this.data.relation,
        environmentVersion(),
      );
      this.setData({
        invitation: result.invitation,
        invitationAvatarText: firstCharacter(result.invitation.inviteeName),
        codeReady: Boolean(result.codeBase64),
      });
      if (!result.codeBase64) {
        throw new Error("邀请已建立，但小程序码暂时生成失败，请稍后重试");
      }
      const codePath = await writeBase64Image(result.codeBase64);
      const posterPath = await this.drawPoster(result.invitation, codePath);
      this.setData({ posterPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : "邀请生成失败，请稍后重试";
      this.setData({ errorMessage: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ creating: false });
    }
  },

  drawPoster(invitation: FamilyInvitation, codePath: string): Promise<string> {
    const context = wx.createCanvasContext("invitePoster", this);
    context.setFillStyle("#f7f0e3");
    context.fillRect(0, 0, 750, 1040);

    context.setGlobalAlpha(0.3);
    context.setFillStyle("#d7a36e");
    context.beginPath();
    context.arc(92, 118, 150, 0, Math.PI * 2);
    context.fill();
    context.setFillStyle("#789b86");
    context.beginPath();
    context.arc(670, 340, 190, 0, Math.PI * 2);
    context.fill();
    context.setFillStyle("#bd6b55");
    context.beginPath();
    context.arc(40, 900, 170, 0, Math.PI * 2);
    context.fill();
    context.setGlobalAlpha(1);

    context.setFillStyle("rgba(255,252,245,.92)");
    context.setStrokeStyle("rgba(92,68,48,.18)");
    context.setLineWidth(2);
    context.fillRect(58, 72, 634, 880);
    context.strokeRect(58, 72, 634, 880);

    context.setTextAlign("center");
    context.setFillStyle("#6f4f3a");
    context.setFontSize(28);
    context.fillText("拾 光 Ai · 记 忆 之 家", 375, 142);

    context.setFillStyle("#d8b582");
    context.beginPath();
    context.arc(375, 254, 76, 0, Math.PI * 2);
    context.fill();
    context.setFillStyle("#fffaf0");
    context.setFontSize(52);
    context.fillText(firstCharacter(invitation.inviteeName), 375, 274);

    context.setFillStyle("#2f392f");
    context.setFontSize(42);
    context.fillText(`${invitation.inviteeName}，一起写故事吧`, 375, 386);
    context.setFillStyle("#75685a");
    context.setFontSize(28);
    context.fillText(`${invitation.inviterName} 邀请你加入`, 375, 444);
    context.setFontSize(32);
    context.fillText(`「${invitation.roomName}」`, 375, 496);
    context.setFontSize(25);
    context.fillText(`你们的关系：${invitation.relation}`, 375, 546);

    context.drawImage(codePath, 255, 602, 240, 240);
    context.setFillStyle("#75685a");
    context.setFontSize(24);
    context.fillText("长按识别小程序码 · 接受后即可一起记录", 375, 886);
    context.setFillStyle("#9a8b78");
    context.setFontSize(20);
    context.fillText("邀请 7 天内有效，仅限一个微信账号接受", 375, 924);

    return new Promise((resolve, reject) => {
      context.draw(false, () => {
        wx.canvasToTempFilePath({
          canvasId: "invitePoster",
          width: 750,
          height: 1040,
          destWidth: 750,
          destHeight: 1040,
          fileType: "jpg",
          quality: 0.95,
          success: result => resolve(result.tempFilePath),
          fail: reject,
        }, this);
      });
    });
  },

  sharePoster() {
    if (!this.data.posterPath) return;
    const shareImage = (wx as typeof wx & {
      showShareImageMenu?: (options: { path: string; fail?: () => void }) => void;
    }).showShareImageMenu;
    if (!shareImage) {
      wx.previewImage({ urls: [this.data.posterPath] });
      wx.showToast({ title: "请长按图片发送给好友", icon: "none" });
      return;
    }
    shareImage({
      path: this.data.posterPath,
      fail: () => wx.previewImage({ urls: [this.data.posterPath] }),
    });
  },

  previewPoster() {
    if (this.data.posterPath) wx.previewImage({ urls: [this.data.posterPath] });
  },

  async acceptInvitation() {
    const invitation = this.data.invitation;
    if (!invitation || this.data.accepting) return;
    if (invitation.acceptedByMe && invitation.familyId) {
      this.openRoom(invitation.familyId);
      return;
    }
    this.setData({ accepting: true, errorMessage: "" });
    try {
      const result = await acceptFamilyInvitation(invitation.token);
      this.setData({ invitation: result.invitation });
      wx.showToast({ title: "已经加入记忆之家", icon: "success" });
      this.openRoom(result.invitation.familyId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "暂时无法接受邀请";
      this.setData({ errorMessage: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      this.setData({ accepting: false });
    }
  },

  openRoom(familyId: string) {
    wx.redirectTo({ url: `/pages/room/room?familyId=${encodeURIComponent(familyId)}` });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.reLaunch({ url: "/pages/index/index" }) });
  },

  onShareAppMessage() {
    const invitation = this.data.invitation;
    return invitation ? {
      title: `${invitation.inviterName} 邀请你一起写故事`,
      path: `/pages/invite/invite?token=${encodeURIComponent(invitation.token)}`,
    } : { title: "拾光Ai" };
  },
  onShareTimeline() { return { title: "拾光Ai｜把重要的故事慢慢写下来" }; },
});
