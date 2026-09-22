import { personalMemory, PersonalInsight } from '../../services/personalMemory';
import { requestAiConsent } from '../../services/aiConsent';

Page({
  data: { enabled: false, insights: [] as Array<PersonalInsight & { originLabel: string }>, loading: true, busy: false, error: '' },
  onShow() { void this.refresh(); },
  async refresh() {
    this.setData({loading:true,error:''});
    try {
      const state = await personalMemory.list();
      this.setData({enabled:state.enabled,insights:state.insights.map(item=>({...item,
        originLabel:item.origin==='inferred' ? '小忆的暂定理解' : item.origin==='user_corrected' ? '依据你的纠正' : '依据你的讲述'}))});
    } catch { this.setData({error:'暂时无法读取，请稍后重试。'}); }
    finally { this.setData({loading:false}); }
  },
  toggleEnabled() {
    if (this.data.busy || this.data.loading || this.data.error) return;
    const enabled = !this.data.enabled;
    wx.showModal({title:enabled ? '让小忆记住你的讲述？' : '暂停小忆的记忆？',
      content:enabled ? '你今后保存的本人原话会交给在线 AI 提炼少量个人背景，并用于以后的个人访谈和文字整理。此过程可能产生模型调用费用。不把家人或作品人物当作你；敏感理解不主动提及。你可以逐条忘记，原故事仍保留。' : '暂停后不再提炼或使用个人背景；已有理解仍可查看和忘记。',
      confirmText:enabled ? '同意并开启' : '暂停',success:result=>{if(result.confirm)void this.confirmEnabled(enabled);}});
  },
  async confirmEnabled(enabled: boolean) {
    if (this.data.busy) return;
    this.setData({busy:true});
    try {
      if (enabled && !await requestAiConsent()) return;
      await personalMemory.configure(enabled);
      await this.refresh();
    } catch { wx.showToast({title:'设置未保存，请重试',icon:'none'}); }
    finally { this.setData({busy:false}); }
  },
  forget(event: {currentTarget:{dataset:{key:string}}}) {
    if (this.data.busy) return;
    const item = this.data.insights.find(value=>value.lineageKey===event.currentTarget.dataset.key);
    if (!item) return;
    wx.showModal({title:'忘记这条理解？',content:'小忆会停止使用这条理解，也不再从相同证据重新提炼。你的原话和故事不会被删除。',confirmText:'忘记',success:result=>{if(result.confirm)void this.confirmForget(item.lineageKey);}});
  },
  async confirmForget(lineageKey: string) {
    if (this.data.busy) return;
    this.setData({busy:true});
    try { await personalMemory.forget(lineageKey); await this.refresh(); }
    catch { wx.showToast({title:'尚未忘记，请重试',icon:'none'}); }
    finally { this.setData({busy:false}); }
  },
  onShareAppMessage() { return {title:'拾光家忆｜把重要的故事慢慢写下来',path:'/pages/index/index'}; },
  onShareTimeline() { return {title:'拾光家忆｜把重要的故事慢慢写下来'}; },
});
