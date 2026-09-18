const enabled=value=>String(value || '').toLowerCase()==='true';
const list=value=>String(value || '').split(',').map(item=>item.trim()).filter(Boolean);
const officialVoices=value=>{try{const parsed=JSON.parse(String(value||'[]'));return Array.isArray(parsed)?parsed.filter(item=>item&&typeof item.id==='string'&&/^\d{1,12}$/.test(item.id)&&typeof item.label==='string'&&item.label.trim().length>0&&item.label.length<=30).map(item=>({id:item.id,label:item.label.trim()})):[];}catch{return [];}};

function capabilityConfigFromEnv(env=process.env) {
  const voiceWorkerEnabled=enabled(env.STORY_AUDIO_VOICE_WORKER_ENABLED);
  return {
    pricingVersion:String(env.STORY_AUDIO_PRICING_VERSION || '').trim() || null,
    ttsEnabled:enabled(env.STORY_AUDIO_TTS_ENABLED),
    voiceCloneEnabled:enabled(env.STORY_AUDIO_VOICE_CLONE_ENABLED),
    voiceEnrollmentEnabled:enabled(env.STORY_AUDIO_VOICE_ENROLLMENT_ENABLED)&&voiceWorkerEnabled,
    voiceWorkerEnabled,
    timestampsEnabled:enabled(env.STORY_AUDIO_TIMESTAMPS_ENABLED),
    mixingEnabled:enabled(env.STORY_AUDIO_MIXING_ENABLED),
    videoEnabled:enabled(env.STORY_AUDIO_VIDEO_ENABLED),
    submissionEnabled:enabled(env.STORY_AUDIO_SUBMISSION_ENABLED),
    officialVoices:officialVoices(env.STORY_AUDIO_OFFICIAL_VOICES),
    officialVoiceIds:list(env.STORY_AUDIO_OFFICIAL_VOICE_IDS),
  };
}

module.exports={capabilityConfigFromEnv};
