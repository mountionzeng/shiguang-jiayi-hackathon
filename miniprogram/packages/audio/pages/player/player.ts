import {AudioCue,readingLines} from '../../../../domain/audioTimeline';
import {NativeStoryAudio,StoryAudioPlayer} from '../../../../services/storyAudioPlayer';
import {saveStoryVideo,StoryAudioPlayback,storyAudioApi} from '../../../../services/storyAudioService';

type StoryLine={text:string;active:boolean;cueIndex:number;endCueIndex:number};
const messageFor=(status:string)=>({queued:'作品正在排队',claimed:'作品正在准备',submitted:'作品已提交',processing:'作品正在制作',storing:'作品正在保存',unknown:'作品结果尚不明确，请先不要重复制作',failed:'作品制作没有完成',cancelled:'作品已取消'}[status]||'作品尚未生成');
const formatTime=(milliseconds:number)=>{const seconds=Math.max(0,Math.floor(milliseconds/1000));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;};
const playable=(value:StoryAudioPlayback|undefined)=>Boolean(value&&typeof value.audioUrl==='string'&&value.audioUrl.startsWith('https://')&&typeof value.text==='string'&&Number.isFinite(value.durationMs)&&value.durationMs>0&&Array.isArray(value.timeline));

Page({
  data:{title:'有声故事',notice:'正在读取作品状态…',lines:[] as StoryLine[],activeLineId:'',positionLabel:'00:00',durationLabel:'00:00',progress:0,playing:false,waiting:false,staticMode:false,textScale:1,ready:false,videoUrl:'',savingVideo:false},
  player:undefined as StoryAudioPlayer|undefined,
  requestId:'',refreshToken:0,refreshTimer:undefined as ReturnType<typeof setTimeout>|undefined,unloaded:false,hidden:false,
  onLoad(options:{title?:string;requestId?:string}={}){
    const decode=(value?:string)=>{try{return decodeURIComponent(value||'');}catch{return '';}};
    this.requestId=decode(options.requestId);
    const title=decode(options.title);if(title)this.setData({title});
    if(!this.requestId)this.setData({notice:'缺少作品编号，请从有声故事制作页进入。'});
  },
  onShow(){this.unloaded=false;this.hidden=false;this.stopRefresh();if(this.requestId)void this.refresh();},
  onHide(){this.hidden=true;this.stopRefresh();this.stopPlayback();},onUnload(){this.unloaded=true;this.stopRefresh();this.stopPlayback();},
  stopRefresh(){if(this.refreshTimer!==undefined)clearTimeout(this.refreshTimer);this.refreshTimer=undefined;},
  scheduleRefresh(){this.stopRefresh();if(this.unloaded||this.hidden)return;this.refreshTimer=setTimeout(()=>{this.refreshTimer=undefined;if(!this.unloaded&&!this.hidden)void this.refresh();},1800);},
  stopPlayback(){this.refreshToken++;this.player?.destroy();this.player=undefined;this.setData({playing:false,waiting:false});},
  async refresh(){
    const token=++this.refreshToken;
    try{
      const {operation}=await storyAudioApi.status(this.requestId);
      if(this.unloaded||this.hidden||token!==this.refreshToken)return;
      const playback=operation.status==='ready'&&playable(operation.playback)?operation.playback:undefined;
      if(!playback){this.setData({ready:false,notice:operation.error?.message||messageFor(operation.status)});if(['queued','claimed','submitted','processing','storing'].includes(operation.status))this.scheduleRefresh();return;}
      this.stopRefresh();
      this.setData({title:operation.snapshot.bookTitle||operation.snapshot.title||this.data.title,notice:playback.synchronized?'轻点播放，文字会跟着朗读移动。':'这份作品没有可信字幕时间，仍可静态阅读和收听。'});
      this.loadPlayback(playback);
    }catch(error){if(!this.unloaded&&token===this.refreshToken)this.setData({ready:false,notice:error instanceof Error?error.message:'暂时无法读取作品，请稍后重试。'});}
  },
  loadPlayback(playback:StoryAudioPlayback){
    this.player?.destroy();
    const cues=playback.timeline as AudioCue[];
    const lines:StoryLine[]=playback.synchronized&&cues.length?readingLines(playback.text,cues).map(line=>({...line,active:false})):[{text:playback.text,active:false,cueIndex:-1,endCueIndex:-1}];
    this.setData({lines,activeLineId:'',positionLabel:'00:00',durationLabel:formatTime(playback.durationMs),progress:0,playing:false,waiting:false,staticMode:!playback.synchronized,ready:true,videoUrl:playback.videoUrl||''});
    this.player=new StoryAudioPlayer(
      ()=>wx.createInnerAudioContext() as unknown as NativeStoryAudio,
      progress=>{
        if(this.unloaded||this.hidden)return;
        const nextLines=this.data.lines.map(line=>({...line,active:progress.cueIndex>=0&&line.cueIndex<=progress.cueIndex&&progress.cueIndex<=line.endCueIndex}));
        const activeLine=nextLines.findIndex(line=>line.active);
        this.setData({lines:nextLines,...(activeLine>=0?{activeLineId:`story-line-${activeLine}`} : {}),positionLabel:formatTime(progress.positionMs),durationLabel:formatTime(progress.durationMs),progress:progress.durationMs?Math.round(progress.positionMs/progress.durationMs*100):0,playing:progress.playing,waiting:progress.waiting});
      },
    );
    this.player.load({url:playback.audioUrl,durationMs:playback.durationMs,cues:playback.synchronized?cues:[]});
  },
  togglePlayback(){if(!this.data.ready||!this.player)return;if(this.data.playing)this.player.pause();else this.player.play();},
  seekLine(event:{currentTarget:{dataset:{index?:string|number}}}){const index=Number(event.currentTarget.dataset.index);if(Number.isInteger(index)&&index>=0)this.player?.seekToCue(index);},
  changeTextSize(event:{currentTarget:{dataset:{delta?:string|number}}}){const delta=Number(event.currentTarget.dataset.delta);const textScale=Math.max(.86,Math.min(1.22,Math.round((this.data.textScale+delta)*100)/100));this.setData({textScale});},
  async saveVideo(){if(!this.data.videoUrl||this.data.savingVideo)return;this.setData({savingVideo:true});try{await saveStoryVideo(this.data.videoUrl);wx.showToast({title:'已保存到相册',icon:'success'});}catch(error){wx.showToast({title:error instanceof Error?error.message:'保存没有完成，请重试',icon:'none'});}finally{if(!this.unloaded)this.setData({savingVideo:false});}},
  onShareAppMessage(){return {title:'拾光家忆｜让故事被听见',path:'/pages/index/index'};},onShareTimeline(){return {title:'拾光家忆｜让故事被听见'};},
});
