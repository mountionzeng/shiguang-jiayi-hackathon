const core=require('./core');
const {StoryAudioError}=core;
const fail=(code,message)=>{throw new StoryAudioError(code,message);};
const validPart=value=>typeof value==='string'&&/^[0-9A-Za-z_-]{3,140}$/.test(value);
const MAX_SAMPLE_BYTES=2*1024*1024;

function samplePath({familyId,openid,profileId,requestId}) {
  if(!validPart(familyId)||!validPart(openid)||!core.validVoiceProfileId(profileId)||!core.validRequestId(requestId))fail('INVALID_INPUT','声音样本编号无效');
  return `voice-samples/${familyId}/${openid}/${profileId}/${requestId}.wav`;
}

function assertRegisteredSamplePath(fileID,expectedPath) {
  if(typeof fileID!=='string'||fileID.length>500||!fileID.startsWith('cloud://')||!fileID.endsWith('.'+expectedPath))fail('INVALID_SAMPLE_PATH','录音文件不属于这次声音授权');
  return fileID;
}

function validateInspectedSample(value) {
  const valid=value&&Number.isFinite(value.durationMs)&&value.durationMs>5000&&value.durationMs<15000
    &&Number.isInteger(value.bytes)&&value.bytes>0&&value.bytes<=MAX_SAMPLE_BYTES
    &&value.format==='wav'&&value.channels===1&&value.bitsPerSample===16
    &&[24000,48000].includes(value.sampleRate);
  if(!valid)fail('INVALID_VOICE_SAMPLE','录音需大于 5 秒、小于 15 秒，且为不超过 2MB 的单声道 16-bit WAV（24kHz 或 48kHz）');
  return value;
}

module.exports={MAX_SAMPLE_BYTES,samplePath,assertRegisteredSamplePath,validateInspectedSample};
