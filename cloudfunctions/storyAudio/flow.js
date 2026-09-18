const core=require('./core');
const {playbackFor}=require('./access');

function createStoryAudioHandlers({repo,capabilityConfig={},processOperation,now=()=>new Date().toISOString(),log=console}) {
  const capabilities=ctx=>({...core.publicCapabilities(capabilityConfig),...(ctx?.openid?{accountScope:core.digest('voice-account:'+ctx.openid).slice(0,24)}:{})});
  async function create(ctx,event) {
    if(!ctx?.familyId||!ctx?.openid)throw new core.StoryAudioError('AUTH_REQUIRED','请重新登录');
    const input=core.normalizeCreateInput(event), operationId=ctx.familyId+'_'+input.requestId;
    const fingerprint=core.digest(input);
    const existing=await repo.getOperation(operationId);
    if(existing) {
      if(existing.fingerprint!==fingerprint)throw new core.StoryAudioError('REQUEST_CONFLICT','声音请求编号已用于其他设置');
      return {operation:core.publicOperation(existing)};
    }
    const available=capabilities();
    if(!available.submission.enabled)throw new core.StoryAudioError('AUDIO_NOT_READY','有声故事仍在安全验证中，暂时不会提交制作');
    if(!available.tts.enabled)throw new core.StoryAudioError('AUDIO_NOT_CONFIGURED','朗读服务尚未完成费用和权限核验');
    if(input.voice.kind==='clone'&&!available.voiceClone.enabled)throw new core.StoryAudioError('VOICE_CLONE_NOT_CONFIGURED','自己的声音服务尚未完成核验');
    const officialVoiceIds=[...(Array.isArray(capabilityConfig.officialVoiceIds)?capabilityConfig.officialVoiceIds:[]),...(Array.isArray(capabilityConfig.officialVoices)?capabilityConfig.officialVoices.map(voice=>voice?.id):[])];
    if(input.voice.kind==='official'&&!officialVoiceIds.includes(input.voice.id))throw new core.StoryAudioError('VOICE_NOT_FOUND','这个声音当前不可用');
    let resolvedVoice=input.voice;
    if(input.voice.kind==='clone') {
      const profile=await repo.getVoiceProfile(ctx.familyId,input.voice.id);
      const ownsVoice=profile&&(profile.ownerAccountId?profile.ownerAccountId===ctx.accountId:profile.ownerOpenid===ctx.openid);
      if(!ownsVoice||profile.status!=='ready'||profile.disabledAt||profile.deletedAt||!Number.isInteger(profile.generation)||!profile.providerVoiceId)throw new core.StoryAudioError('VOICE_NOT_FOUND','自己的声音尚未准备好或已停用');
      resolvedVoice={...input.voice,generation:profile.generation,fastVoiceType:profile.providerVoiceId};
    }
    const story=await repo.getStory(ctx.familyId,input.storyId);
    if(!story||story.deletedAt)throw new core.StoryAudioError('STORY_NOT_FOUND','这本故事书已不可用');
    if(story.currentRevisionId!==input.revisionId)throw new core.StoryAudioError('REVISION_CHANGED','书稿版本已经变化，请重新制作');
    const revision=await repo.getRevision(ctx.familyId,input.revisionId);
    const snapshot=core.chapterSnapshot({familyId:ctx.familyId,story,revision,chapterId:input.chapterId});
    const stamp=now();
    const operation={id:operationId,kind:'narration',generation:1,familyId:ctx.familyId,requesterOpenid:ctx.openid,...input,voice:resolvedVoice,fingerprint,snapshot,status:'queued',pricingVersion:available.pricingVersion,createdAt:stamp,updatedAt:stamp};
    const created=await repo.createOperation(operationId,operation);
    if(!created) {
      const raced=await repo.getOperation(operationId);
      if(!raced||raced.fingerprint!==fingerprint)throw new core.StoryAudioError('REQUEST_CONFLICT','声音请求发生冲突，请重试');
      return {operation:core.publicOperation(raced)};
    }
    return {operation:core.publicOperation(operation)};
  }
  async function status(ctx,event) {
    if(!ctx?.familyId||!ctx?.openid)throw new core.StoryAudioError('AUTH_REQUIRED','请重新登录');
    if(!core.validRequestId(event?.requestId))throw new core.StoryAudioError('INVALID_INPUT','声音请求编号无效');
    const id=ctx.familyId+'_'+String(event?.requestId||'');
    let operation=await repo.getOperation(id);
    if(!operation||operation.requesterOpenid!==ctx.openid)throw new core.StoryAudioError('OPERATION_NOT_FOUND','找不到这次声音制作');
    if(typeof processOperation==='function'&&['queued','processing'].includes(operation.status)){
      try{operation=await processOperation(operation)||await repo.getOperation(id)||operation;}
      catch(error){log.error('story audio processing deferred',{code:error?.code||'STORY_AUDIO_PROCESSING_ERROR'});operation=await repo.getOperation(id)||operation;}
    }
    const playback=operation.status==='ready'&&typeof repo.signWork==='function'?playbackFor(operation,await repo.signWork(operation)):undefined;
    return {operation:core.publicOperation(operation,playback)};
  }
  return {capabilities,create,status};
}
module.exports={createStoryAudioHandlers};
