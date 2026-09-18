const {StoryAudioError}=require('./core');
const fail=(code,message)=>{throw new StoryAudioError(code,message);};
const clean=value=>typeof value==='string'&&value.trim()?value.trim():'';

function subtitles(value) {
  let rows=value;
  if(typeof rows==='string'){try{rows=JSON.parse(rows);}catch{fail('TTS_PROVIDER_INVALID_RESPONSE','腾讯云字幕格式无效');}}
  if(rows===undefined||rows===null)rows=[];
  if(!Array.isArray(rows))fail('TTS_PROVIDER_INVALID_RESPONSE','腾讯云字幕格式无效');
  // Tencent includes empty SIL phonemes for pauses. They are not text cues;
  // retain the provider's absolute times so those pauses remain in the audio.
  const normalized=[];
  for(const row of rows){
    if(row?.Phoneme==='SIL'&&!clean(row?.Text))continue;
    const cue={text:clean(row?.Text),beginMs:Number(row?.BeginTime),endMs:Number(row?.EndTime)};
    const previous=normalized[normalized.length-1];
    // Tencent can emit a zero-length PPP cue at the preceding word's end.
    // Keep the punctuation with that word, without inventing a speech interval.
    if(row?.Phoneme==='PPP'&&/^\p{P}+$/u.test(cue.text)&&cue.beginMs===cue.endMs&&previous?.endMs===cue.beginMs){
      previous.text+=cue.text;
    }else normalized.push(cue);
  }
  if(normalized.some((row,index)=>!row.text||!Number.isFinite(row.beginMs)||!Number.isFinite(row.endMs)||row.beginMs<0||row.endMs<=row.beginMs||(index>0&&row.beginMs<normalized[index-1].endMs)))fail('TTS_PROVIDER_INVALID_RESPONSE','腾讯云字幕时间无效');
  return normalized;
}

function createTencentTtsAdapter({client}) {
  if(!client)throw new Error('TENCENT_TTS_CLIENT_REQUIRED');
  async function synthesize({text,sessionId,voiceType,fastVoiceType,speed=0}) {
    if(typeof client.TextToVoice!=='function'||!clean(text)||Array.from(text).length>150||!clean(sessionId)||!Number.isFinite(speed)||speed<-2||speed>2)fail('INVALID_INPUT','朗读参数无效');
    const clone=clean(fastVoiceType);
    if(!clone&&(!Number.isInteger(voiceType)||voiceType<=0))fail('INVALID_INPUT','朗读音色无效');
    // TextToVoice officially supports 16 kHz/8 kHz. Requesting 24 kHz looks
    // harmless in mocks but is rejected by the real Tencent endpoint.
    const input={Text:text,SessionId:sessionId,VoiceType:clone?200000000:voiceType,...(clone?{FastVoiceType:clone}:{}),Codec:'wav',SampleRate:16000,Speed:speed,Volume:0,EnableSubtitle:true};
    const response=await client.TextToVoice(input),audioBase64=clean(response?.Audio);
    if(!audioBase64||!/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64))fail('TTS_PROVIDER_INVALID_RESPONSE','腾讯云没有返回有效音频');
    return {audioBase64,subtitles:subtitles(response?.Subtitles)};
  }
  return {synthesize};
}

module.exports={createTencentTtsAdapter};
