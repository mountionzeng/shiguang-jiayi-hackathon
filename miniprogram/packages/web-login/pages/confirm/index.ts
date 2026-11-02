import { decideWebLogin, previewWebLogin } from "../../../../services/drinkingTimeAccount";

type Step = "input" | "confirm" | "done";

Page({
  data: {
    step: "input" as Step,
    code: "",
    fromQr: false,
    busy: false,
    clientHint: "",
    mode: "login",
    resultText: "",
    error: "",
  },
  onLoad(options: { scene?: string }) {
    if (options.scene === undefined) return;
    let scene = "";
    try { scene = decodeURIComponent(options.scene); } catch { /* Invalid scenes never trigger a request. */ }
    const match = /^wl_([A-F0-9]{28})$/.exec(scene);
    if (!match) { this.setData({ error: "登录二维码无效，请在网页重新生成。" }); return; }
    this.setData({ code: match[1], fromQr: true });
    // Scanning only previews the device; the user must still tap confirmation.
    void this.lookup();
  },
  onInput(event: { detail: { value: string } }) {
    this.setData({ code: event.detail.value.toUpperCase().replace(/[^0-9A-Z-]/g, ""), error: "" });
  },
  async lookup() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      const preview = await previewWebLogin(this.data.code);
      this.setData({ step: "confirm", clientHint: preview.clientHint, mode: preview.mode });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "暂时无法连接电脑端" });
    } finally {
      this.setData({ busy: false });
    }
  },
  async decide(event: { currentTarget: { dataset: { decision: "confirm" | "deny" } } }) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      const outcome = await decideWebLogin(this.data.code, event.currentTarget.dataset.decision);
      const text = outcome === "confirmed"
        ? "已确认，电脑网页会自动登录。"
        : outcome === "denied"
          ? "已拒绝，电脑不会登录。"
          : "这个微信已经有一个拾光账号，本次没有绑定。";
      this.setData({ step: "done", resultText: text });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "暂时无法连接电脑端" });
    } finally {
      this.setData({ busy: false });
    }
  },
  back() { wx.navigateBack(); },
});
