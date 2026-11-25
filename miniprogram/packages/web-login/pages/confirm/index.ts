import { decideWebLogin, previewWebLogin } from "../../../../services/drinkingTimeAccount";

type Step = "input" | "confirm" | "done";

Page({
  data: {
    step: "input" as Step,
    code: "",
    fromQr: false,
    legacyInput: false,
    busy: false,
    clientHint: "",
    mode: "login",
    resultText: "",
    error: "",
  },
  requestRevision: 0,
  lastScene: null as string | null,
  onLoad(options: { scene?: string }) {
    if (options.scene !== undefined) this.readScene(options.scene);
  },
  onShow() {
    const entry = wx.getEnterOptionsSync();
    if (entry.path === "packages/web-login/pages/confirm/index" && typeof entry.query?.scene === "string") {
      this.readScene(entry.query.scene);
    }
  },
  readScene(rawScene: string) {
    if (rawScene === this.lastScene) return;
    this.lastScene = rawScene;
    this.requestRevision += 1;
    this.setData({ step: "input", code: "", fromQr: true, busy: false, clientHint: "", resultText: "", error: "" });
    let scene = "";
    try { scene = decodeURIComponent(rawScene); } catch { /* Invalid scenes never trigger a request. */ }
    const match = /^wl_([A-F0-9]{28})$/.exec(scene);
    if (!match) {
      const mailbox = /^wm_/i.test(scene);
      this.setData({
        error: mailbox
          ? "这是邮箱来稿码，不能用来绑定或授权算力钱包。请从电脑网页的登录或绑定页重新扫码。"
          : "登录二维码无效。请从电脑网页的登录或绑定页扫码。邮箱来稿码和故事电脑码不能用来绑定钱包。",
      });
      return;
    }
    this.setData({ code: match[1], fromQr: true });
    // Scanning only previews the device; the user must still tap confirmation.
    void this.lookup();
  },
  showLegacyInput() {
    this.setData({ legacyInput: true, error: "" });
  },
  onInput(event: { detail: { value: string } }) {
    this.setData({ code: event.detail.value.toUpperCase().replace(/[^0-9A-Z-]/g, ""), error: "" });
  },
  async lookup() {
    if (this.data.busy || !this.data.code) return;
    const revision = this.requestRevision;
    this.setData({ busy: true, error: "" });
    try {
      const preview = await previewWebLogin(this.data.code);
      if (revision !== this.requestRevision) return;
      this.setData({ step: "confirm", clientHint: preview.clientHint, mode: preview.mode });
    } catch (error) {
      if (revision !== this.requestRevision) return;
      this.setData({ error: error instanceof Error ? error.message : "暂时无法连接电脑端" });
    } finally {
      if (revision === this.requestRevision) this.setData({ busy: false });
    }
  },
  async decide(event: { currentTarget: { dataset: { decision: "confirm" | "deny" } } }) {
    if (this.data.busy || !this.data.code) return;
    const revision = this.requestRevision;
    this.setData({ busy: true, error: "" });
    try {
      const outcome = await decideWebLogin(this.data.code, event.currentTarget.dataset.decision);
      if (revision !== this.requestRevision) return;
      const bind = this.data.mode === "bind";
      const text = outcome === "confirmed"
        ? (bind
          ? "已确认绑定。手机和电脑将共用同一份网站算力；绑定不会再领取注册赠送。"
          : "已确认，电脑网页会自动登录。手机和电脑将共用同一份网站算力。")
        : outcome === "denied"
          ? (bind ? "已拒绝，这次没有绑定。" : "已拒绝，电脑不会登录。")
          : "无法自动合并（merge_required）。这个微信已有独立账号，本次没有绑定，两边的原余额和预占都保持不变。";
      this.setData({ step: "done", resultText: text });
    } catch (error) {
      if (revision !== this.requestRevision) return;
      this.setData({ error: error instanceof Error ? error.message : "暂时无法连接电脑端" });
    } finally {
      if (revision === this.requestRevision) this.setData({ busy: false });
    }
  },
  back() { wx.navigateBack(); },
});
