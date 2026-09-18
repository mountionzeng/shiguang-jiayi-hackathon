const core=require('./core');
const sample=require('./sampleAccess');
const {isTrainingTextValid}=require('./voicePolicy');

const publicProfile=profile=>({
  id:profile.id,status:profile.status,generation:profile.generation,createdAt:profile.createdAt,updatedAt:profile.updatedAt,
  ...(profile.expiresAt?{expiresAt:profile.expiresAt}:{}),
  ...(profile.trainingText?.text?{readingText:profile.trainingText.text}:{}),
  ...([1,2].includes(profile.voiceGender)?{voiceGender:profile.voiceGender}:{}),
  sampleRegistered:Boolean(profile.sample?.fileID),
  sampleDeletionStatus:profile.sampleDeletionStatus||'not_requested',
  providerDeletionStatus:profile.providerDeletionStatus||'not_requested',
});
const auth=ctx=>{if(!ctx?.familyId||!ctx?.openid)throw new core.StoryAudioError('AUTH_REQUIRED','请重新登录');};
const ownerMatches=(profile,ctx)=>profile.ownerAccountId?profile.ownerAccountId===ctx.accountId:profile.ownerOpenid===ctx.openid;
const owned=async(repo,ctx,profileId)=>{
  if(!core.validVoiceProfileId(profileId))throw new core.StoryAudioError('INVALID_INPUT','声音编号无效');
  const profile=await repo.getVoiceProfile(ctx.familyId,profileId);
  if(!profile||!ownerMatches(profile,ctx))throw new core.StoryAudioError('VOICE_NOT_FOUND','找不到这个声音');
  return profile;
};

function createVoiceProfileHandlers({repo,capabilityConfig={},now=()=>new Date().toISOString()}) {
  const ensureEnrollment=()=>{if(!capabilityConfig.voiceEnrollmentEnabled||!capabilityConfig.pricingVersion)throw new core.StoryAudioError('VOICE_ENROLLMENT_NOT_READY','自己的声音仍在核验，暂时不会上传录音');};
  async function prepare(ctx,event) {
    auth(ctx);ensureEnrollment();
    if(!core.validVoiceProfileId(event?.profileId)||!core.validRequestId(event?.requestId)||event?.consentVersion!=='voice-clone-v1'||![1,2].includes(event?.voiceGender))throw new core.StoryAudioError('INVALID_INPUT','声音授权信息无效');
    const expectedPath=sample.samplePath({familyId:ctx.familyId,openid:ctx.openid,profileId:event.profileId,requestId:event.requestId});
    const existing=await repo.getVoiceProfile(ctx.familyId,event.profileId);
    if(existing) {
      if(!ownerMatches(existing,ctx)||existing.consent?.requestId!==event.requestId||existing.voiceGender!==event.voiceGender)throw new core.StoryAudioError('REQUEST_CONFLICT','声音编号已用于其他授权');
      const stamp=now();
      if(existing.status==='awaiting_sample'&&!isTrainingTextValid(existing.trainingText,stamp)) {
        const patch={status:'preparing_text',trainingText:null,updatedAt:stamp};
        if(!await repo.updateVoiceProfile(ctx.familyId,existing.id,{status:existing.status,generation:existing.generation},patch))return prepare(ctx,event);
        return {profile:publicProfile({...existing,...patch}),upload:{cloudPath:existing.expectedSamplePath}};
      }
      return {profile:publicProfile(existing),upload:{cloudPath:existing.expectedSamplePath}};
    }
    const stamp=now(),profile={id:event.profileId,familyId:ctx.familyId,...(ctx.accountId?{ownerAccountId:ctx.accountId}:{}),ownerOpenid:ctx.openid,status:'preparing_text',generation:1,voiceGender:event.voiceGender,consent:{version:event.consentVersion,requestId:event.requestId,acceptedAt:stamp},expectedSamplePath:expectedPath,createdAt:stamp,updatedAt:stamp};
    const created=await repo.createVoiceProfile(ctx.familyId,event.profileId,profile);
    if(!created)return prepare(ctx,event);
    return {profile:publicProfile(profile),upload:{cloudPath:expectedPath}};
  }
  async function registerSample(ctx,event) {
    auth(ctx);ensureEnrollment();
    const profile=await owned(repo,ctx,event?.profileId);
    if(profile.status==='sample_registered'&&profile.sample?.fileID===event.fileID)return {profile:publicProfile(profile)};
    if(profile.status!=='awaiting_sample')throw new core.StoryAudioError('VOICE_STATE_CHANGED','声音状态已经变化，请刷新');
    sample.assertRegisteredSamplePath(event?.fileID,profile.expectedSamplePath);
    if(!isTrainingTextValid(profile.trainingText,now()))throw new core.StoryAudioError('VOICE_TRAINING_TEXT_EXPIRED','腾讯云朗读文字已过期，请重新获取文字并重新录音');
    const stamp=now(),patch={status:'sample_registered',sample:{fileID:event.fileID,declaredByOpenid:ctx.openid,registeredAt:stamp,inspectionStatus:'pending'},updatedAt:stamp};
    const updated=await repo.updateVoiceProfile(ctx.familyId,profile.id,{status:profile.status,generation:profile.generation},patch);
    if(!updated)throw new core.StoryAudioError('VOICE_STATE_CHANGED','声音状态已经变化，请刷新');
    return {profile:publicProfile({...profile,...patch})};
  }
  async function status(ctx,event){auth(ctx);return {profile:publicProfile(await owned(repo,ctx,event?.profileId))};}
  async function disable(ctx,event) {
    auth(ctx);const profile=await owned(repo,ctx,event?.profileId);
    if(profile.status==='disabled')return {profile:publicProfile(profile)};
    const stamp=now(),patch={status:'disabled',generation:profile.generation+1,disabledAt:stamp,updatedAt:stamp};
    const updated=await repo.updateVoiceProfile(ctx.familyId,profile.id,{status:profile.status,generation:profile.generation},patch);
    if(!updated)throw new core.StoryAudioError('VOICE_STATE_CHANGED','声音状态已经变化，请刷新');
    return {profile:publicProfile({...profile,...patch})};
  }
  async function requestDelete(ctx,event) {
    auth(ctx);const profile=await owned(repo,ctx,event?.profileId);
    if(['deleting','deletion_pending_provider','deletion_pending_sample','deleted'].includes(profile.status))return {profile:publicProfile(profile)};
    const stamp=now(),patch={
      status:'deleting',generation:profile.generation+1,disabledAt:profile.disabledAt||stamp,deleteRequestedAt:stamp,updatedAt:stamp,
      sampleDeletionStatus:profile.sample?.fileID?'pending':profile.expectedSamplePath?'verification_pending':'not_present',
      providerDeletionStatus:profile.providerVoiceId?'manual_review':'not_created',
    };
    const updated=await repo.updateVoiceProfile(ctx.familyId,profile.id,{status:profile.status,generation:profile.generation},patch);
    if(!updated)throw new core.StoryAudioError('VOICE_STATE_CHANGED','声音状态已经变化，请刷新');
    return {profile:publicProfile({...profile,...patch})};
  }
  return {prepare,registerSample,status,disable,requestDelete};
}

module.exports={createVoiceProfileHandlers,publicProfile};
