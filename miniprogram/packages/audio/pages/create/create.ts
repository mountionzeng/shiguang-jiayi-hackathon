import {newAudioRequestId,storyAudioApi,StoryAudioCapabilities} from '../../../../services/storyAudioService';

type ChapterIntent={requestId:string;voice:{kind:'official';id:string}};

type SelectedVoice={kind:'official'|'clone';id:string;label:string};

const unavailableReason=(capabilities:StoryAudioCapabilities|null)=>{
  if(!capabilities)return '正在确认声音服务状态…';
  if(!capabilities.submission.enabled)return '有声故事链路仍在安全验证中，暂时不会提交制作。';
  if(!capabilities.tts.enabled)return capabilities.tts.reason==='pricing_not_configured'?'朗读服务还没有完成费用配置，暂时不会提交制作。':'朗读服务正在核验腾讯云账号能力，暂时不会提交制作。';
  return '';
};

Page({
  data:{storyId:'',revisionId:'',chapterId:'',loading:true,loadError:'',unavailable:'',canCreate:false,canary:false,hasPending:false,cloneAvailable:false,videoAvailable:false,creating:false,selectedVoice:null as SelectedVoice|null,officialVoices:[] as Array<{id:string;label:string}>},
  unloaded:false,
  pendingKey:'',
  pending:undefined as ChapterIntent|undefined,
  onLoad(options:{storyId?:string;revisionId?:string;chapterId?:string}={}) {
    const decode=(value?:string)=>{try{return decodeURIComponent(value || '');}catch{return '';}};
    const storyId=decode(options.storyId),revisionId=decode(options.revisionId),chapterId=decode(options.chapterId);
    this.setData({storyId,revisionId,chapterId});
    if(!storyId||!revisionId||!chapterId)this.setData({loading:false,loadError:'缺少已保存的故事版本，请返回书稿重新进入。'});
  },
  onShow(){if(!this.data.loadError)void this.refreshCapabilities();},
  onUnload(){this.unloaded=true;},
  async refreshCapabilities(){
    this.setData({loading:true,loadError:'',cloneAvailable:false});
    try{
      const legacy=await storyAudioApi.capabilities();
      const scope=legacy.accountScope;
      const key=/^[a-f0-9]{24}$/.test(scope)?['chapter-audio-canary',scope,this.data.storyId,this.data.revisionId,this.data.chapterId].join(':'):'';
      const value=key?wx.getStorageSync<ChapterIntent>(key):undefined;
      if(this.unloaded)return;
      this.pendingKey=key;
      this.pending=value?.requestId?.startsWith('audio-canary-v1-')&&value.voice?.kind==='official'&&typeof value.voice.id==='string'?value:undefined;
      this.setData({hasPending:!!this.pending});
      const canary=legacy.chapterRoute==='canary';
      const capabilities=canary?await storyAudioApi.canaryCapabilities():legacy;
      if(this.unloaded)return;
      this.setData({loading:false,canary,unavailable:unavailableReason(capabilities),canCreate:(!canary||!!key)&&capabilities.submission.enabled&&capabilities.tts.enabled,cloneAvailable:capabilities.submission.enabled&&capabilities.voiceClone.enabled&&capabilities.voiceEnrollment.enabled,videoAvailable:capabilities.submission.enabled&&capabilities.video.enabled,officialVoices:Array.isArray(capabilities.officialVoices)?capabilities.officialVoices.filter(item=>item&&typeof item.id==='string'&&typeof item.label==='string'):[]});
    }catch(error){if(!this.unloaded)this.setData({loading:false,loadError:error instanceof Error?error.message:'声音服务暂时没有响应，请稍后再试。',canCreate:false});}
  },
  openVoices(){if(this.data.loading||!this.data.cloneAvailable){wx.showToast({title:'请先选择页面上的朗读声音',icon:'none'});return;}wx.navigateTo({url:'/packages/audio/pages/voices/voices?select=1',events:{selectVoice:(voice:SelectedVoice)=>{if(voice&&['official','clone'].includes(voice.kind)&&voice.id)this.setData({selectedVoice:voice});}}});},
  chooseOfficial(event:{currentTarget:{dataset:{id?:string;label?:string}}}){const {id,label}=event.currentTarget.dataset;if(id&&label)this.setData({selectedVoice:{kind:'official',id,label}});},
  async startCreate(){
    if(!this.pending&&!this.data.canCreate){wx.showToast({title:this.data.unavailable || '声音服务暂未开放',icon:'none'});return;}
    const voice=this.data.selectedVoice;
    if(!voice&&!this.pending){wx.showToast({title:'请先选择已经核验的声音',icon:'none'});return;}
    if(this.data.creating)return;
    this.setData({creating:true,loadError:''});
    try{
      const routeCanary=this.data.canary||!!this.pending;
      const requestId=this.pending?.requestId||newAudioRequestId(routeCanary);
      const selected=this.pending?.voice||voice!;
      if(routeCanary&&!this.pending){
        if(!this.pendingKey||selected.kind!=='official')return;
        const intent:ChapterIntent={requestId,voice:{kind:'official',id:selected.id}};
        wx.setStorageSync(this.pendingKey,intent);
        this.pending=intent;
        this.setData({hasPending:true});
      }
      const result=await storyAudioApi.create({requestId,storyId:this.data.storyId,revisionId:this.data.revisionId,chapterId:this.data.chapterId,voice:{kind:selected.kind,id:selected.id}});
      if(this.unloaded)return;
      wx.navigateTo({url:`/packages/audio/pages/player/player?requestId=${encodeURIComponent(requestId)}&title=${encodeURIComponent(result.operation.snapshot.bookTitle||result.operation.snapshot.title)}`,success:()=>{
        if(this.pending?.requestId===requestId){
          wx.removeStorageSync(this.pendingKey);
          this.pending=undefined;
          if(!this.unloaded)this.setData({hasPending:false});
        }
      }});
    }catch(error){if(!this.unloaded)this.setData({loadError:error instanceof Error?error.message:'声音制作状态未确认，请稍后重试。'});}finally{if(!this.unloaded)this.setData({creating:false});}
  },
  onShareAppMessage(){return {title:'拾光家忆｜让故事被听见',path:'/pages/index/index'};},
  onShareTimeline(){return {title:'拾光家忆｜让故事被听见'};},
});
