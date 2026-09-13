import { loadCurrentAccount } from "../../services/accountService";
import {
  acceptFamilyInvitation,
  createFamilyInvitation,
  createFamilyInvitationCode,
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
      });
      const codeResult = await createFamilyInvitationCode(result.invitation.token, environmentVersion());
      this.setData({ codeReady: true });
      const codePath = await writeBase64Image(codeResult.codeBase64);
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
    context.setFillStyle("#f8f2e7");
    context.fillRect(0, 0, 750, 1040);
    context.drawImage("/assets/illustrations/home-paper.jpg", 0, 0, 750, 1040);

    // 原有拾光插画语言：淡彩晕染、树枝、小鸟与鸟窝。
    context.setGlobalAlpha(0.18);
    context.drawImage("/assets/illustrations/book-wash.png", 528, -70, 260, 346);
    context.drawImage("/assets/illustrations/book-wash.png", -74, 744, 250, 334);
    context.setGlobalAlpha(0.72);
    context.drawImage("/assets/illustrations/memory-branch.png", 368, 16, 430, 143);
    context.setGlobalAlpha(0.9);
    context.drawImage("/assets/illustrations/memory-bird.png", 574, 47, 100, 67);
    context.setGlobalAlpha(0.45);
    context.drawImage("/assets/illustrations/memory-nest.png", 53, 255, 144, 96);
    context.setGlobalAlpha(1);

    // 邀请是一张写好的笺纸，不再使用规整的 SaaS 卡片边框。
    context.setFillStyle("rgba(255,252,244,.78)");
    context.setStrokeStyle("rgba(111,79,58,.14)");
    context.setLineWidth(2);
    context.beginPath();
    context.moveTo(54, 116);
    context.quadraticCurveTo(72, 96, 102, 104);
    context.lineTo(652, 96);
    context.quadraticCurveTo(700, 106, 691, 144);
    context.lineTo(704, 904);
    context.quadraticCurveTo(686, 950, 644, 941);
    context.lineTo(92, 953);
    context.quadraticCurveTo(48, 943, 57, 897);
    context.closePath();
    context.fill();
    context.stroke();

    context.setTextAlign("left");
    context.setFillStyle("#6f4f3a");
    context.setFontSize(25);
    context.fillText("拾 光 Ai  ·  记 忆 之 家", 88, 158);
    context.setFillStyle("rgba(111,79,58,.24)");
    context.fillRect(88, 178, 194, 2);

    context.setFillStyle("#93765f");
    context.setFontSize(21);
    context.fillText("一 封 写 给 你 的 邀 请", 88, 226);
    context.setFillStyle("#8c7563");
    context.setFontSize(25);
    context.fillText(`写给 ${invitation.inviteeName}`, 88, 274);
    context.setFillStyle("#293a31");
    context.setFontSize(46);
    context.fillText("一起写故事吧", 88, 330);

    context.setFillStyle("#75685a");
    context.setFontSize(27);
    context.fillText(`${invitation.inviterName} 想和你一起记住`, 203, 373);
    context.setFillStyle("#3d5146");
    context.setFontSize(32);
    context.fillText(`「${invitation.roomName}」`, 203, 418);
    context.setFillStyle("#817466");
    context.setFontSize(23);
    context.fillText(`你们的关系 · ${invitation.relation}`, 203, 456);

    // 小程序码必须保持正向、高对比和足够留白，装饰只停在其外侧。
    context.setFillStyle("rgba(255,255,252,.94)");
    context.beginPath();
    context.arc(375, 641, 158, 0, Math.PI * 2);
    context.fill();
    context.drawImage(codePath, 245, 511, 260, 260);
    context.setGlobalAlpha(0.8);
    context.drawImage("/assets/illustrations/memory-bird.png", 515, 676, 96, 64);
    context.setGlobalAlpha(1);

    context.setTextAlign("center");
    context.setFillStyle("#4b5d52");
    context.setFontSize(25);
    context.fillText("长按识别，一起把故事慢慢写下来", 375, 820);
    context.setFillStyle("#8e8173");
    context.setFontSize(20);
    context.fillText("邀请 7 天内有效 · 仅限一个微信账号接受", 375, 862);
    context.setFillStyle("rgba(111,79,58,.2)");
    context.fillRect(224, 894, 302, 2);
    context.setFillStyle("#9a7c61");
    context.setFontSize(19);
    context.fillText("有人记得，故事就还在", 375, 925);

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
