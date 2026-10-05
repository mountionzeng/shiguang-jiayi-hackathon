import { loadCurrentAccount } from "../../services/accountService";
import {
  acceptFamilyInvitation,
  createFamilyInvitation,
  createFamilyInvitationCode,
  FamilyInvitation,
  generateFamilyInvitationCopy,
  loadFamilyInvitation,
} from "../../services/familyInviteService";
import { currentConsentVersion, requestAiConsent } from "../../services/aiConsent";
import {
  INVITE_CARD_STYLES,
  InviteCardStyleId,
  invitationMessageLength,
  nextInvitationCopy,
  validInvitationHeadline,
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
    headline: "",
    message: "",
    signature: "",
    messageLength: 0,
    messageEdited: false,
    copyIndex: 0,
    aiWriting: false,
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
    if (!token) {
      try {
        const account = await loadCurrentAccount();
        if (!this.data.signature) this.setData({ signature: account.displayName });
      } catch { /* profile validation still runs when the invitation is saved */ }
      return;
    }
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
    const headline = this.data.messageEdited ? this.data.headline : generated.headline;
    this.setData({
      inviteeName, relation, headline, message,
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
      headline: generated.headline,
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

  onHeadlineInput(event: WechatMiniprogram.Input) {
    this.setData({ headline: event.detail.value, messageEdited: true });
  },

  onSignatureInput(event: WechatMiniprogram.Input) {
    this.setData({ signature: event.detail.value });
  },

  async generateAiCopy() {
    if (this.data.aiWriting) return;
    const allowed = await requestAiConsent();
    if (!allowed) {
      wx.showToast({ title: "你可以继续自己修改文字", icon: "none" });
      return;
    }
    this.setData({ aiWriting: true, errorMessage: "" });
    try {
      const consentVersion = currentConsentVersion();
      if (consentVersion && wx.cloud) {
        await wx.cloud.callFunction({ name: "recordAiConsent", data: { version: consentVersion } });
      }
      const result = await generateFamilyInvitationCopy({
        inviteeName: this.data.inviteeName,
        relation: this.data.relation,
        currentHeadline: this.data.headline,
        currentMessage: this.data.message,
      });
      this.setData({
        headline: result.headline,
        message: result.message,
        messageLength: invitationMessageLength(result.message),
        messageEdited: true,
      });
    } catch {
      wx.showToast({ title: "AI 暂时没写好，请稍后再试", icon: "none" });
    } finally { this.setData({ aiWriting: false }); }
  },

  continueToArt() {
    if (!validInvitationHeadline(this.data.headline)) {
      wx.showToast({ title: "请保留 2—16 个字的标题", icon: "none" });
      return;
    }
    if (!validInvitationMessage(this.data.message)) {
      wx.showToast({ title: "请保留 4—48 个字的邀请", icon: "none" });
      return;
    }
    if (!this.data.signature.trim()) {
      wx.showToast({ title: "请留下署名", icon: "none" });
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
    const missing = !this.data.inviteeName.trim() ? '请填写对方的称呼'
      : !this.data.relation.trim() ? '请填写你们的关系' : '';
    if (missing) {
      this.setData({ errorMessage: missing });
      wx.showToast({ title: missing, icon: 'none' });
      return;
    }
    if (!validInvitationHeadline(this.data.headline) || !validInvitationMessage(this.data.message) || !this.data.signature.trim()) {
      this.setData({ step: "words" });
      wx.showToast({ title: "请检查邀请文字", icon: "none" });
      return;
    }
    this.setData({ creating: true, errorMessage: "", posterPath: "" });
    try {
      const result = await createFamilyInvitation(
        this.data.inviteeName,
        this.data.relation,
        this.data.headline,
        this.data.message,
        this.data.signature,
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
    const headline = invitation.headline || "一起写下我们的故事";
    const message = invitation.message || "来补上你记得的那一页。";
    context.setFillStyle("#f8f2e7");
    context.fillRect(0, 0, 750, 960);
    context.drawImage("/assets/illustrations/home-paper.jpg", 0, 0, 750, 960);

    if (style === "book") {
      context.setGlobalAlpha(0.24);
      context.drawImage("/assets/illustrations/story-book-cover.png", 505, -40, 260, 404);
      context.setGlobalAlpha(0.82);
      context.drawImage("/assets/illustrations/memory-bird.png", 548, 58, 94, 63);
    } else if (style === "nest") {
      context.setGlobalAlpha(0.68);
      context.drawImage("/assets/illustrations/memory-nest.png", 35, 42, 164, 109);
      context.drawImage("/assets/illustrations/memory-bird.png", 558, 38, 108, 72);
      context.setGlobalAlpha(0.2);
    } else {
      context.setGlobalAlpha(0.74);
      context.drawImage("/assets/illustrations/memory-branch.png", 360, 16, 438, 146);
      context.setGlobalAlpha(0.9);
      context.drawImage("/assets/illustrations/memory-bird.png", 574, 47, 100, 67);
      context.setGlobalAlpha(0.42);
      context.drawImage("/assets/illustrations/memory-nest.png", 52, 720, 138, 92);
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
    context.lineTo(704, 824);
    context.quadraticCurveTo(686, 870, 644, 861);
    context.lineTo(92, 873);
    context.quadraticCurveTo(48, 863, 57, 817);
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
    context.fillText(`写 给 ${invitation.inviteeName}`, 88, 222);
    context.setFillStyle("#293a31");
    context.setFontSize(44);
    const headlineLines = wrapInvitationMessage(headline, 13, 2);
    headlineLines.forEach((line, index) => context.fillText(line, 88, 286 + index * 50));

    context.setFillStyle("#5f5a50");
    context.setFontSize(27);
    const messageStart = 350 + Math.max(0, headlineLines.length - 1) * 50;
    const messageLines = wrapInvitationMessage(message, 18, 3);
    messageLines.forEach((line, index) => {
      context.fillText(line, 88, messageStart + index * 41);
    });
    context.setFillStyle("#817466");
    context.setFontSize(21);
    context.fillText(`${invitation.signature} · ${invitation.relation}`, 88, messageStart + messageLines.length * 41 + 24);

    context.setFillStyle("rgba(255,255,252,.96)");
    context.beginPath();
    context.arc(375, 685, 148, 0, Math.PI * 2);
    context.fill();
    context.drawImage(codePath, 255, 565, 240, 240);
    context.setTextAlign("center");
    context.setFillStyle("#4b5d52");
    context.setFontSize(23);
    context.fillText("微信扫码，一起写", 375, 842);

    return new Promise((resolve, reject) => {
      context.draw(false, () => {
        wx.canvasToTempFilePath({
          canvasId: "invitePoster", width: 750, height: 960,
          destWidth: 750, destHeight: 960, fileType: "jpg", quality: 0.95,
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
      title: `${invitation.signature || invitation.inviterName} 邀请你一起写故事`,
      path: `/pages/invite/invite?token=${encodeURIComponent(invitation.token)}`,
    } : { title: "拾光家忆" };
  },
  onShareTimeline() { return { title: "拾光家忆｜把重要的故事慢慢写下来" }; },
});
