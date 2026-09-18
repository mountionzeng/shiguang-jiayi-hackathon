const {MAX_SAMPLE_BYTES,validateInspectedSample}=require('./sampleAccess');
const {isTrainingTextValid,trainingTextExpiresAt}=require('./voicePolicy');
const CREATE_UNKNOWN_ERROR={code:'VOICE_CREATE_UNKNOWN',message:'腾讯云是否受理尚不明确，不会自动重复提交'};

function createVoiceJobProcessor({repo,provider,storage,inspectWav,now=()=>new Date().toISOString()}) {
  if(!repo||!provider||!storage||typeof inspectWav!=='function')throw new Error('VOICE_JOB_CONFIG_REQUIRED');
  const transition=async(profile,expectedStatus,patch)=>{
    const updated={...patch,updatedAt:now()};
    const accepted=await repo.updateVoiceProfile(profile.familyId,profile.id,{status:expectedStatus,generation:profile.generation},updated);
    return accepted?{...profile,...updated}:{...profile,status:'stale'};
  };
  async function process(job) {
    const profile=await repo.getVoiceProfile(job.familyId,job.profileId);
    if(!profile||profile.generation!==job.generation||profile.status==='disabled'||profile.status==='deleting')return {status:'stale'};
    if(profile.status==='preparing_text') {
      const fetching=await transition(profile,'preparing_text',{status:'fetching_text'});
      if(fetching.status==='stale')return fetching;
      try{
        const fetchedAt=now(),trainingText={...await provider.trainingText(),fetchedAt,expiresAt:trainingTextExpiresAt(fetchedAt)};
        return transition(fetching,'fetching_text',{status:'awaiting_sample',trainingText});
      }catch(error){
        return transition(fetching,'fetching_text',{status:'failed',error:{code:error?.code||'VOICE_TEXT_FAILED',message:error?.code?error.message:'暂时无法准备朗读文字，请稍后重试'}});
      }
    }
    if(profile.status==='sample_registered') {
      if(!isTrainingTextValid(profile.trainingText,now()))return transition(profile,'sample_registered',{status:'failed',error:{code:'VOICE_TRAINING_TEXT_EXPIRED',message:'腾讯云朗读文字已过期，请重新获取文字并重新录音'}});
      const detecting=await transition(profile,'sample_registered',{status:'detecting'});
      if(detecting.status==='stale')return detecting;
      try{
        if(typeof storage.stat!=='function')throw new Error('VOICE_STORAGE_METADATA_REQUIRED');
        const metadata=await storage.stat(profile.sample.fileID);
        if(!Number.isInteger(metadata?.bytes)||metadata.bytes<=0||metadata.bytes>MAX_SAMPLE_BYTES)return transition(detecting,'detecting',{status:'failed',error:{code:'INVALID_VOICE_SAMPLE',message:'录音需小于 2MB，请重新录制'}});
        const audio=await storage.read(profile.sample.fileID,{maxBytes:MAX_SAMPLE_BYTES+1});
        const inspection=validateInspectedSample(inspectWav(audio));
        const detected=await provider.detect({textId:profile.trainingText.textId,audioBase64:Buffer.from(audio).toString('base64'),sampleRate:inspection.sampleRate});
        return transition(detecting,'detecting',{status:'detected',inspection,providerAudioId:detected.audioId});
      }catch(error){
        return transition(detecting,'detecting',{status:'failed',error:{code:error?.code||'VOICE_DETECT_FAILED',message:error?.code?error.message:'录音检查没有完成，请重新录制'}});
      }
    }
    if(profile.status==='detected') {
      const submitting=await transition(profile,'detected',{status:'submitting',submissionStartedAt:now()});
      if(submitting.status==='stale')return submitting;
      try{
        const created=await provider.create({sessionId:`voice-${profile.id}-${profile.generation}`,name:'我的声音',gender:profile.voiceGender,audioId:profile.providerAudioId,sampleRate:profile.inspection.sampleRate});
        return transition(submitting,'submitting',{status:'training',providerTaskId:created.taskId});
      }catch{
        return transition(submitting,'submitting',{status:'unknown',error:CREATE_UNKNOWN_ERROR});
      }
    }
    if(profile.status==='submitting')return transition(profile,'submitting',{status:'unknown',error:CREATE_UNKNOWN_ERROR});
    if(profile.status==='training') {
      const result=await provider.status(profile.providerTaskId);
      if(result.status==='processing')return profile;
      if(result.status==='failed')return transition(profile,'training',{status:'failed',error:result.error});
      return transition(profile,'training',{status:'ready',providerVoiceId:result.fastVoiceType,expiresAt:result.expiresAt});
    }
    return profile;
  }
  async function cleanup(job) {
    const profile=await repo.getVoiceProfile(job.familyId,job.profileId);
    if(!profile||profile.generation!==job.generation||!['deleting','deletion_pending_provider','deletion_pending_sample'].includes(profile.status))return {status:'stale'};
    let sampleDeletionStatus=profile.sampleDeletionStatus;
    if(sampleDeletionStatus==='pending'&&profile.sample?.fileID){await storage.remove(profile.sample.fileID);sampleDeletionStatus='deleted';}
    if(sampleDeletionStatus==='verification_pending'&&profile.expectedSamplePath){
      if(typeof storage.removePath==='function'){await storage.removePath(profile.expectedSamplePath);sampleDeletionStatus='deleted';}
      else sampleDeletionStatus='manual_review';
    }
    const providerPending=profile.providerDeletionStatus==='manual_review';
    const samplePending=sampleDeletionStatus==='manual_review';
    return transition(profile,profile.status,{
      status:providerPending?'deletion_pending_provider':samplePending?'deletion_pending_sample':'deleted',
      sampleDeletionStatus,sampleDeletedAt:sampleDeletionStatus==='deleted'?now():undefined,
      ...(sampleDeletionStatus==='deleted'?{sample:null,expectedSamplePath:null}:{}),
    });
  }
  return {process,cleanup};
}

module.exports={createVoiceJobProcessor};
