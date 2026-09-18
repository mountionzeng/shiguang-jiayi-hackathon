const {StoryAudioError}=require('./core');
const fail=(code,message)=>{throw new StoryAudioError(code,message);};
const text=value=>typeof value==='string'&&value.trim()?value.trim():'';

function createTencentVoiceAdapter({client}) {
  if(!client)throw new Error('TENCENT_VOICE_CLIENT_REQUIRED');
  async function trainingText() {
    if(typeof client.GetTrainingText!=='function')fail('VOICE_PROVIDER_NOT_CONFIGURED','腾讯云声音复刻客户端尚未配置');
    const response=await client.GetTrainingText({TaskType:5,Domain:2,TextLanguage:1});
    const item=response?.Data?.TrainingTextList?.find(entry=>text(entry?.TextId)&&text(entry?.Text));
    if(!item)fail('VOICE_PROVIDER_INVALID_RESPONSE','腾讯云没有返回可用的阅读训练文字');
    return {textId:text(item.TextId),text:text(item.Text)};
  }
  async function detect({textId,audioBase64,sampleRate}) {
    if(typeof client.DetectEnvAndSoundQuality!=='function'||!text(textId)||!text(audioBase64)||![24000,48000].includes(sampleRate))fail('INVALID_INPUT','声音检测参数无效');
    const response=await client.DetectEnvAndSoundQuality({TextId:textId,AudioData:audioBase64,TypeId:2,Codec:'wav',SampleRate:sampleRate,TaskType:5});
    const data=response?.Data;
    if(data?.DetectionCode!==0||!text(data?.AudioId))fail('VOICE_SAMPLE_REJECTED',text(data?.DetectionMsg)||'声音样本没有通过腾讯云质量检测，请重新录制');
    return {audioId:text(data.AudioId)};
  }
  async function create({sessionId,name,gender,audioId,sampleRate}) {
    if(typeof client.CreateVRSTask!=='function'||!text(sessionId)||!text(name)||![1,2].includes(gender)||!text(audioId)||![24000,48000].includes(sampleRate))fail('INVALID_INPUT','声音复刻任务参数无效');
    const response=await client.CreateVRSTask({SessionId:sessionId,VoiceName:name,VoiceGender:gender,VoiceLanguage:1,AudioIdList:[audioId],SampleRate:sampleRate,Codec:'wav',TaskType:5,EnableVoiceEnhance:0});
    const taskId=text(response?.Data?.TaskId);
    if(!taskId)fail('VOICE_PROVIDER_INVALID_RESPONSE','腾讯云没有返回声音复刻任务编号');
    return {taskId};
  }
  async function status(taskId) {
    if(typeof client.DescribeVRSTaskStatus!=='function'||!text(taskId))fail('INVALID_INPUT','声音复刻任务编号无效');
    const data=(await client.DescribeVRSTaskStatus({TaskId:taskId}))?.Data;
    if(!data||text(data.TaskId)!==taskId||![0,1,2,3].includes(data.Status))fail('VOICE_PROVIDER_INVALID_RESPONSE','腾讯云返回了无法识别的声音任务状态');
    if(data.Status===0||data.Status===1)return {status:'processing',taskId};
    if(data.Status===3)return {status:'failed',taskId,error:{code:'VOICE_TRAINING_FAILED',message:text(data.ErrorMsg)||'声音复刻没有成功，请重新录制'}};
    const fastVoiceType=text(data.FastVoiceType),expiresAt=text(data.ExpireTime);
    if(!fastVoiceType||!expiresAt)fail('VOICE_PROVIDER_INVALID_RESPONSE','腾讯云声音任务完成但缺少音色或有效期');
    return {status:'ready',taskId,fastVoiceType,expiresAt};
  }
  return {trainingText,detect,create,status};
}

module.exports={createTencentVoiceAdapter};
