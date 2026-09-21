import type { ShiguangAppOptions } from "../app";

export interface AudioCapability { enabled: boolean; reason?: string }
export interface StoryAudioCapabilities {
  apiVersion: number;
  provider: 'tencent-cloud';
  voiceClone: AudioCapability;
  voiceEnrollment: AudioCapability;
  tts: AudioCapability;
  timestamps: AudioCapability;
  mixing: AudioCapability;
  video: AudioCapability;
  submission: AudioCapability;
  pricingVersion: string | null;
  accountScope: string;
  officialVoices?:Array<{id:string;label:string}>;
}
export interface StoryAudioPlayback {
  audioUrl:string; videoUrl?:string; text:string; durationMs:number; timeline:Array<{text:string;start:number;end:number;beginMs:number;endMs:number}>; synchronized:boolean;
}
export interface StoryAudioOperation {
  id:string; storyId:string; revisionId:string; chapterId:string;
  status:'queued'|'claimed'|'submitted'|'processing'|'storing'|'ready'|'failed'|'unknown'|'cancelled'|'deleting';
  createdAt:string; updatedAt:string;
  snapshot:{title:string;bookTitle:string;digest:string};
  voice:{kind:'official'|'clone'};
  background?:{id:string;volume:number};
  playback?:StoryAudioPlayback;
  error?:{code:string;message:string};
}
export type VoiceProfileStatus='preparing_text'|'fetching_text'|'awaiting_sample'|'sample_registered'|'detecting'|'detected'|'submitting'|'training'|'ready'|'failed'|'unknown'|'disabled'|'deleting'|'deletion_pending_provider'|'deletion_pending_sample'|'deleted';
export interface VoiceProfile {id:string;status:VoiceProfileStatus;generation:number;createdAt:string;updatedAt:string;expiresAt?:string;readingText?:string;voiceGender?:1|2;sampleRegistered:boolean;sampleDeletionStatus:string;providerDeletionStatus:string}
export class StoryAudioServiceError extends Error {
  constructor(readonly code:string,message:string){super(message);this.name='StoryAudioServiceError';}
}

function assertAudioReady():void {
  if(!wx.cloud||typeof getApp!=="function")throw new StoryAudioServiceError('STORY_AUDIO_NOT_READY','有声故事尚未开放');
  const app=getApp<ShiguangAppOptions>();
  if(!app?.globalData?.cloudReady||!app.globalData.aiReady)throw new StoryAudioServiceError('STORY_AUDIO_NOT_READY','有声故事尚未开放');
}

async function call<T>(action:string,data:Record<string,unknown>={}):Promise<T> {
  assertAudioReady();
  const response=await wx.cloud.callFunction({name:'storyAudio',data:{...data,action}});
  const result=response.result as ({error?:string;code?:string;message?:string}&T)|undefined;
  if(!result||result.error)throw new StoryAudioServiceError(result?.code || 'STORY_AUDIO_ERROR',result?.message || '声音服务暂不可用，请稍后重试');
  return result;
}
export const newAudioRequestId=()=>`audio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
export const newVoiceProfileId=()=>`voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
export const audioCreatePath=(input:{storyId:string;revisionId:string;chapterId:string})=>'/packages/audio/pages/create/create?'+[
  'storyId='+encodeURIComponent(input.storyId),
  'revisionId='+encodeURIComponent(input.revisionId),
  'chapterId='+encodeURIComponent(input.chapterId),
].join('&');
export const storyAudioApi={
  capabilities:()=>call<StoryAudioCapabilities>('capabilities'),
  create:(input:{requestId:string;storyId:string;revisionId:string;chapterId:string;voice:{kind:'official'|'clone';id:string};background?:{id:string;volume:number}})=>call<{operation:StoryAudioOperation}>('create',input),
  status:(requestId:string)=>call<{operation:StoryAudioOperation}>('status',{requestId}),
  prepareVoice:(input:{requestId:string;profileId:string;consentVersion:string;voiceGender:1|2})=>call<{profile:VoiceProfile;upload:{cloudPath:string}}>('voicePrepare',input),
  registerVoiceSample:(input:{profileId:string;fileID:string})=>call<{profile:VoiceProfile}>('voiceRegisterSample',input),
  voiceStatus:(profileId:string)=>call<{profile:VoiceProfile}>('voiceStatus',{profileId}),
  disableVoice:(profileId:string)=>call<{profile:VoiceProfile}>('voiceDisable',{profileId}),
  deleteVoice:(profileId:string)=>call<{profile:VoiceProfile}>('voiceDelete',{profileId}),
};

export async function uploadVoiceSample(cloudPath:string,filePath:string):Promise<string>{
  assertAudioReady();
  const result=await wx.cloud.uploadFile({cloudPath,filePath});
  if(!result.fileID)throw new StoryAudioServiceError('UPLOAD_FAILED','录音没有上传成功，请重试');
  return result.fileID;
}
export async function deleteUploadedVoiceSample(fileID:string):Promise<void>{
  if(!fileID.startsWith('cloud://'))return;
  assertAudioReady();
  await wx.cloud.deleteFile({fileList:[fileID]});
}

/** Delivery is deliberately separate from media creation: an album failure never re-runs TTS or rendering. */
export async function saveStoryVideo(url:string,api:Pick<typeof wx,'downloadFile'|'saveVideoToPhotosAlbum'>=wx):Promise<void>{
  if(typeof url!=='string'||!url.startsWith('https://signed.'))throw new StoryAudioServiceError('INVALID_PLAYBACK_URL','作品播放地址无效，请刷新后重试');
  const downloaded=await new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>((resolve,reject)=>api.downloadFile({url,success:resolve,fail:reject}));
  if(downloaded.statusCode!==200||!downloaded.tempFilePath)throw new StoryAudioServiceError('DOWNLOAD_FAILED','作品下载没有完成，请重试保存');
  await new Promise<void>((resolve,reject)=>api.saveVideoToPhotosAlbum({filePath:downloaded.tempFilePath,success:()=>resolve(),fail:reject}));
}
