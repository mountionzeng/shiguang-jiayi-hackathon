import { loadCurrentAccount } from "../../services/accountService";
import {
  acceptFamilyInvitation,
  createFamilyInvitation,
  createFamilyInvitationCode,
  FamilyInvitation,
  loadFamilyInvitation,
} from "../../services/familyInviteService";
import {
  INVITE_CARD_STYLES,
  InviteCardStyleId,
  invitationMessageLength,
  nextInvitationCopy,
  validInvitationMessage,
  wrapInvitationMessage,
} from "../../services/inviteCard";

interface InviteLoadOptions { scene?: string; token?: string; }
type InviteStep = "who" | "words" | "art" | "ready";

function decodeScene(value = ""): string {
  try { return decodeURIComponent(value).trim(); } catch { return value.trim(); }
}

function firstCharacter(value: string): string {
  return Array.from(value.trim())[0] || "忆";
}

function environmentVersion(): "develop" | "trial" | "release" {
  try {
    const version = wx.getAccountInfoSync().miniProgram.envVersion;
    return version === "develop" || version === "trial" ? version : "release";
  } catch { return "release"; }
}

function writeBase64Image(base64: string): Promise<string> {
  const path = `${wx.env.USER_DATA_PATH}/family-invite-code-${Date.now()}.png`;
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath: path, data: base64, encoding: "base64",
      success: () => resolve(path), fail: reject,
    });
  });
}

Page({
  data: {
    mode: "create" as "create" | "accept",
    step: "who" as InviteStep,
    loading: false,
    creating: false,
    accepting: false,
    inviteeName: "",
    inviteeAvatarText: "忆",
    relation: "",
    message: "",
    messageLength: 0,
    messageEdited: false,
    copyIndex: 0,
    illustrationStyle: "branch" as InviteCardStyleId,
    styleOptions: INVITE_CARD_STYLES,
    invitation: null as FamilyInvitation | null,
    invitationAvatarText: "忆",
    posterPath: "",
    codeReady: false,
    albumSaving: false,
    errorMessage: "",
  },

  async onLoad(options: InviteLoadOptions = {}) {
    const token = decodeScene(options.scene || options.token);
    if (!token) return;
    this.setData({ mode: "accept", loading: true });
    try {
      await loadCurrentAccount();
      const result = await loadFamilyInvitation(token);
      this.setData({
        invitation: result.invitation,
        invitationAvatarText: firstCharacter(result.invitation.inviteeName),
      });
    } catch (error) {
      this.setData({ errorMessage: error instanceof Error ? error.message : "这份邀请暂时打不开" });
    } finally { this.setData({ loading: false }); }
  },

  onInviteeNameInput(event: WechatMiniprogram.Input) {
    const inviteeName = event.detail.value;
    this.setData({ inviteeName, inviteeAvatarText: firstCharacter(inviteeName) });
  },

  onRelationInput(event: WechatMiniprogram.Input) {
    this.setData({ relation: event.detail.value });
  },

  continueToWords() {
    const inviteeName = this.data.inviteeName.trim();
    const relation = this.data.relation.trim();
    if (!inviteeName || !relation) {
      wx.showToast({ title: "请先写下称呼和关系", icon: "none" });
      return;
    }
    const generated = nextInvitationCopy(inviteeName, relation, 0);
    const message = this.data.messageEdited ? this.data.message : generated.message;
    this.setData({
      inviteeName, relation, message,
      messageLength: invitationMessageLength(message),
      messageEdited: this.data.messageEdited,
      copyIndex: generated.index,
      step: "words",
      errorMessage: "",
    });
  },

  generateCopy() {
    const generated = nextInvitationCopy(
      this.data.inviteeName,
      this.data.relation,
      this.data.copyIndex + 1,
    );
    this.setData({
      message: generated.message,
      messageLength: invitationMessageLength(generated.message),
      messageEdited: false,
      copyIndex: generated.index,
    });
  },

  onMessageInput(event: WechatMiniprogram.Input) {
    const message = event.detail.value;
    this.setData({ message, messageLength: invitationMessageLength(message), messageEdited: true });
  },

  continueToArt() {
    if (!validInvitationMessage(this.data.message)) {
      wx.showToast({ title: "请保留 4—90 个字的邀请", icon: "none" });
      return;
    }
    this.setData({ step: "art", errorMessage: "" });
  },

  chooseStyle(event: { currentTarget: { dataset: { style: InviteCardStyleId } } }) {
    const style = event.currentTarget.dataset.style;
    if (INVITE_CARD_STYLES.some(option => option.id === style)) {
      this.setData({ illustrationStyle: style });
    }
  },

  previousStep() {
    const previous: Record<InviteStep, InviteStep> = {
      who: "who", words: "who", art: "words", ready: "art",
    };
    this.setData({ step: previous[this.data.step], errorMessage: "" });
  },

  async createInvitation() {
    if (this.data.creating) return;
    if (!validInvitationMessage(this.data.message)) {
      this.setData({ step: "words" });
      wx.showToast({ title: "请检查邀请文字", icon: "none" });
      return;
    }
    this.setData({ creating: true, errorMessage: "", posterPath: "" });
    try {
      const result = await createFamilyInvitation(
        this.data.inviteeName,
        this.data.relation,
        this.data.message,
        this.data.illustrationStyle,
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
      this.setData({ posterPath, step: "ready" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "邀请生成失败，请稍后重试";
      this.setData({ errorMessage: message });
      wx.showToast({ title: message, icon: "none" });
    } finally { this.setData({ creating: false }); }
  },

  drawPoster(invitation: FamilyInvitation, codePath: string): Promise<string> {
    const context = wx.createCanvasContext("invitePoster", this);
    const style = invitation.illustrationStyle || "branch";
    const message = invitation.message || "有些记忆因为你也在场，才显得完整。想邀请你来这里，一起把故事慢慢写下来。";
    context.setFillStyle("#f8f2e7");
    context.fillRect(0, 0, 750, 1040);
    context.drawImage("/assets/illustrations/home-paper.jpg", 0, 0, 750, 1040);

    if (style === "book") {
      context.setGlobalAlpha(0.24);
      context.drawImage("/assets/illustrations/story-book-cover.png", 505, -40, 260, 404);
      context.drawImage("/assets/illustrations/book-wash.png", -60, 720, 260, 347);
      context.setGlobalAlpha(0.82);
      context.drawImage("/assets/illustrations/memory-bird.png", 548, 58, 94, 63);
    } else if (style === "nest") {
      context.setGlobalAlpha(0.68);
      context.drawImage("/assets/illustrations/memory-nest.png", 35, 42, 164, 109);
      context.drawImage("/assets/illustrations/memory-bird.png", 558, 38, 108, 72);
      context.setGlobalAlpha(0.2);
      context.drawImage("/assets/illustrations/book-wash.png", 526, 720, 260, 347);
    } else {
      context.setGlobalAlpha(0.74);
      context.drawImage("/assets/illustrations/memory-branch.png", 360, 16, 438, 146);
      context.setGlobalAlpha(0.9);
      context.drawImage("/assets/illustrations/memory-bird.png", 574, 47, 100, 67);
      context.setGlobalAlpha(0.42);
      context.drawImage("/assets/illustrations/memory-nest.png", 52, 790, 138, 92);
    }
    context.setGlobalAlpha(1);

    context.setFillStyle("rgba(255,252,244,.82)");
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
    context.setFillStyle("#293a31");
    context.setFontSize(44);
    context.fillText(`写给 ${invitation.inviteeName}`, 88, 292);

    context.setFillStyle("#5f5a50");
    context.setFontSize(27);
    wrapInvitationMessage(message).forEach((line, index) => {
      context.fillText(line, 88, 352 + index * 43);
    });
    context.setFillStyle("#817466");
    context.setFontSize(21);
    context.fillText(`${invitation.inviterName} · ${invitation.relation}`, 88, 548);
    context.setFillStyle("#3d5146");
    context.setFontSize(28);
    context.fillText(`「${invitation.roomName}」`, 88, 588);

    context.setFillStyle("rgba(255,255,252,.96)");
    context.beginPath();
    context.arc(375, 730, 158, 0, Math.PI * 2);
    context.fill();
    context.drawImage(codePath, 245, 600, 260, 260);
    context.setTextAlign("center");
    context.setFillStyle("#4b5d52");
    context.setFontSize(23);
    context.fillText("长按识别，来写下你记得的那一段", 375, 890);
    context.setFillStyle("#8e8173");
    context.setFontSize(19);
    context.fillText("邀请 7 天内有效 · 仅限一个微信账号接受", 375, 924);

    return new Promise((resolve, reject) => {
      context.draw(false, () => {
        wx.canvasToTempFilePath({
          canvasId: "invitePoster", width: 750, height: 1040,
          destWidth: 750, destHeight: 1040, fileType: "jpg", quality: 0.95,
          success: result => resolve(result.tempFilePath), fail: reject,
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
    shareImage({ path: this.data.posterPath, fail: () => wx.previewImage({ urls: [this.data.posterPath] }) });
  },

  previewPoster() {
    if (this.data.posterPath) wx.previewImage({ urls: [this.data.posterPath] });
  },

  async savePoster() {
    const posterPath = this.data.posterPath;
    if (!posterPath || this.data.albumSaving) return;
    this.setData({ albumSaving: true, errorMessage: "" });
    try {
      await new Promise<void>((resolve, reject) => wx.saveImageToPhotosAlbum({
        filePath: posterPath, success: () => resolve(), fail: reject,
      }));
      wx.showToast({ title: "已保存到相册", icon: "success" });
    } catch (error) {
      const reason = String((error as { errMsg?: string })?.errMsg || error || "");
      const message = /auth|deny|permission/i.test(reason)
        ? "请在小程序设置中允许保存到相册"
        : "邀请图片暂时没保存成功，请重试";
      this.setData({ errorMessage: message });
      wx.showToast({ title: message, icon: "none" });
    } finally { this.setData({ albumSaving: false }); }
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
    } finally { this.setData({ accepting: false }); }
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
    } : { title: "拾光家忆" };
  },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
