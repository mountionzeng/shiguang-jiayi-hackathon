const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../cloudfunctions/storyAudio/core');
const {capabilityConfigFromEnv}=require('../cloudfunctions/storyAudio/capabilities');
const {createStoryAudioHandlers} = require('../cloudfunctions/storyAudio/flow');
const {runtimeCapabilityConfig}=require('../cloudfunctions/storyAudio/cloudRuntime');

const familyId='family_owner', storyId='story-a', revisionId='revision-a', chapterId='chapter-a';
const revision={id:revisionId,storyId,draft:{title:'院子里的夏天',chapters:[{
  id:chapterId,title:'老院子',memoryIds:[],content:[
    {text:'第一句。'}, {photoId:'photo-one'}, {text:'第二句！\n第三段。'},
  ],
}]}};

function fixture() {
  const operations=new Map();
  const repo={
    async getStory(family,id){return family===familyId && id===storyId ? {id:storyId,familyId,currentRevisionId:revisionId,version:3} : undefined;},
    async getRevision(family,id){return family===familyId && id===revisionId ? structuredClone(revision) : undefined;},
    async getOperation(id){return operations.get(id);},
    async getVoiceProfile(family,id){return family===familyId&&id==='voice-mine'?{id,familyId,ownerOpenid:'owner',status:'ready',generation:7,providerVoiceId:'fast-private'}:undefined;},
    async createOperation(id,value){if(operations.has(id))return false;operations.set(id,structuredClone(value));return true;},
  };
  const handlers=createStoryAudioHandlers({repo,capabilityConfig:{submissionEnabled:true,ttsEnabled:true,pricingVersion:'audio-cny-v1',officialVoiceIds:['voice-one']}});
  return {handlers,operations};
}

test('chapter snapshot fixes exact text, image order and source version',()=>{
  const snapshot=core.chapterSnapshot({familyId,story:{id:storyId},revision,chapterId});
  assert.equal(snapshot.title,'老院子');
  assert.equal(snapshot.text,'第一句。第二句！\n第三段。');
  assert.deepEqual(snapshot.blocks,[{kind:'text',text:'第一句。'},{kind:'image',imageId:'photo-one'},{kind:'text',text:'第二句！\n第三段。'}]);
  assert.equal(snapshot.revisionId,revisionId);
  assert.match(snapshot.digest,/^[a-z0-9]+$/);
});

test('source-bound stories and unknown provenance cannot be flattened into narration',()=>{
  for(const mode of ['story','protocol','block','derived']){
    const story={id:storyId},protectedRevision=structuredClone(revision);
    if(mode==='story')story.sourcePolicyRequired=true;
    if(mode==='protocol')protectedRevision.draft.provenanceVersion=99;
    if(mode==='block')protectedRevision.draft.chapters[0].content[0].sourceIds=[];
    if(mode==='derived')protectedRevision.draft.content=[{text:'旧派生文字',blockId:'block-source'}];
    assert.throws(()=>core.chapterSnapshot({familyId,story,revision:protectedRevision,chapterId}),{code:'STORY_PROTOCOL_REQUIRED'});
  }
});

test('audio operation is idempotent and rejects reused request with different settings',async()=>{
  const {handlers,operations}=fixture();
  const ctx={familyId,openid:'owner'};
  const input={requestId:'audio-request-1',storyId,revisionId,chapterId,voice:{kind:'official',id:'voice-one'},background:{id:'quiet-room',volume:0.12}};
  const first=await handlers.create(ctx,input);
  const second=await handlers.create(ctx,input);
  assert.equal(first.operation.id,second.operation.id);
  assert.equal(operations.size,1);
  await assert.rejects(handlers.create(ctx,{...input,background:{id:'quiet-room',volume:0.4}}),/请求编号/);
});

test('server rejects a stale or foreign revision before queueing paid work',async()=>{
  const {handlers,operations}=fixture();
  const ctx={familyId,openid:'owner'};
  await assert.rejects(handlers.create(ctx,{requestId:'audio-request-2',storyId,revisionId:'revision-other',chapterId,voice:{kind:'official',id:'voice-one'}}),/版本/);
  await assert.rejects(handlers.create({familyId:'family_other',openid:'other'},{requestId:'audio-request-3',storyId,revisionId,chapterId,voice:{kind:'official',id:'voice-one'}}),/故事/);
  assert.equal(operations.size,0);
});

test('official voices must come from the server allowlist',async()=>{
  const {handlers,operations}=fixture();
  await assert.rejects(handlers.create({familyId,openid:'owner'},{requestId:'audio-request-4',storyId,revisionId,chapterId,voice:{kind:'official',id:'provider-id-guessed-by-client'}}),error=>error.code==='VOICE_NOT_FOUND');
  assert.equal(operations.size,0);
});

test('clone voice provider identity and generation are snapshotted only on the private operation',async()=>{
  const {handlers,operations}=fixture();
  const cloneHandlers=createStoryAudioHandlers({repo:{
    async getStory(){return {id:storyId,familyId,currentRevisionId:revisionId};},
    async getRevision(){return structuredClone(revision);},
    async getVoiceProfile(){return {id:'voice-mine',familyId,ownerOpenid:'owner',status:'ready',generation:7,providerVoiceId:'fast-private'};},
    async getOperation(id){return operations.get(id);},
    async createOperation(id,value){operations.set(id,structuredClone(value));return true;},
  },capabilityConfig:{submissionEnabled:true,ttsEnabled:true,voiceCloneEnabled:true,pricingVersion:'audio-cny-v1'}});
  const result=await cloneHandlers.create({familyId,openid:'owner'},{requestId:'audio-request-clone',storyId,revisionId,chapterId,voice:{kind:'clone',id:'voice-mine'}});
  const stored=operations.get(result.operation.id);
  assert.equal(stored.kind,'narration');
  assert.equal(stored.generation,1);
  assert.deepEqual(stored.voice,{kind:'clone',id:'voice-mine',generation:7,fastVoiceType:'fast-private'});
  assert.deepEqual(result.operation.voice,{kind:'clone'});
});

test('capabilities fail closed without verified pricing and never expose secrets',()=>{
  assert.deepEqual(core.publicCapabilities({ttsEnabled:true,tencentSecretId:'secret'}),{
    apiVersion:1,provider:'tencent-cloud',voiceClone:{enabled:false,reason:'not_verified'},voiceEnrollment:{enabled:false,reason:'not_verified'},tts:{enabled:false,reason:'pricing_not_configured'},timestamps:{enabled:false,reason:'not_verified'},mixing:{enabled:false,reason:'not_verified'},video:{enabled:false,reason:'not_verified'},submission:{enabled:false,reason:'implementation_not_ready'},pricingVersion:null,
  });
});

test('paid submission stays closed even when TTS pricing is configured',async()=>{
  const repo={async getOperation(){return undefined;},async createOperation(){throw new Error('must not queue');}};
  const handlers=createStoryAudioHandlers({repo,capabilityConfig:{ttsEnabled:true,pricingVersion:'audio-cny-v1',officialVoiceIds:['voice-one']}});
  await assert.rejects(handlers.create({familyId,openid:'owner'},{requestId:'audio-request-5',storyId,revisionId,chapterId,voice:{kind:'official',id:'voice-one'}}),error=>error.code==='AUDIO_NOT_READY');
});

test('voice enrollment stays closed until the durable worker is explicitly ready',()=>{
  assert.equal(capabilityConfigFromEnv({STORY_AUDIO_VOICE_ENROLLMENT_ENABLED:'true'}).voiceEnrollmentEnabled,false);
  assert.equal(capabilityConfigFromEnv({STORY_AUDIO_VOICE_ENROLLMENT_ENABLED:'true',STORY_AUDIO_VOICE_WORKER_ENABLED:'true'}).voiceEnrollmentEnabled,true);
});

test('official TTS opens automatically only inside a credentialed Tencent runtime',()=>{
  assert.equal(runtimeCapabilityConfig({}).submissionEnabled,false);
  const config=runtimeCapabilityConfig({TENCENTCLOUD_SECRETID:'temporary-id',TENCENTCLOUD_SECRETKEY:'temporary-key',TENCENTCLOUD_SESSIONTOKEN:'temporary-token'});
  assert.equal(config.ttsEnabled,true);assert.equal(config.submissionEnabled,true);assert.equal(config.timestampsEnabled,true);
  assert.deepEqual(config.officialVoices.map(item=>item.id),['101001','101002']);
  assert.equal(JSON.stringify(config).includes('temporary-'),false);
  assert.equal(runtimeCapabilityConfig({TENCENTCLOUD_SECRETID:'temporary-id',TENCENTCLOUD_SECRETKEY:'temporary-key',STORY_AUDIO_TTS_ENABLED:'false'}).submissionEnabled,false);
});
