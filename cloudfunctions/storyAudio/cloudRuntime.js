const {capabilityConfigFromEnv}=require('./capabilities');
const {createNarrationJobProcessor}=require('./narrationJobs');
const {createNarrationPublisher}=require('./narrationPublisher');
const {createNarrationWorkerRepository}=require('./narrationRepository');
const {createTencentTtsAdapter}=require('./tencentTts');
const {inspectWav}=require('./wav');
const {createTencentVoiceAdapter}=require('./tencentVoice');
const {createVoiceJobProcessor}=require('./voiceJobs');
const {createVoiceWorkerRepository}=require('./voiceRepository');
const {inspectWav:inspectVoiceWav}=require('./inspectWav');

const DEFAULT_VOICES=[{id:'101001',label:'温柔女声'},{id:'101002',label:'清晰女声'}];
const clean=value=>typeof value==='string'&&value.trim()?value.trim():'';
const credentialsFromEnv=env=>{
  const dedicated={
    secretId:clean(env.STORY_AUDIO_TENCENT_SECRET_ID),
    secretKey:clean(env.STORY_AUDIO_TENCENT_SECRET_KEY),
    token:clean(env.STORY_AUDIO_TENCENT_SESSION_TOKEN),
  };
  if(dedicated.secretId&&dedicated.secretKey)return dedicated;
  return {
    secretId:clean(env.TENCENTCLOUD_SECRET_ID)||clean(env.TENCENTCLOUD_SECRETID),
    secretKey:clean(env.TENCENTCLOUD_SECRET_KEY)||clean(env.TENCENTCLOUD_SECRETKEY),
    token:clean(env.TENCENTCLOUD_SESSION_TOKEN)||clean(env.TENCENTCLOUD_SESSIONTOKEN),
  };
};
const tencentRegionFromEnv=env=>clean(env.STORY_AUDIO_TENCENT_REGION)||clean(env.TENCENTCLOUD_REGION)||'ap-guangzhou';

function runtimeCapabilityConfig(env=process.env) {
  const credentials=credentialsFromEnv(env),credentialReady=Boolean(credentials.secretId&&credentials.secretKey);
  const defaults=credentialReady?{
    STORY_AUDIO_PRICING_VERSION:'tencent-tts-standard-v1',
    STORY_AUDIO_TTS_ENABLED:'true',STORY_AUDIO_TIMESTAMPS_ENABLED:'true',STORY_AUDIO_SUBMISSION_ENABLED:'true',
    STORY_AUDIO_OFFICIAL_VOICES:JSON.stringify(DEFAULT_VOICES),STORY_AUDIO_OFFICIAL_VOICE_IDS:DEFAULT_VOICES.map(item=>item.id).join(','),
  }:{};
  const config=capabilityConfigFromEnv({...defaults,...env});
  if(!credentialReady)return {...config,ttsEnabled:false,timestampsEnabled:false,submissionEnabled:false,officialVoices:[],officialVoiceIds:[],pricingVersion:null};
  if(!config.ttsEnabled)return {...config,timestampsEnabled:false,submissionEnabled:false};
  return config;
}

function createTencentClient(env=process.env) {
  const credential=credentialsFromEnv(env);
  if(!credential.secretId||!credential.secretKey)throw new Error('TENCENT_RUNTIME_CREDENTIALS_UNAVAILABLE');
  const {Client}=require('tencentcloud-sdk-nodejs-tts').tts.v20190823;
  const client=new Client({credential,region:tencentRegionFromEnv(env),profile:{httpProfile:{endpoint:'tts.tencentcloudapi.com',reqTimeout:15}}});
  const call=name=>async input=>{
    try{return await client[name](input);}
    catch(error){
      if(name==='TextToVoice'&&(error?.requestId||/^(AuthFailure|UnauthorizedOperation|FailedOperation|InvalidParameter|UnsupportedOperation|LimitExceeded|RequestLimitExceeded)/.test(String(error?.code||''))))error.definitelyNotSubmitted=true;
      throw error;
    }
  };
  return {
    TextToVoice:call('TextToVoice'),GetTrainingText:call('GetTrainingText'),
    DetectEnvAndSoundQuality:call('DetectEnvAndSoundQuality'),CreateVRSTask:call('CreateVRSTask'),
    DescribeVRSTaskStatus:call('DescribeVRSTaskStatus'),
  };
}

function createCloudStorage(cloud) {
  const invocationCache=new Map();
  const loadFile=async fileID=>{
    const cached=invocationCache.get(fileID);
    if(cached)return cached;
    if(typeof fileID!=='string'||!fileID.startsWith('cloud://')||typeof cloud.downloadFile!=='function')throw new Error('not found');
    const result=await cloud.downloadFile({fileID}),buffer=Buffer.from(result.fileContent||[]);
    if(!buffer.length)throw new Error('not found');
    const item={buffer,fileID};invocationCache.set(fileID,item);return item;
  };
  return {
    async write(path,value,{contentType}={}){
      const buffer=Buffer.from(value),result=await cloud.uploadFile({cloudPath:path,fileContent:buffer});
      invocationCache.set(path,{buffer,fileID:result.fileID});
      return {fileID:result.fileID,bytes:buffer.length,contentType};
    },
    async read(path,{maxBytes=Infinity}={}){const item=invocationCache.get(path)||await loadFile(path);if(item.buffer.length>maxBytes)throw new Error('FILE_TOO_LARGE');return item.buffer;},
    async stat(path){const item=invocationCache.get(path)||await loadFile(path);return {bytes:item.buffer.length,fileID:item.fileID};},
    async readFile(fileID,{maxBytes=Infinity}={}){const item=await loadFile(fileID);if(item.buffer.length>maxBytes)throw new Error('FILE_TOO_LARGE');return item.buffer;},
    async remove(fileID){if(typeof cloud.deleteFile!=='function')throw new Error('VOICE_STORAGE_DELETE_UNAVAILABLE');await cloud.deleteFile({fileList:[fileID]});invocationCache.delete(fileID);},
  };
}

function createCloudAudioRuntime({cloud,db,env=process.env,client}={}) {
  const capabilityConfig=runtimeCapabilityConfig(env),storage=createCloudStorage(cloud);
  const runtimeClient=(capabilityConfig.ttsEnabled||capabilityConfig.voiceEnrollmentEnabled)?(client||createTencentClient(env)):undefined;
  const narrationRepo=capabilityConfig.ttsEnabled?createNarrationWorkerRepository({db,command:db.command}):undefined;
  const narrationProcessor=narrationRepo?createNarrationJobProcessor({
    repo:narrationRepo,provider:createTencentTtsAdapter({client:runtimeClient}),storage,
    publisher:createNarrationPublisher({storage}),inspectWav,
  }):undefined;
  const voiceRepo=capabilityConfig.voiceEnrollmentEnabled?createVoiceWorkerRepository({db,command:db.command}):undefined;
  const voiceProcessor=voiceRepo?createVoiceJobProcessor({
    repo:voiceRepo,provider:createTencentVoiceAdapter({client:runtimeClient}),storage,inspectWav:inspectVoiceWav,
  }):undefined;
  async function processOperation(operation){
    if(!narrationProcessor||!operation||!['queued','processing'].includes(operation.status))return operation;
    await narrationProcessor.process({operationId:operation.id,generation:operation.generation});
    return narrationRepo.getOperation(operation.id);
  }
  async function processVoiceProfile(profile){
    if(!voiceProcessor||!profile)return profile;
    const job={familyId:profile.familyId,profileId:profile.id,generation:profile.generation};
    if(['deleting','deletion_pending_provider','deletion_pending_sample'].includes(profile.status))return voiceProcessor.cleanup(job);
    return voiceProcessor.process(job);
  }
  async function sweep(){
    if(voiceRepo){
      const [profile]=await voiceRepo.listRunnableVoiceProfiles({limit:1});
      if(profile){const result=await processVoiceProfile(profile);return {processed:true,kind:'voice',id:profile.id,status:result?.status};}
    }
    if(narrationRepo){
      const [operation]=await narrationRepo.listRunnableNarrations({limit:1});
      if(operation){const result=await processOperation(operation);return {processed:true,kind:'narration',id:operation.id,status:result?.status};}
    }
    return {processed:false};
  }
  return {capabilityConfig,processOperation,processVoiceProfile,sweep};
}

module.exports={DEFAULT_VOICES,credentialsFromEnv,tencentRegionFromEnv,runtimeCapabilityConfig,createCloudStorage,createCloudAudioRuntime};
