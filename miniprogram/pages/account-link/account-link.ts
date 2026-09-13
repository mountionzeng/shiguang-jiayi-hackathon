import { accountOwner } from "../../domain/biography";
import { drinkingTimeLinkStatus, importDrinkingTimeStory, linkDrinkingTimeEmail, listDrinkingTimeStoryPage, readDrinkingTimeStory, requestDrinkingTimeOtp, DrinkingTimeStory } from "../../services/drinkingTimeAccount";
import { loadRoomStateRemoteFirst } from "../../services/roomRepository";
Page({
  data: { email: "", otp: "", busy: false, linked: false, linkedEmailHint: "", stories: [] as DrinkingTimeStory[], nextCursor: null as number | null, selectedId: 0, selectedTitle: "", selectedBody: "", fragment: "", previewOpen: false },
  onLoad() { void this.restoreLinkState(); },
  async restoreLinkState() {
    this.setData({ busy: true });
    try {
      const status = await drinkingTimeLinkStatus();
      if (!status.linked) return;
      const page = await listDrinkingTimeStoryPage();
      this.setData({ linked: true, linkedEmailHint: status.emailHint, stories: page.stories, nextCursor: page.nextCursor });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "关联状态加载失败", icon: "none" });
    } finally {
      this.setData({ busy: false });
    }
  },
  onEmail(event: WechatMiniprogram.Input) { this.setData({ email: event.detail.value }); },
  onOtp(event: WechatMiniprogram.Input) { this.setData({ otp: event.detail.value }); },
  async sendOtp() { if (this.data.busy) return; this.setData({ busy: true }); try { await requestDrinkingTimeOtp(this.data.email); wx.showToast({ title: "验证码已发送", icon: "success" }); } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "发送失败", icon: "none" }); } finally { this.setData({ busy: false }); } },
  async link() { if (this.data.busy) return; this.setData({ busy: true }); try { await linkDrinkingTimeEmail(this.data.email, this.data.otp); const [page, status] = await Promise.all([listDrinkingTimeStoryPage(), drinkingTimeLinkStatus()]); this.setData({ linked: true, linkedEmailHint: status.emailHint, stories: page.stories, nextCursor: page.nextCursor }); wx.showToast({ title: "关联成功", icon: "success" }); } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "关联失败", icon: "none" }); } finally { this.setData({ busy: false }); } },
  async loadMore() { if (this.data.busy || this.data.nextCursor === null) return; this.setData({ busy: true }); try { const page = await listDrinkingTimeStoryPage(this.data.nextCursor); const seen = new Set(this.data.stories.map(item => item.id)); this.setData({ stories: [...this.data.stories, ...page.stories.filter(item => !seen.has(item.id))], nextCursor: page.nextCursor }); } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "加载失败", icon: "none" }); } finally { this.setData({ busy: false }); } },
  async choose(event: { currentTarget: { dataset: { id: number } } }) { if (this.data.busy) return; this.setData({ busy: true }); try { const document = await readDrinkingTimeStory(Number(event.currentTarget.dataset.id)); if (!document.bodyAvailable) throw new Error("这篇故事还没有可导入的正文"); this.setData({ selectedId: document.id, selectedTitle: document.title, selectedBody: document.body, fragment: document.body.slice(0, 500), previewOpen: true }); } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "读取失败", icon: "none" }); } finally { this.setData({ busy: false }); } },
  onFragment(event: WechatMiniprogram.Input) { this.setData({ fragment: event.detail.value }); },
  closePreview() { if (!this.data.busy) this.setData({ previewOpen: false }); },
  async importFull() { await this.importSelected(false); }, async importFragment() { await this.importSelected(true); },
  async importSelected(fragmentOnly: boolean) { if (this.data.busy) return; this.setData({ busy: true }); try { const state = await loadRoomStateRemoteFirst(), member = accountOwner(state.members); if (!member) throw new Error("请先建立自己的档案"); const document = await readDrinkingTimeStory(this.data.selectedId); const count = await importDrinkingTimeStory(document, member, state.contributions, fragmentOnly ? this.data.fragment : undefined); wx.showToast({ title: count ? `已导入 ${count} 段` : "这份内容已经导入过", icon: count ? "success" : "none" }); this.setData({ previewOpen: false }); } catch (error) { wx.showToast({ title: error instanceof Error ? error.message : "导入失败", icon: "none" }); } finally { this.setData({ busy: false }); } },
  onShareAppMessage() { return { title: "拾光家忆｜把重要的故事慢慢写下来", path: "/pages/index/index" }; },
});
