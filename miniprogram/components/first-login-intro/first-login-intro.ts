import {
  buildFirstLoginIntro,
  hasSeenFirstLoginIntro,
  IntroContent,
  IntroInvite,
  loadIntroInvite,
  markFirstLoginIntroSeen,
} from "../../services/firstLoginIntro";

/**
 * 只在这台手机第一次打开时出现一次。自己下载进来的人看通用说明；
 * 被邀请进来的人在最上面多看到邀请人的话。点「知道了」只记在本机，不写账号。
 * 其他页面（例如邀请接受页）可以传 inviter-name / inviter-message 带上邀请人的原话。
 */
Component({
  properties: {
    inviterName: { type: String, value: "" },
    inviterMessage: { type: String, value: "" },
  },

  data: {
    visible: false,
    content: null as IntroContent | null,
  },

  lifetimes: {
    attached() {
      if (hasSeenFirstLoginIntro()) return;
      void this.prepare();
    },
  },

  methods: {
    async prepare() {
      const loaded = await loadIntroInvite().catch(() => undefined);
      const invite: IntroInvite | undefined = loaded || this.data.inviterName || this.data.inviterMessage
        ? {
          ...loaded,
          inviterName: this.data.inviterName || undefined,
          inviterMessage: this.data.inviterMessage || undefined,
        }
        : undefined;
      // 等待期间可能已被别处标记为看过。
      if (hasSeenFirstLoginIntro()) return;
      this.setData({ content: buildFirstLoginIntro(invite), visible: true });
    },

    dismiss() {
      markFirstLoginIntroSeen();
      this.setData({ visible: false });
      this.triggerEvent("close");
    },

    keepOpen() {
      // 阻止点击卡片时触发遮罩。说明必须点「知道了」才关闭。
    },
  },
});
