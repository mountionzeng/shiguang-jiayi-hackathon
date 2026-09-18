const test=require('node:test');
const assert=require('node:assert/strict');
const {StoryAudioError}=require('../cloudfunctions/storyAudio/core');
const sample=require('../cloudfunctions/storyAudio/sampleAccess');
const {createVoiceProfileHandlers}=require('../cloudfunctions/storyAudio/voiceProfiles');
const {createTencentVoiceAdapter}=require('../cloudfunctions/storyAudio/tencentVoice');
const {createVoiceJobProcessor}=require('../services/story-media-worker/voiceJobs');
const {inspectWav}=require('../services/story-media-worker/inspectWav');

test('inspected sample must satisfy strict Tencent clone boundaries',()=>{
  const valid={durationMs:6000,bytes:1_000_000,format:'wav',channels:1,bitsPerSample:16,sampleRate:24000};
  assert.deepEqual(sample.validateInspectedSample(valid),valid);
  for(const invalid of [
    {...valid,durationMs:5000},{...valid,durationMs:15000},{...valid,bytes:2*1024*1024+1},
    {...valid,format:'mp3'},{...valid,channels:2},{...valid,bitsPerSample:24},{...valid,sampleRate:16000},
  ])assert.throws(()=>sample.validateInspectedSample(invalid),error=>error instanceof StoryAudioError&&error.code==='INVALID_VOICE_SAMPLE');
});

test('WAV inspection derives duration and format from the actual bytes',()=>{
  const sampleRate=24000,seconds=6,dataBytes=sampleRate*2*seconds,buffer=Buffer.alloc(44+dataBytes);
  buffer.write('RIFF',0);buffer.writeUInt32LE(36+dataBytes,4);buffer.write('WAVE',8);buffer.write('fmt ',12);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(sampleRate,24);buffer.writeUInt32LE(sampleRate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(dataBytes,40);
  assert.deepEqual(inspectWav(buffer),{durationMs:6000,bytes:buffer.length,format:'wav',channels:1,bitsPerSample:16,sampleRate:24000});
  assert.throws(()=>inspectWav(Buffer.from('not a wave')),/WAV/);
  const inconsistent=Buffer.from(buffer);
  inconsistent.writeUInt32LE(sampleRate,28);
  assert.throws(()=>inspectWav(inconsistent),/WAV/);
  const unaligned=Buffer.from(buffer);
  unaligned.writeUInt32LE(dataBytes-1,40);
  assert.throws(()=>inspectWav(unaligned),/WAV/);
});

test('sample path is bound to server identity and one profile',()=>{
  const path=sample.samplePath({familyId:'family_owner',openid:'openid-A',profileId:'voice-profile-a',requestId:'audio-sample-a'});
  assert.equal(path,'voice-samples/family_owner/openid-A/voice-profile-a/audio-sample-a.wav');
  assert.doesNotThrow(()=>sample.assertRegisteredSamplePath('cloud://env.'+path,path));
  assert.throws(()=>sample.assertRegisteredSamplePath('cloud://env.voice-samples/family_other/openid-A/voice-profile-a/audio-sample-a.wav',path),/录音文件/);
});

function fixture(){
  const profiles=new Map();
  const repo={
    async getVoiceProfile(_family,id){return profiles.get(id);},
    async createVoiceProfile(_family,id,value){if(profiles.has(id))return false;profiles.set(id,structuredClone(value));return true;},
    async updateVoiceProfile(_family,id,expected,patch){const current=profiles.get(id);if(!current||Object.entries(expected).some(([key,value])=>current[key]!==value))return false;profiles.set(id,{...current,...structuredClone(patch)});return true;},
  };
  const handlers=createVoiceProfileHandlers({repo,capabilityConfig:{voiceEnrollmentEnabled:true,pricingVersion:'voice-v1'},now:()=> '2026-09-18T10:00:00.000Z'});
  return {handlers,profiles};
}

test('consent creates one private sample slot and registration never trusts a foreign path',async()=>{
  const {handlers,profiles}=fixture(),ctx={familyId:'family_owner',openid:'openid-A'};
  const prepared=await handlers.prepare(ctx,{requestId:'audio-consent-a',profileId:'voice-profile-a',consentVersion:'voice-clone-v1',voiceGender:1});
  assert.equal(prepared.profile.status,'preparing_text');
  assert.equal(prepared.upload.cloudPath,'voice-samples/family_owner/openid-A/voice-profile-a/audio-consent-a.wav');
  profiles.set('voice-profile-a',{...profiles.get('voice-profile-a'),status:'awaiting_sample',trainingText:{textId:'text-private',text:'请朗读训练文字',expiresAt:'2026-09-25T10:00:00.000Z'}});
  await assert.rejects(handlers.registerSample(ctx,{profileId:'voice-profile-a',fileID:'cloud://env.voice-samples/family_other/openid-A/voice-profile-a/audio-consent-a.wav'}),error=>error.code==='INVALID_SAMPLE_PATH');
  const registered=await handlers.registerSample(ctx,{profileId:'voice-profile-a',fileID:'cloud://env.'+prepared.upload.cloudPath});
  assert.equal(registered.profile.status,'sample_registered');
  assert.equal(registered.profile.sampleRegistered,true);
  assert.equal(profiles.get('voice-profile-a').sample.declaredByOpenid,'openid-A');
  assert.equal(registered.profile.sample,undefined);
});

test('disable increments generation so an in-flight result cannot revive the voice',async()=>{
  const {handlers,profiles}=fixture(),ctx={familyId:'family_owner',openid:'openid-A'};
  await handlers.prepare(ctx,{requestId:'audio-consent-b',profileId:'voice-profile-b',consentVersion:'voice-clone-v1',voiceGender:2});
  const disabled=await handlers.disable(ctx,{profileId:'voice-profile-b'});
  assert.equal(disabled.profile.status,'disabled');
  assert.equal(profiles.get('voice-profile-b').generation,2);
  assert.equal(profiles.get('voice-profile-b').providerVoiceId,undefined);
});

test('voice gender is explicit and immutable for one consent request',async()=>{
  const {handlers}=fixture(),ctx={familyId:'family_owner',openid:'openid-A'};
  await assert.rejects(handlers.prepare(ctx,{requestId:'audio-gender-a',profileId:'voice-gender-a',consentVersion:'voice-clone-v1'}),error=>error.code==='INVALID_INPUT');
  await handlers.prepare(ctx,{requestId:'audio-gender-a',profileId:'voice-gender-a',consentVersion:'voice-clone-v1',voiceGender:1});
  await assert.rejects(handlers.prepare(ctx,{requestId:'audio-gender-a',profileId:'voice-gender-a',consentVersion:'voice-clone-v1',voiceGender:2}),error=>error.code==='REQUEST_CONFLICT');
});

test('delete reports sample and provider cleanup separately instead of pretending success',async()=>{
  const {handlers,profiles}=fixture(),ctx={familyId:'family_owner',openid:'openid-A'};
  const prepared=await handlers.prepare(ctx,{requestId:'audio-consent-delete',profileId:'voice-profile-delete',consentVersion:'voice-clone-v1',voiceGender:1});
  profiles.set('voice-profile-delete',{...profiles.get('voice-profile-delete'),status:'awaiting_sample',trainingText:{textId:'text-private',text:'请朗读训练文字',expiresAt:'2026-09-25T10:00:00.000Z'}});
  await handlers.registerSample(ctx,{profileId:'voice-profile-delete',fileID:'cloud://env.'+prepared.upload.cloudPath});
  profiles.set('voice-profile-delete',{...profiles.get('voice-profile-delete'),status:'ready',providerVoiceId:'provider-private'});
  const result=await handlers.requestDelete(ctx,{profileId:'voice-profile-delete'});
  assert.equal(result.profile.status,'deleting');
  assert.equal(result.profile.sampleDeletionStatus,'pending');
  assert.equal(result.profile.providerDeletionStatus,'manual_review');
  assert.equal(result.profile.generation,2);
});

test('another account cannot read, register or disable a voice profile',async()=>{
  const {handlers}=fixture(),owner={familyId:'family_owner',openid:'openid-A'};
  await handlers.prepare(owner,{requestId:'audio-consent-c',profileId:'voice-profile-c',consentVersion:'voice-clone-v1',voiceGender:1});
  const foreign={familyId:'family_other',openid:'openid-B'};
  await assert.rejects(handlers.status(foreign,{profileId:'voice-profile-c'}),error=>error.code==='VOICE_NOT_FOUND');
  await assert.rejects(handlers.disable(foreign,{profileId:'voice-profile-c'}),error=>error.code==='VOICE_NOT_FOUND');
});

test('Tencent adapter uses one-sentence reading parameters and hides raw responses',async()=>{
  const calls=[];
  const client={
    async GetTrainingText(input){calls.push(['text',input]);return {Data:{TrainingTextList:[{TextId:'text-private',Text:'请朗读这一段。'}]},RequestId:'request-private'};},
    async DetectEnvAndSoundQuality(input){calls.push(['detect',input]);return {Data:{DetectionCode:0,AudioId:'audio-private',DetectionMsg:'通过'},RequestId:'request-detect'};},
    async CreateVRSTask(input){calls.push(['create',input]);return {Data:{TaskId:'task-private'},RequestId:'request-create'};},
    async DescribeVRSTaskStatus(input){calls.push(['status',input]);return {Data:{TaskId:'task-private',Status:2,StatusStr:'success',VoiceType:200000000,FastVoiceType:'fast-private',ExpireTime:'2027-01-01T00:00:00Z'}};},
  };
  const adapter=createTencentVoiceAdapter({client});
  assert.deepEqual(await adapter.trainingText(),{textId:'text-private',text:'请朗读这一段。'});
  assert.deepEqual(await adapter.detect({textId:'text-private',audioBase64:'YWJj',sampleRate:24000}),{audioId:'audio-private'});
  assert.deepEqual(await adapter.create({sessionId:'voice-session-a',name:'我的声音',gender:2,audioId:'audio-private',sampleRate:24000}),{taskId:'task-private'});
  assert.deepEqual(await adapter.status('task-private'),{status:'ready',taskId:'task-private',fastVoiceType:'fast-private',expiresAt:'2027-01-01T00:00:00Z'});
  assert.deepEqual(calls[0][1],{TaskType:5,Domain:2,TextLanguage:1});
  assert.equal(calls[1][1].AudioData,'YWJj');
  assert.deepEqual(calls[2][1].AudioIdList,['audio-private']);
  assert.equal(JSON.stringify(await adapter.status('task-private')).includes('request-private'),false);
});

test('Tencent quality rejection and incomplete success fail closed',async()=>{
  const rejected=createTencentVoiceAdapter({client:{async DetectEnvAndSoundQuality(){return {Data:{DetectionCode:-3,DetectionMsg:'噪声较大'}};}}});
  await assert.rejects(rejected.detect({textId:'text-a',audioBase64:'YWJj',sampleRate:24000}),error=>error.code==='VOICE_SAMPLE_REJECTED');
  const incomplete=createTencentVoiceAdapter({client:{async DescribeVRSTaskStatus(){return {Data:{TaskId:'task-a',Status:2,StatusStr:'success'}};}}});
  await assert.rejects(incomplete.status('task-a'),error=>error.code==='VOICE_PROVIDER_INVALID_RESPONSE');
});

function voiceJobFixture({createFails=false,status='sample_registered',now='2026-09-18T11:00:00.000Z'}={}){
  let profile={id:'voice-profile-job',familyId:'family_owner',ownerOpenid:'owner',status,generation:1,voiceGender:1,sample:{fileID:'cloud://private-sample'},trainingText:{textId:'text-private',text:'请朗读训练文字',fetchedAt:'2026-09-18T10:00:00.000Z',expiresAt:'2026-09-25T10:00:00.000Z'}};
  let createCalls=0;
  const repo={
    async getVoiceProfile(){return structuredClone(profile);},
    async updateVoiceProfile(_family,_id,expected,patch){if(Object.entries(expected).some(([key,value])=>profile[key]!==value))return false;profile={...profile,...structuredClone(patch)};return true;},
  };
  const provider={
    async trainingText(){return {textId:'text-private',text:'请朗读训练文字'};},
    async detect(){return {audioId:'audio-private'};},
    async create(input){createCalls++;assert.equal(input.gender,1);if(createFails)throw new Error('connection lost');return {taskId:'task-private'};},
    async status(){return {status:'ready',taskId:'task-private',fastVoiceType:'voice-private',expiresAt:'2027-01-01T00:00:00Z'};},
  };
  const processor=createVoiceJobProcessor({repo,provider,storage:{async stat(){return {bytes:3};},async read(_fileID,options){assert.equal(options.maxBytes,2*1024*1024+1);return Buffer.from('wav');}},inspectWav:()=>({durationMs:6000,bytes:3,format:'wav',channels:1,bitsPerSample:16,sampleRate:24000}),now:()=>now});
  return {processor,profile:()=>profile,createCalls:()=>createCalls};
}

test('voice worker checkpoints every external step and accepts only matching generation',async()=>{
  const item={familyId:'family_owner',profileId:'voice-profile-job',generation:1};
  const fixture=voiceJobFixture();
  assert.equal((await fixture.processor.process(item)).status,'detected');
  assert.equal((await fixture.processor.process(item)).status,'training');
  assert.equal(fixture.createCalls(),1);
  assert.equal((await fixture.processor.process(item)).status,'ready');
  assert.equal(fixture.profile().providerVoiceId,'voice-private');
});

test('voice worker obtains provider reading text before any sample is recorded',async()=>{
  const fixture=voiceJobFixture({status:'preparing_text'});
  const result=await fixture.processor.process({familyId:'family_owner',profileId:'voice-profile-job',generation:1});
  assert.equal(result.status,'awaiting_sample');
  assert.equal(result.trainingText.text,'请朗读训练文字');
  assert.equal(result.trainingText.fetchedAt,'2026-09-18T11:00:00.000Z');
  assert.equal(result.trainingText.expiresAt,'2026-09-25T11:00:00.000Z');
});

test('voice worker claims provider stages and rejects oversized storage before reading',async()=>{
  let profile={id:'voice-size',familyId:'family_owner',status:'sample_registered',generation:1,voiceGender:1,sample:{fileID:'cloud://large'},trainingText:{textId:'text',expiresAt:'2026-09-25T00:00:00.000Z'}},reads=0;
  const repo={async getVoiceProfile(){return structuredClone(profile);},async updateVoiceProfile(_family,_id,expected,patch){if(Object.entries(expected).some(([key,value])=>profile[key]!==value))return false;profile={...profile,...patch};return true;}};
  const processor=createVoiceJobProcessor({repo,provider:{},storage:{async stat(){return {bytes:2*1024*1024+1};},async read(){reads++;}},inspectWav:()=>({}),now:()=> '2026-09-18T11:00:00.000Z'});
  const result=await processor.process({familyId:'family_owner',profileId:'voice-size',generation:1});
  assert.equal(result.status,'failed');
  assert.equal(reads,0);
});

test('concurrent voice jobs call the training text provider only once',async()=>{
  let profile={id:'voice-concurrent',familyId:'family_owner',status:'preparing_text',generation:1},calls=0;
  const repo={async getVoiceProfile(){return structuredClone(profile);},async updateVoiceProfile(_family,_id,expected,patch){if(Object.entries(expected).some(([key,value])=>profile[key]!==value))return false;profile={...profile,...patch};return true;}};
  const provider={async trainingText(){calls++;await new Promise(resolve=>setTimeout(resolve,5));return {textId:'text',text:'训练文字'};}};
  const processor=createVoiceJobProcessor({repo,provider,storage:{},inspectWav:()=>({}),now:()=> '2026-09-18T11:00:00.000Z'});
  await Promise.all([processor.process({familyId:'family_owner',profileId:'voice-concurrent',generation:1}),processor.process({familyId:'family_owner',profileId:'voice-concurrent',generation:1})]);
  assert.equal(calls,1);
  assert.equal(profile.status,'awaiting_sample');
});

test('expired training text rejects registration and never reaches Tencent detection',async()=>{
  const {handlers,profiles}=fixture(),ctx={familyId:'family_owner',openid:'openid-A'};
  const prepared=await handlers.prepare(ctx,{requestId:'audio-expired-a',profileId:'voice-expired-a',consentVersion:'voice-clone-v1',voiceGender:1});
  profiles.set('voice-expired-a',{...profiles.get('voice-expired-a'),status:'awaiting_sample',trainingText:{textId:'text-private',text:'旧训练文字',expiresAt:'2026-09-18T09:59:59.000Z'}});
  await assert.rejects(handlers.registerSample(ctx,{profileId:'voice-expired-a',fileID:'cloud://env.'+prepared.upload.cloudPath}),error=>error.code==='VOICE_TRAINING_TEXT_EXPIRED');
  const job=voiceJobFixture({now:'2026-09-26T11:00:00.000Z'});
  assert.equal((await job.processor.process({familyId:'family_owner',profileId:'voice-profile-job',generation:1})).status,'failed');
  assert.equal(job.createCalls(),0);
});

test('prepare refreshes expired text before allowing another recording',async()=>{
  const {handlers,profiles}=fixture(),ctx={familyId:'family_owner',openid:'openid-A'};
  const input={requestId:'audio-refresh-a',profileId:'voice-refresh-a',consentVersion:'voice-clone-v1',voiceGender:1};
  await handlers.prepare(ctx,input);
  profiles.set('voice-refresh-a',{...profiles.get('voice-refresh-a'),status:'awaiting_sample',trainingText:{textId:'old-text',text:'旧文字',expiresAt:'2026-09-18T09:59:59.000Z'}});
  const refreshed=await handlers.prepare(ctx,input);
  assert.equal(refreshed.profile.status,'preparing_text');
  assert.equal(refreshed.profile.readingText,undefined);
  assert.equal(profiles.get('voice-refresh-a').trainingText,null);
});

test('lost create response becomes unknown and is never automatically submitted again',async()=>{
  const item={familyId:'family_owner',profileId:'voice-profile-job',generation:1};
  const fixture=voiceJobFixture({createFails:true});
  await fixture.processor.process(item);
  assert.equal((await fixture.processor.process(item)).status,'unknown');
  assert.equal((await fixture.processor.process(item)).status,'unknown');
  assert.equal(fixture.createCalls(),1);
});

test('sample cleanup deletes only the registered file and preserves provider manual review',async()=>{
  let removed=[];
  let profile={id:'voice-profile-clean',familyId:'family_owner',status:'deleting',generation:2,sample:{fileID:'cloud://private-sample'},sampleDeletionStatus:'pending',providerDeletionStatus:'manual_review'};
  const repo={async getVoiceProfile(){return profile;},async updateVoiceProfile(_family,_id,expected,patch){if(Object.entries(expected).some(([key,value])=>profile[key]!==value))return false;profile={...profile,...patch};return true;}};
  const processor=createVoiceJobProcessor({repo,provider:{},storage:{async remove(fileID){removed.push(fileID);}},inspectWav:()=>({}),now:()=> 'now'});
  const result=await processor.cleanup({familyId:'family_owner',profileId:'voice-profile-clean',generation:2});
  assert.deepEqual(removed,['cloud://private-sample']);
  assert.equal(result.status,'deletion_pending_provider');
  assert.equal(result.sampleDeletionStatus,'deleted');
  assert.equal(result.providerDeletionStatus,'manual_review');
  assert.equal(result.sample,null);
  assert.equal(result.expectedSamplePath,null);
  assert.equal((await processor.cleanup({familyId:'family_owner',profileId:'voice-profile-clean',generation:2})).status,'deletion_pending_provider');
});

test('sample cleanup can resume from a pending sample review state',async()=>{
  let profile={id:'voice-path-clean',familyId:'family_owner',status:'deletion_pending_sample',generation:2,expectedSamplePath:'voice-samples/private.wav',sampleDeletionStatus:'verification_pending',providerDeletionStatus:'not_created'};
  const removed=[];
  const repo={async getVoiceProfile(){return profile;},async updateVoiceProfile(_family,_id,expected,patch){if(Object.entries(expected).some(([key,value])=>profile[key]!==value))return false;profile={...profile,...patch};return true;}};
  const processor=createVoiceJobProcessor({repo,provider:{},storage:{async removePath(path){removed.push(path);}},inspectWav:()=>({}),now:()=> 'now'});
  const result=await processor.cleanup({familyId:'family_owner',profileId:'voice-path-clean',generation:2});
  assert.deepEqual(removed,['voice-samples/private.wav']);
  assert.equal(result.status,'deleted');
  assert.equal(result.expectedSamplePath,null);
});
