export {};
type NativeDocument = {
  id: string;
  title: string;
  mine: boolean;
  chapters: Array<{ title: string; text: string }>;
  images: string[];
  media: Array<{ kind: "video" | "audio"; label: string; url: string }>;
  shared: boolean;
};
async function call(action: string, input: Record<string, unknown> = {}) {
  const response = await wx.cloud.callFunction({
    name: "drinkingTimeBridge",
    data: { action, ...input },
  }).catch(() => {
    throw new Error("网页故事暂时无法读取，请稍后重试。");
  });
  const result = response.result as any;
  if (!result || result.error || result.ok === false)
    throw new Error("网页故事暂时无法读取，请稍后重试。");
  return result;
}
Page({
  data: {
    busy: false,
    error: "",
    code: "",
    preview: null as { title: string } | null,
    document: null as NativeDocument | null,
    stories: [] as Array<{ id: string; title: string }>,
    shareToken: "",
    sharedToken: "",
  },
  run: 0,
  alive: true,
  lastScene: "",
  onLoad(query: Record<string, string>) {
    this.alive = true;
    this.run++;
    this.setData({
      busy: false,
      error: "",
      preview: null,
      document: null,
      shareToken: "",
      sharedToken: "",
      code: "",
    });
    wx.hideShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
    let scene = "";
    try {
      scene = decodeURIComponent(query.scene || "");
    } catch {}
    this.lastScene = scene;
    if (/^wm_[A-F0-9]{28}$/.test(scene)) this.setData({ code: scene.slice(3) });
    if (query.id && /^[a-f0-9-]{36}$/.test(query.id)) {
      if (query.token && /^[A-Za-z0-9_-]{43}$/.test(query.token))
        this.setData({ sharedToken: query.token });
      void this.read(query.id);
      return;
    }
    void this.refresh();
  },
  onShow() {
    const enter = wx.getEnterOptionsSync?.();
    if (
      enter?.path === "packages/web-mailbox/pages/index/index" &&
      enter.query?.scene
    ) {
      let scene = "";
      try {
        scene = decodeURIComponent(enter.query.scene);
      } catch {}
      if (scene && scene !== this.lastScene) this.onLoad(enter.query);
    }
  },
  onUnload() {
    this.alive = false;
    this.run++;
  },
  async perform(work: (current: () => boolean) => Promise<void>) {
    if (this.data.busy) return;
    const run = ++this.run,
      current = () => this.alive && run === this.run;
    this.setData({ busy: true, error: "" });
    try {
      await work(current);
    } catch (error) {
      if (current())
        this.setData({
          error:
            error instanceof Error ? error.message : "暂时无法读取，请重试。",
        });
    } finally {
      if (current()) this.setData({ busy: false });
    }
  },
  async refresh() {
    await this.perform(async (current: () => boolean) => {
      if (this.data.code) {
        const preview = await call("mailboxPreview", { code: this.data.code });
        if (current()) this.setData({ preview });
      } else if (this.data.document) {
        const result = await call("mailboxRead", {
          id: this.data.document.id,
          ...(this.data.sharedToken ? { token: this.data.sharedToken } : {}),
        });
        if (current()) this.setData({ document: result.document });
      } else {
        const result = await call("mailboxList");
        if (current()) this.setData({ stories: result.stories });
      }
    });
  },
  async confirm() {
    const code = this.data.code;
    await this.perform(async (current: () => boolean) => {
      const result = await call("mailboxConfirm", { code });
      if (!current()) return;
      // Persist the receipt id before a subsequent read can fail. A retry never rebinds.
      this.setData({
        code: "",
        preview: null,
        document: {
          id: result.id,
          title: "",
          mine: true,
          chapters: [],
          images: [],
          media: [],
          shared: false,
        },
      });
      const read = await call("mailboxRead", { id: result.id });
      if (current()) this.setData({ document: read.document });
    });
  },
  async read(id: string) {
    await this.perform(async (current: () => boolean) => {
      const result = await call("mailboxRead", {
        id,
        ...(this.data.sharedToken ? { token: this.data.sharedToken } : {}),
      });
      if (current()) this.setData({ document: result.document });
    });
  },
  open(event: WechatMiniprogram.TouchEvent) {
    this.setData({ sharedToken: "", shareToken: "" });
    void this.read(event.currentTarget.dataset.id);
  },
  prepareShare() {
    if (!this.data.document?.mine || this.data.busy) return;
    const scope = this.run,
      id = this.data.document.id;
    wx.showModal({
      title: "转给微信朋友",
      content:
        "只有这份已接收的内容会被分享。拿到链接的微信用户可以查看，其他故事保持私密。",
      confirmText: "准备分享",
      success: (result) => {
        if (
          result.confirm &&
          this.alive &&
          this.run === scope &&
          this.data.document?.id === id
        )
          void this.perform(async (current: () => boolean) => {
            const r = await call("mailboxShare", { id });
            if (current() && this.data.document?.id === id)
              this.setData({
                shareToken: r.token,
                document: { ...this.data.document!, shared: true },
              });
          });
      },
    });
  },
  async stopSharing() {
    if (!this.data.document?.mine) return;
    await this.perform(async (current: () => boolean) => {
      await call("mailboxRevoke", { id: this.data.document!.id });
      if (current())
        this.setData({
          shareToken: "",
          document: { ...this.data.document!, shared: false },
        });
    });
  },
  onShareAppMessage() {
    const d = this.data.document;
    return d?.mine && this.data.shareToken
      ? {
          title: d.title,
          path: `/packages/web-mailbox/pages/index/index?id=${d.id}&token=${this.data.shareToken}`,
        }
      : { title: "拾光家忆", path: "/pages/index/index" };
  },
});
