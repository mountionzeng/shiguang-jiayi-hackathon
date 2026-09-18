const test = require('node:test');
const assert = require('node:assert/strict');
const {createStoryAudioRepository} = require('../cloudfunctions/storyAudio/repository');
const {createStoryAudioHandlers} = require('../cloudfunctions/storyAudio/flow');
const {beginAudioCleanup}=require('../cloudfunctions/storyAudio/cleanup');
const {credentialsFromEnv,tencentRegionFromEnv,createCloudStorage,createCloudAudioRuntime}=require('../cloudfunctions/storyAudio/cloudRuntime');
const {CORE_COLLECTIONS} = require('../cloudfunctions/ensureCloudCollections/bootstrap');

function fakeDatabase() {
  const tables = new Map();
  const table = name => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const target = {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              if (!table(name).has(id)) throw new Error('document not found');
              return {data: structuredClone(table(name).get(id))};
            },
            async set({data}) { table(name).set(id, structuredClone(data)); },
          };
        },
      };
    },
  };
  return {
    ...target,
    async runTransaction(callback) { return callback(target); },
    seed(name,id,value) { table(name).set(id,structuredClone(value)); },
    read(name,id) { return table(name).get(id); },
  };
}

test('audio runtime prefers project-scoped Tencent credentials over injected platform credentials',()=>{
  const env={
    STORY_AUDIO_TENCENT_SECRET_ID:'dedicated-id',
    STORY_AUDIO_TENCENT_SECRET_KEY:'dedicated-key',
    STORY_AUDIO_TENCENT_REGION:'ap-shanghai',
    TENCENTCLOUD_SECRETID:'platform-id',
    TENCENTCLOUD_SECRETKEY:'platform-key',
    TENCENTCLOUD_SESSION_TOKEN:'platform-token',
    TENCENTCLOUD_REGION:'ap-beijing',
  };
  assert.deepEqual(credentialsFromEnv(env),{secretId:'dedicated-id',secretKey:'dedicated-key',token:''});
  assert.equal(tencentRegionFromEnv(env),'ap-shanghai');
});

test('enabled cloud runtime wires the real narration repository and processor at startup',()=>{
  const runtime=createCloudAudioRuntime({
    cloud:{},db:{command:{in:value=>value}},
    env:{STORY_AUDIO_TENCENT_SECRET_ID:'test-id',STORY_AUDIO_TENCENT_SECRET_KEY:'test-key'},
    client:{async TextToVoice(){throw new Error('Startup must not synthesize speech');}},
  });
  assert.equal(runtime.capabilityConfig.ttsEnabled,true);
  assert.equal(typeof runtime.processOperation,'function');
  assert.equal(typeof runtime.sweep,'function');
});

test('enabled voice enrollment wires a durable cloud voice processor',()=>{
  const runtime=createCloudAudioRuntime({
    cloud:{},db:{command:{in:value=>value}},
    env:{
      STORY_AUDIO_TENCENT_SECRET_ID:'test-id',STORY_AUDIO_TENCENT_SECRET_KEY:'test-key',
      STORY_AUDIO_VOICE_CLONE_ENABLED:'true',STORY_AUDIO_VOICE_ENROLLMENT_ENABLED:'true',
      STORY_AUDIO_VOICE_WORKER_ENABLED:'true',
    },
    client:{
      async TextToVoice(){},async GetTrainingText(){},async DetectEnvAndSoundQuality(){},
      async CreateVRSTask(){},async DescribeVRSTaskStatus(){},
    },
  });
  assert.equal(runtime.capabilityConfig.voiceEnrollmentEnabled,true);
  assert.equal(runtime.capabilityConfig.voiceCloneEnabled,true);
  assert.equal(typeof runtime.processVoiceProfile,'function');
});

test('cloud voice storage reads a private uploaded sample outside the current invocation once',async()=>{
  let downloads=0;
  const storage=createCloudStorage({
    async downloadFile({fileID}){downloads++;assert.equal(fileID,'cloud://env.voice-samples/private.wav');return {fileContent:Buffer.from('sample')};},
  });
  assert.deepEqual(await storage.stat('cloud://env.voice-samples/private.wav'),{bytes:6,fileID:'cloud://env.voice-samples/private.wav'});
  assert.equal((await storage.read('cloud://env.voice-samples/private.wav',{maxBytes:10})).toString(),'sample');
  assert.equal(downloads,1);
});

test('repository reads only family-owned stories and revisions', async () => {
  const db=fakeDatabase();
  db.seed('stories','family_owner_story-a',{id:'story-a',familyId:'family_owner'});
  db.seed('biography_drafts','family_owner_revision-a',{familyId:'family_owner',storyId:'story-a',revision:{id:'revision-a',storyId:'story-a'}});
  const repo=createStoryAudioRepository(db);
  assert.equal((await repo.getStory('family_owner','story-a')).id,'story-a');
  assert.equal((await repo.getRevision('family_owner','revision-a')).id,'revision-a');
  assert.equal(await repo.getStory('family_other','story-a'),undefined);
  assert.equal(await repo.getRevision('family_other','revision-a'),undefined);
});

test('operation creation is transactionally create-once', async () => {
  const db=fakeDatabase(), repo=createStoryAudioRepository(db);
  db.seed('stories','family_owner_story-a',{id:'story-a',familyId:'family_owner',currentRevisionId:'revision-a'});
  db.seed('biography_drafts','family_owner_revision-a',{familyId:'family_owner',revision:{id:'revision-a',storyId:'story-a'}});
  const operation={id:'family_owner_audio-request-1',familyId:'family_owner',storyId:'story-a',revisionId:'revision-a',fingerprint:'one'};
  assert.equal(await repo.createOperation(operation.id,operation),true);
  assert.equal(await repo.createOperation(operation.id,{...operation,fingerprint:'two'}),false);
  assert.equal(db.read('audio_operations',operation.id).fingerprint,'one');
});

test('operation transaction rejects a revision changed after snapshot loading', async () => {
  const db=fakeDatabase(), repo=createStoryAudioRepository(db);
  db.seed('stories','family_owner_story-a',{id:'story-a',familyId:'family_owner',currentRevisionId:'revision-new'});
  db.seed('biography_drafts','family_owner_revision-a',{familyId:'family_owner',revision:{id:'revision-a',storyId:'story-a'}});
  await assert.rejects(repo.createOperation('family_owner_audio-request-2',{id:'family_owner_audio-request-2',familyId:'family_owner',storyId:'story-a',revisionId:'revision-a'}),error=>error.code==='REVISION_CHANGED');
  assert.equal(db.read('audio_operations','family_owner_audio-request-2'),undefined);
});

test('audio write transaction rejects a newly source-bound story before persisting paid intent',async()=>{
  const db=fakeDatabase(),repo=createStoryAudioRepository(db);
  db.seed('stories','family_owner_story-a',{id:'story-a',familyId:'family_owner',currentRevisionId:'revision-a',sourcePolicyRequired:true});
  db.seed('biography_drafts','family_owner_revision-a',{familyId:'family_owner',revision:{id:'revision-a',storyId:'story-a'}});
  await assert.rejects(repo.createOperation('family_owner_audio-restricted',{familyId:'family_owner',storyId:'story-a',revisionId:'revision-a'}),{code:'STORY_PROTOCOL_REQUIRED'});
  assert.equal(db.read('audio_operations','family_owner_audio-restricted'),undefined);
});

test('voice profile updates compare status and generation transactionally',async()=>{
  const db=fakeDatabase(),repo=createStoryAudioRepository(db);
  const profile={id:'voice-profile-a',familyId:'family_owner',ownerOpenid:'owner',status:'training',generation:1};
  assert.equal(await repo.createVoiceProfile('family_owner',profile.id,profile),true);
  assert.equal(await repo.updateVoiceProfile('family_owner',profile.id,{status:'training',generation:1},{status:'ready'}),true);
  assert.equal(await repo.updateVoiceProfile('family_owner',profile.id,{status:'training',generation:1},{providerVoiceId:'late'}),false);
  assert.equal(db.read('voice_profiles','family_owner_voice-profile-a').providerVoiceId,undefined);
});

for(const runtime of ['cloudfunctions/storyAudio','services/story-media-worker']){
  test(runtime+' validates authoritative narration sources and complete snapshots',async()=>{
    const {chapterSnapshot}=require('../cloudfunctions/storyAudio/core');
    const {createNarrationWorkerRepository}=require('../'+runtime+'/narrationRepository');
    const db=fakeDatabase(),familyId='family_owner';
    const story={id:'story-a',familyId,currentRevisionId:'revision-a'};
    const revision={id:'revision-a',storyId:story.id,draft:{title:'记忆',chapters:[{id:'chapter-a',title:'童年',content:[{text:'一起回家。'}]}]}};
    const record={familyId,revision};
    const operation={familyId,storyId:story.id,revisionId:revision.id,chapterId:'chapter-a'};
    operation.snapshot=chapterSnapshot({...operation,story,revision});
    db.seed('stories',familyId+'_story-a',story);
    db.seed('biography_drafts',familyId+'_revision-a',record);
    const repo=createNarrationWorkerRepository({db,command:{in:value=>value}});
    await repo.assertNarrationSource(operation);
    const altered=structuredClone(operation);altered.snapshot.text='伪造文字';
    await assert.rejects(repo.assertNarrationSource(altered),{code:'NARRATION_SOURCE_INVALID'});
    db.seed('stories',familyId+'_story-a',{...story,currentRevisionId:'revision-b'});
    db.seed('biography_drafts',familyId+'_revision-b',{familyId,revision:{...revision,id:'revision-b'}});
    await repo.assertNarrationSource(operation); // Ordinary edits preserve the queued snapshot.
    db.seed('biography_drafts',familyId+'_revision-b',{familyId,revision:{...revision,id:'revision-b',draft:{...revision.draft,provenanceVersion:1}}});
    await assert.rejects(repo.assertNarrationSource(operation),{code:'STORY_PROTOCOL_REQUIRED'});
    db.seed('stories',familyId+'_story-a',{...story,deletedAt:'now'});
    await assert.rejects(repo.assertNarrationSource(operation),{code:'NARRATION_SOURCE_INVALID'});
    db.seed('stories',familyId+'_story-a',story);
    db.seed('biography_drafts',familyId+'_revision-a',{...record,familyId:'family_foreign'});
    await assert.rejects(repo.assertNarrationSource(operation),{code:'NARRATION_SOURCE_INVALID'});
    const outage=createNarrationWorkerRepository({db:{runTransaction:async()=>{throw new Error('offline');}},command:{in:value=>value}});
    await assert.rejects(outage.assertNarrationSource(operation),/offline/);
    // Exercise the real worker -> repository -> authoritative document chain.
    db.seed('stories',familyId+'_story-a',{...story,sourcePolicyRequired:true});
    db.seed('biography_drafts',familyId+'_revision-a',record);
    const queued={...operation,id:'audio-source-check',status:'queued',generation:1};
    db.seed('audio_operations',queued.id,queued);
    let calls=0;
    const {createNarrationJobProcessor}=require('../'+runtime+'/narrationJobs');
    const processor=createNarrationJobProcessor({repo,provider:{async synthesize(){calls++;}},storage:{},inspectWav:()=>({})});
    assert.equal((await processor.process({operationId:queued.id,generation:1})).status,'cancelled');
    assert.equal(db.read('audio_operations',queued.id).status,'cancelled');
    assert.equal(calls,0);
  });
}

test('status requires server identity and does not reveal another requester operation', async () => {
  const operation={id:'family_owner_audio-request-1',familyId:'family_owner',requesterOpenid:'owner',storyId:'story-a',revisionId:'revision-a',chapterId:'chapter-a',status:'queued',createdAt:'now',updatedAt:'now',snapshot:{title:'章节',bookTitle:'书',digest:'abc'},voice:{kind:'official',id:'private-provider-id'}};
  const handlers=createStoryAudioHandlers({repo:{async getOperation(){return operation;}}});
  await assert.rejects(handlers.status({}, {requestId:'audio-request-1'}),error=>error.code==='AUTH_REQUIRED');
  await assert.rejects(handlers.status({familyId:'family_owner',openid:'other'},{requestId:'audio-request-1'}),error=>error.code==='OPERATION_NOT_FOUND');
  const result=await handlers.status({familyId:'family_owner',openid:'owner'},{requestId:'audio-request-1'});
  assert.deepEqual(result.operation.voice,{kind:'official'});
});

test('ready playback is signed only after the requester and completed work are rechecked',async()=>{
  const operation={id:'family_owner_audio-ready',familyId:'family_owner',requesterOpenid:'owner',storyId:'story-a',revisionId:'revision-a',chapterId:'chapter-a',status:'ready',createdAt:'now',updatedAt:'now',snapshot:{title:'章节',bookTitle:'书',digest:'abc'},voice:{kind:'official'},work:{text:'第一句',durationMs:900,synchronized:true,timeline:[{text:'第一句',start:0,end:3,beginMs:0,endMs:900}]}};
  const handlers=createStoryAudioHandlers({repo:{async getOperation(){return operation;},async signWork(){return 'https://signed.example/private.wav';}}});
  const result=await handlers.status({familyId:'family_owner',openid:'owner'},{requestId:'audio-ready'});
  assert.equal(result.operation.playback.audioUrl,'https://signed.example/private.wav');
  assert.equal(result.operation.playback.timeline[0].text,'第一句');
});

test('repository signs only the completed private audio file and never exposes its file id',async()=>{
  const db=fakeDatabase(),calls=[];
  const repo=createStoryAudioRepository(db,{async signFile(fileID){calls.push(fileID);return 'https://signed.example/final.wav';}});
  const signed=await repo.signWork({status:'ready',work:{fileID:'cloud://private/final.wav',format:'wav'}});
  assert.deepEqual(calls,['cloud://private/final.wav']);
  assert.deepEqual(signed,{audioUrl:'https://signed.example/final.wav'});
  await assert.rejects(repo.signWork({status:'processing',work:{fileID:'cloud://private/final.wav'}}),error=>error.code==='WORK_NOT_READY');
});

test('status advances queued work before returning the player contract',async()=>{
  let operation={id:'family_owner_audio-live',familyId:'family_owner',requesterOpenid:'owner',storyId:'story-a',revisionId:'revision-a',chapterId:'chapter-a',status:'queued',createdAt:'now',updatedAt:'now',snapshot:{title:'章节',bookTitle:'书',digest:'abc'},voice:{kind:'official'}};
  const repo={async getOperation(){return operation;},async signWork(){return {audioUrl:'https://signed.example/live.wav'};}};
  const handlers=createStoryAudioHandlers({repo,async processOperation(){operation={...operation,status:'ready',work:{fileID:'cloud://private/live.wav',format:'wav',text:'第一句',durationMs:900,synchronized:true,timeline:[{text:'第一句',start:0,end:3,beginMs:0,endMs:900}]}};return operation;}});
  const result=await handlers.status({familyId:'family_owner',openid:'owner'},{requestId:'audio-live'});
  assert.equal(result.operation.status,'ready');
  assert.equal(result.operation.playback.audioUrl,'https://signed.example/live.wav');
});

test('account cleanup fences audio work before clearing assets',async()=>{
  const steps=[];const epoch=await beginAudioCleanup({async bumpAudioEpoch(){steps.push('epoch');return 9;},async cancelAudioForFamily(_family,value){steps.push(`cancel:${value}`);},async disableVoicesForFamily(_family,value){steps.push(`voice:${value}`);}},'family_owner');
  assert.equal(epoch,9);assert.deepEqual(steps,['epoch','cancel:9','voice:9']);
});

test('audio collections are included in cloud bootstrap and deployment manifest', () => {
  for(const name of ['audio_operations','voice_profiles','audio_works'])assert.ok(CORE_COLLECTIONS.includes(name));
  const manifest=require('../deploy/wechat-cloud.manifest.json');
  assert.ok(manifest.cloudFunctions.storyAudio);
  for(const name of ['STORY_AUDIO_TENCENT_SECRET_ID','STORY_AUDIO_TENCENT_SECRET_KEY','STORY_AUDIO_TENCENT_REGION'])assert.ok(manifest.cloudFunctions.storyAudio.environmentVariables.includes(name));
  assert.deepEqual(Object.keys(manifest.collections).filter(name=>name.startsWith('audio_')).sort(),['audio_operations','audio_works']);
  assert.ok(manifest.collections.voice_profiles);
});
