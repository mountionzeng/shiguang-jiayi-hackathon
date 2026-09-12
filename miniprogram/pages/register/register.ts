import {
  acceptLegalNotice,
  LEGAL_NOTICE_SECTIONS,
  LEGAL_NOTICE_TITLE,
  LEGAL_NOTICE_VERSION,
  openWechatPrivacyContract,
} from "../../services/legalConsent";

Page({
  data: {
    title: LEGAL_NOTICE_TITLE,
    version: LEGAL_NOTICE_VERSION,
    sections: LEGAL_NOTICE_SECTIONS,
    agreed: false,
    readonly: false,
    submitting: false,
  },

  onLoad(options: { readonly?: string } = {}) {
    this.setData({ readonly: options.readonly === "1" });
  },

  toggleAgree(event: { detail: { value: string[] } }) {
    this.setData({ agreed: event.detail.value.includes("agree") });
  },

  async openPrivacy() {
    try {
      await openWechatPrivacyContract();
    } catch (error) {
      wx.showToast({ title: "暂时无法打开隐私指引", icon: "none" });
      console.warn("打开微信隐私协议失败", error);
    }
  },

  async acceptAndEnter() {
    if (!this.data.agreed) {
      wx.showToast({ title: "请先勾选同意", icon: "none" });
      return;
    }
    if (this.data.submitting) return;

    this.setData({ submitting: true });
    wx.showLoading({ title: "正在进入", mask: true });
    try {
      await acceptLegalNotice();
      wx.hideLoading();
      wx.reLaunch({ url: "/pages/index/index" });
    } catch (error) {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showToast({ title: "授权失败，请重试", icon: "none" });
      console.warn("用户须知确认失败", error);
    }
  },

  goBack() {
    wx.navigateBack();
  },
});
