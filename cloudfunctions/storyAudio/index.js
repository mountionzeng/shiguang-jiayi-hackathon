const cloud=require('wx-server-sdk');
const {StoryAudioError}=require('./core');
const {capabilityConfigFromEnv}=require('./capabilities');
const {createStoryAudioHandlers}=require('./flow');
const {createStoryAudioRepository}=require('./repository');
const {createVoiceProfileHandlers}=require('./voiceProfiles');
const {resolveStoryAudioIdentity}=require('./identity');
const {createCloudAudioRuntime}=require('./cloudRuntime');

cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db=cloud.database();
const signFile=async fileID=>{
  const result=await cloud.getTempFileURL({fileList:[{fileID,maxAge:2*60*60}]});
  return result?.fileList?.find(item=>item.fileID===fileID)?.tempFileURL || '';
};
const repo=createStoryAudioRepository(db,{signFile});
const runtime=createCloudAudioRuntime({cloud,db});
const capabilityConfig=runtime.capabilityConfig||capabilityConfigFromEnv();
const handlers=createStoryAudioHandlers({repo,capabilityConfig,processOperation:runtime.processOperation});
const voiceHandlers=createVoiceProfileHandlers({repo,capabilityConfig});

async function advanceVoice(ctx,profileId) {
  const profile=await repo.getVoiceProfile(ctx.familyId,profileId);
  if(profile&&typeof runtime.processVoiceProfile==='function')await runtime.processVoiceProfile(profile);
  return voiceHandlers.status(ctx,{profileId});
}

function errorResponse(error) {
  const known=error instanceof StoryAudioError;
  return {error:'STORY_AUDIO_ERROR',code:known?error.code:'STORY_AUDIO_ERROR',message:known?error.message:'声音服务暂不可用，请稍后重试'};
}

exports.main=async (event={},context={})=>{
  try{
    if(event.Type==='Timer'||context.SOURCE==='wx_trigger')return runtime.sweep();
    const openid=String(cloud.getWXContext().OPENID || '');
    if(!openid)throw new StoryAudioError('AUTH_REQUIRED','请重新登录');
    const ctx=await resolveStoryAudioIdentity(db,openid);
    const action=String(event?.action || '');
    if(action==='capabilities')return handlers.capabilities(ctx);
    if(action==='create')return handlers.create(ctx,event);
    if(action==='status')return handlers.status(ctx,event);
    if(action==='voicePrepare'){
      const prepared=await voiceHandlers.prepare(ctx,event);
      if(prepared.profile.status==='preparing_text')prepared.profile=(await advanceVoice(ctx,event.profileId)).profile;
      return prepared;
    }
    if(action==='voiceRegisterSample'){
      const registered=await voiceHandlers.registerSample(ctx,event);
      if(registered.profile.status==='sample_registered')registered.profile=(await advanceVoice(ctx,event.profileId)).profile;
      return registered;
    }
    if(action==='voiceStatus'){
      const current=await voiceHandlers.status(ctx,event);
      if(['preparing_text','sample_registered','detected','training'].includes(current.profile.status))return advanceVoice(ctx,event.profileId);
      return current;
    }
    if(action==='voiceDisable')return voiceHandlers.disable(ctx,event);
    if(action==='voiceDelete'){
      const requested=await voiceHandlers.requestDelete(ctx,event);
      if(['deleting','deletion_pending_provider','deletion_pending_sample'].includes(requested.profile.status))return advanceVoice(ctx,event.profileId);
      return requested;
    }
    throw new StoryAudioError('INVALID_ACTION','不支持的声音操作');
  }catch(error){
    console.error('storyAudio failed',{code:error?.code || 'STORY_AUDIO_ERROR',action:String(event?.action || '')});
    return errorResponse(error);
  }
};

exports.errorResponse=errorResponse;
