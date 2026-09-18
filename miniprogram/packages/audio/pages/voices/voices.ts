import {deleteUploadedVoiceSample,newAudioRequestId,newVoiceProfileId,storyAudioApi,uploadVoiceSample,VoiceProfile} from '../../../../services/storyAudioService';
import {requestVoiceConsent,VOICE_CONSENT_VERSION} from '../../../../services/voiceConsent';
import {recordVoiceSample,stopVoiceRecording,validateRecordedVoiceSample} from '../../../../services/voiceRecorder';

const STORAGE_KEY='shiguang-voice-profile-v2';
type StoredVoice={profileId:string;requestId:string};
const storageKey=(accountScope:string)=>`${STORAGE_KEY}:${accountScope}`;
const storedVoice=(accountScope:string):StoredVoice|undefined=>{
  const value=wx.getStorageSync(storageKey(accountScope)) as Partial<StoredVoice>|undefined;
  return value&&typeof value.profileId==='string'&&typeof value.requestId==='string'?value as StoredVoice:undefined;
};

Page({
  data:{loading:true,available:false,busy:false,recording:false,uploading:false,selecting:false,voiceGender:0 as 0|1|2,profile:null as VoiceProfile|null,notice:'正在确认自己的声音功能…'},
  unloaded:false,hidden:false,accountScope:'',refreshToken:0,
  onLoad(options:{select?:string}={}){this.setData({selecting:options.select==='1'});},
  onShow(){this.unloaded=false;this.hidden=false;this.setData({recording:false});void this.refresh();},
  onHide(){this.hidden=true;if(this.data.recording)stopVoiceRecording();this.setData({recording:false});},
  onUnload(){this.unloaded=true;this.hidden=true;this.refreshToken++;stopVoiceRecording();this.setData({recording:false});},
  isStale(accountScope:string){return this.unloaded||this.hidden||this.accountScope!==accountScope;},
  async refresh(){
    const token=++this.refreshToken;
    try{
      const result=await storyAudioApi.capabilities(),available=result.voiceEnrollment.enabled;
      if(this.unloaded||token!==this.refreshToken)return;
      const changed=Boolean(this.accountScope&&this.accountScope!==result.accountScope);
      this.accountScope=result.accountScope;
      this.setData({loading:false,available,...(changed?{profile:null,voiceGender:0}:{}),notice:available?'录制前会再次说明用途，并需要你明确允许。':'自己的声音功能正在核验，当前不会开启录音或上传样本。'});
      const saved=storedVoice(this.accountScope);
      if(saved){
        try{
          const status=await storyAudioApi.voiceStatus(saved.profileId);
          if(!this.unloaded&&token===this.refreshToken&&this.accountScope===result.accountScope)this.setData({profile:status.profile,voiceGender:status.profile.voiceGender||0});
        }catch{/* Account-scoped local id can be stale after server cleanup. */}
      }
    }catch(error){if(!this.unloaded&&token===this.refreshToken)this.setData({loading:false,available:false,notice:error instanceof Error?error.message:'暂时无法确认服务状态'});}
  },
  chooseGender(event:WechatMiniprogram.CustomEvent){const value=Number(event.detail.value);if(value===1||value===2)this.setData({voiceGender:value});},
  async beginRecording(){
    if(!this.data.available){wx.showToast({title:'录音功能暂未开放',icon:'none'});return;}
    if(this.data.busy)return;
    if(!this.accountScope){this.setData({notice:'账号身份尚未确认，请稍后重试。'});return;}
    if(this.data.voiceGender!==1&&this.data.voiceGender!==2){this.setData({notice:'请先选择与声音本人一致的声音类型。'});return;}
    const accountScope=this.accountScope;
    this.setData({busy:true});
    let saved:StoredVoice|undefined,uploadedFileID='',registered=false;
    try{
      if(!await requestVoiceConsent(accountScope)){this.setData({notice:'你没有授权，因此没有开始录音，也没有上传任何声音。'});return;}
      if(this.isStale(accountScope))return;
      saved=storedVoice(accountScope);
      if(this.data.profile&&['disabled','deleting','deletion_pending_provider','deletion_pending_sample','deleted'].includes(this.data.profile.status))saved=undefined;
      if(!saved){saved={profileId:newVoiceProfileId(),requestId:newAudioRequestId()};wx.setStorageSync(storageKey(accountScope),saved);}
      const prepared=await storyAudioApi.prepareVoice({...saved,consentVersion:VOICE_CONSENT_VERSION,voiceGender:this.data.voiceGender});
      if(this.isStale(accountScope))return;
      if(prepared.profile.status!=='awaiting_sample'||!prepared.profile.readingText){this.setData({profile:prepared.profile,notice:'正在准备腾讯云专用朗读文字。准备好后再点一次录音。'});return;}
      this.setData({recording:true,profile:prepared.profile,notice:'请照着页面文字自然朗读；超过 5 秒后可结束，最长 14 秒。'});
      const recorded=validateRecordedVoiceSample(await recordVoiceSample());
      if(this.isStale(accountScope))return;
      this.setData({recording:false,uploading:true,notice:'录音已完成，正在安全上传…'});
      uploadedFileID=await uploadVoiceSample(prepared.upload.cloudPath,recorded.tempFilePath);
      if(this.isStale(accountScope)){await deleteUploadedVoiceSample(uploadedFileID).catch(()=>undefined);return;}
      const result=await storyAudioApi.registerVoiceSample({profileId:saved.profileId,fileID:uploadedFileID});
      registered=true;
      if(!this.unloaded)this.setData({profile:result.profile,notice:'录音已登记，等待真实格式和声音质量检查。'});
    }catch(error){
      if(uploadedFileID&&!registered&&saved){
        try{
          const recovered=await storyAudioApi.voiceStatus(saved.profileId);
          registered=recovered.profile.sampleRegistered;
          if(registered&&!this.unloaded)this.setData({profile:recovered.profile,notice:'录音已登记，等待真实格式和声音质量检查。'});
        }catch{/* Fall through to private sample cleanup. */}
        if(!registered)await deleteUploadedVoiceSample(uploadedFileID).catch(()=>undefined);
      }
      if(!registered&&!this.unloaded)this.setData({notice:error instanceof Error?error.message:'录音没有完成，请重试。'});
    }finally{if(!this.unloaded)this.setData({busy:false,recording:false,uploading:false});}
  },
  stopRecording(){stopVoiceRecording();},
  async disableVoice(){const profile=this.data.profile;if(!profile||this.data.uploading)return;try{const result=await storyAudioApi.disableVoice(profile.id);if(!this.unloaded)this.setData({profile:result.profile,notice:'已停用。正在处理中的迟到结果不会重新启用这个声音。'});}catch(error){if(!this.unloaded)this.setData({notice:error instanceof Error?error.message:'暂时无法停用，请重试'});}},
  deleteVoice(){const profile=this.data.profile;if(!profile||this.data.uploading||this.data.recording)return;wx.showModal({title:'删除这个声音？',content:'会先停用声音并删除微信云存储里的录音样本。腾讯云音色删除若不能自动完成，会明确显示为待人工处理，不会假装已经删除。',confirmText:'确认删除',confirmColor:'#9b4637',success:async result=>{if(!result.confirm)return;try{const deleted=await storyAudioApi.deleteVoice(profile.id);if(!this.unloaded)this.setData({profile:deleted.profile,notice:'删除已开始；样本和腾讯云音色会分别显示处理状态。'});}catch(error){if(!this.unloaded)this.setData({notice:error instanceof Error?error.message:'暂时无法删除，请重试'});}}});},
  useVoice(){const profile=this.data.profile;if(!this.data.selecting||!profile||profile.status!=='ready')return;this.getOpenerEventChannel().emit?.('selectVoice',{kind:'clone',id:profile.id,label:'我的声音'});wx.navigateBack();},
  onShareAppMessage(){return {title:'拾光家忆｜让故事被听见',path:'/pages/index/index'};},onShareTimeline(){return {title:'拾光家忆｜让故事被听见'};},
});
