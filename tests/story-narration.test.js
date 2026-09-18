const test=require('node:test');
const assert=require('node:assert/strict');
const {splitNarration}=require('../cloudfunctions/storyAudio/narration');
const {createTencentTtsAdapter}=require('../cloudfunctions/storyAudio/tencentTts');
const {buildTimeline,createNarrationJobProcessor}=require('../services/story-media-worker/narrationJobs');
const {createNarrationRunner}=require('../services/story-media-worker/narrationRunner');
const {createNarrationWorkerRepository}=require('../services/story-media-worker/narrationRepository');
const {inspectWav}=require('../services/story-media-worker/inspectWav');
const {concatWav}=require('../cloudfunctions/storyAudio/wav');

function wav(durationMs=1000) {
  const sampleRate=16000,channels=1,bits=16,dataBytes=Math.round(sampleRate*channels*(bits/8)*durationMs/1000),buffer=Buffer.alloc(44+dataBytes);
  buffer.write('RIFF',0);buffer.writeUInt32LE(36+dataBytes,4);buffer.write('WAVE',8);buffer.write('fmt ',12);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(channels,22);buffer.writeUInt32LE(sampleRate,24);buffer.writeUInt32LE(sampleRate*channels*(bits/8),28);buffer.writeUInt16LE(channels*(bits/8),32);buffer.writeUInt16LE(bits,34);buffer.write('data',36);buffer.writeUInt32LE(dataBytes,40);
  return buffer;
}

function narrationFixture({text='第一句。第二句。',voice={kind:'official',id:'101001'},provider,storage,publisher}={}) {
  let operation={id:'family-a_audio-job',familyId:'family-a',status:'queued',generation:1,snapshot:{text,digest:'snapshot-a'},voice};
  let segments=[];
  const repo={
    async assertNarrationSource(){},
    async getOperation(){return structuredClone(operation);},
    async initializeNarration(_id,expected,patch,created){if(operation.status!==expected.status||operation.generation!==expected.generation)return false;operation={...operation,...structuredClone(patch)};segments=structuredClone(created);return true;},
    async listNarrationSegments(){return structuredClone(segments);},
    async updateNarrationSegment(_id,index,expected,patch){const current=segments[index];if(!current||Object.entries(expected).some(([key,value])=>current[key]!==value))return false;segments[index]={...current,...structuredClone(patch)};return true;},
    async updateOperation(_id,expected,patch){if(Object.entries(expected).some(([key,value])=>operation[key]!==value))return false;operation={...operation,...structuredClone(patch)};return true;},
    async getVoiceProfile(){return {id:voice.id,status:'ready',generation:voice.generation,providerVoiceId:voice.fastVoiceType};},
  };
  const files=new Map(),mediaStorage=storage||{
    async write(path,value){files.set(path,Buffer.from(value));return {fileID:`private://${path}`};},
    async read(path){if(!files.has(path))throw new Error('not found');return files.get(path);},
    async stat(path){if(!files.has(path))throw new Error('not found');return {bytes:files.get(path).length,fileID:`private://${path}`};},
  };
  const tts=provider||{async synthesize({text:part}){return {audioBase64:wav(1000).toString('base64'),subtitles:[{text:part,beginMs:0,endMs:900}]};}};
  const processor=createNarrationJobProcessor({repo,provider:tts,storage:mediaStorage,publisher,inspectWav,now:()=> '2026-09-18T12:00:00.000Z'});
  return {repo,processor,files,getOperation:()=>operation,getSegments:()=>segments};
}

test('narration splits at 150 code points without losing punctuation or emoji',()=>{
  const source=('外婆说：“慢慢讲。”🙂\n后来我们一起回家。').repeat(20),parts=splitNarration(source,150);
  assert.ok(parts.length>1);
  assert.equal(parts.map(part=>part.text).join(''),source);
  assert.ok(parts.every(part=>Array.from(part.text).length<=150));
  assert.ok(parts.every((part,index)=>index===0||part.start===parts[index-1].end));
  assert.equal(parts.at(-1).end,Array.from(source).length);
});

test('worker checks source permission before TTS and before publishing, not only at queue creation',async()=>{
  for(const phase of ['queued','provider','publish']){
    let calls=0,published=0,denied=false;
    const f=narrationFixture({provider:{async synthesize({text}){calls++;return {audioBase64:wav().toString('base64'),subtitles:[{text,beginMs:0,endMs:900}]};}},publisher:{async publish(){published++;return {fileID:'private://final'};}}});
    f.repo.assertNarrationSource=async()=>{if(denied)throw Object.assign(new Error('restricted'),{code:'STORY_PROTOCOL_REQUIRED'});};
    if(phase!=='queued')await f.processor.process({operationId:'family-a_audio-job',generation:1});
    if(phase==='publish')await f.processor.process({operationId:'family-a_audio-job',generation:1});
    denied=true;
    await f.processor.process({operationId:'family-a_audio-job',generation:1});
    assert.equal(calls,phase==='publish'?1:0);assert.equal(published,0);assert.equal(f.getOperation().status,'cancelled');
  }
});

test('missing source verifier fails closed instead of silently running a legacy worker',()=>{
  const f=narrationFixture();delete f.repo.assertNarrationSource;
  assert.throws(()=>createNarrationJobProcessor({repo:f.repo,provider:{},storage:{},inspectWav}),/NARRATION_JOB_CONFIG_REQUIRED/);
});

test('late source rejection never calls TTS and a transient verifier failure leaves a retryable claim',async()=>{
  for(const code of ['STORY_PROTOCOL_REQUIRED','DB_OFFLINE']){
    let calls=0,checks=0;
    const f=narrationFixture({provider:{async synthesize(){calls++;throw new Error('must not run');}}});
    await f.processor.process({operationId:'family-a_audio-job',generation:1});
    f.repo.assertNarrationSource=async()=>{if(++checks===2)throw Object.assign(new Error(code),{code});};
    const run=f.processor.process({operationId:'family-a_audio-job',generation:1});
    if(code==='DB_OFFLINE'){
      await assert.rejects(run,{code});
      assert.equal(f.getOperation().status,'processing');
      assert.equal(f.getSegments()[0].status,'queued');
    }else{
      assert.equal((await run).status,'cancelled');
      assert.equal(f.getOperation().status,'cancelled');
    }
    assert.equal(calls,0);
  }
});

test('cloud and standalone narration workers retain identical behavior',()=>{
  const fs=require('node:fs'),path=require('node:path');
  for(const file of ['narrationJobs.js','narrationRepository.js']){
    const cloud=fs.readFileSync(path.join(__dirname,'../cloudfunctions/storyAudio',file),'utf8');
    const worker=fs.readFileSync(path.join(__dirname,'../services/story-media-worker',file),'utf8').replaceAll('../../cloudfunctions/storyAudio/','./');
    assert.equal(worker,cloud);
  }
});

test('Tencent TTS uses the clone voice contract and returns only normalized media data',async()=>{
  const calls=[];
  const adapter=createTencentTtsAdapter({client:{async TextToVoice(input){calls.push(input);return {Audio:'YWJj',SessionId:input.SessionId,Subtitles:[{Text:'你好',BeginTime:0,EndTime:500},{Text:'世界',BeginTime:500,EndTime:900}],RequestId:'private'};}}});
  const result=await adapter.synthesize({text:'你好世界',sessionId:'audio-segment-a',fastVoiceType:'fast-private',speed:0});
  assert.deepEqual(calls[0],{Text:'你好世界',SessionId:'audio-segment-a',VoiceType:200000000,FastVoiceType:'fast-private',Codec:'wav',SampleRate:16000,Speed:0,Volume:0,EnableSubtitle:true});
  assert.deepEqual(result,{audioBase64:'YWJj',subtitles:[{text:'你好',beginMs:0,endMs:500},{text:'世界',beginMs:500,endMs:900}]});
  assert.equal(JSON.stringify(result).includes('private'),false);
});

test('Tencent silence markers preserve real subtitle timing without becoming empty reading cues',async()=>{
  const adapter=createTencentTtsAdapter({client:{async TextToVoice(){return {Audio:'YWJj',Subtitles:[
    {Text:'测',BeginTime:250,EndTime:520},
    {Text:'',Phoneme:'SIL',BeginTime:520,EndTime:700},
    {Text:'试',BeginTime:700,EndTime:1000},
    {Text:'',Phoneme:'SIL',BeginTime:1000,EndTime:1260},
  ]};}}});
  const result=await adapter.synthesize({text:'测试',sessionId:'audio-silence',voiceType:101001});
  assert.deepEqual(result.subtitles,[{text:'测',beginMs:250,endMs:520},{text:'试',beginMs:700,endMs:1000}]);
});

test('Tencent zero-duration punctuation joins the preceding cue without changing speech timing',async()=>{
  const adapter=createTencentTtsAdapter({client:{async TextToVoice(){return {Audio:'YWJj',Subtitles:[
    {Text:'子',Phoneme:'zi5',BeginTime:1930,EndTime:2130},
    {Text:'。',Phoneme:'PPP',BeginTime:2130,EndTime:2130},
    {Text:'我',Phoneme:'wo3',BeginTime:2590,EndTime:2750},
    {Text:'！',Phoneme:'PPP',BeginTime:2750,EndTime:2750},
    {Text:'',Phoneme:'SIL',BeginTime:2750,EndTime:3010},
  ]};}}});
  const result=await adapter.synthesize({text:'子。我！',sessionId:'audio-punctuation',voiceType:101001});
  assert.deepEqual(result.subtitles,[{text:'子。',beginMs:1930,endMs:2130},{text:'我！',beginMs:2590,endMs:2750}]);
  const invalid=createTencentTtsAdapter({client:{async TextToVoice(){return {Audio:'YWJj',Subtitles:[{Text:'我',Phoneme:'wo3',BeginTime:250,EndTime:250}]};}}});
  await assert.rejects(invalid.synthesize({text:'我',sessionId:'audio-zero-speech',voiceType:101001}),{code:'TTS_PROVIDER_INVALID_RESPONSE'});
});

test('narration is not ready until one player-ready private work has been published',async()=>{
  const published=[];
  const fixture=narrationFixture({publisher:{async publish(input){published.push(input);return {fileID:'cloud://private/final.wav',format:'wav',text:input.operation.snapshot.text,durationMs:input.narration.durationMs,timeline:input.narration.timeline,synchronized:input.narration.synchronized};}}});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  assert.equal(published.length,1);
  assert.equal(fixture.getOperation().status,'ready');
  assert.equal(fixture.getOperation().work.fileID,'cloud://private/final.wav');
  assert.equal(fixture.getOperation().work.text,'第一句。第二句。');
});

test('Tencent TTS accepts static fallback but rejects malformed timestamps and responses',async()=>{
  const staticAdapter=createTencentTtsAdapter({client:{async TextToVoice(){return {Audio:'YWJj',Subtitles:[]};}}});
  assert.deepEqual(await staticAdapter.synthesize({text:'一段话',sessionId:'audio-static',voiceType:101001}),{audioBase64:'YWJj',subtitles:[]});
  const invalid=createTencentTtsAdapter({client:{async TextToVoice(){return {Audio:'YWJj',Subtitles:[{Text:'错',BeginTime:500,EndTime:400}]};}}});
  await assert.rejects(invalid.synthesize({text:'错',sessionId:'audio-invalid',voiceType:101001}),error=>error.code==='TTS_PROVIDER_INVALID_RESPONSE');
});

test('timeline includes explicit inter-segment pauses and marks missing subtitles as static fallback',()=>{
  const result=buildTimeline([
    {index:0,durationMs:1000,synchronized:true,subtitles:[{text:'一',beginMs:0,endMs:900,start:0,end:1}]},
    {index:1,durationMs:800,synchronized:false,subtitles:[]},
  ],200);
  assert.equal(result.durationMs,2000);
  assert.equal(result.synchronized,false);
  assert.deepEqual(result.timeline.map(cue=>[cue.beginMs,cue.endMs]),[[0,900]]);
});

test('published narration joins Tencent WAV segments without inventing time',()=>{
  const joined=concatWav([wav(1000),wav(700)]),inspection=inspectWav(joined);
  assert.equal(inspection.sampleRate,16000);
  assert.equal(inspection.channels,1);
  assert.equal(inspection.durationMs,1700);
});

test('narration worker persists intent, uses decoded duration, and builds one global timeline',async()=>{
  const calls=[],source='甲'.repeat(149)+'。'+'第二段。';
  const fixture=narrationFixture({text:source,provider:{async synthesize(input){calls.push(input);const duration=calls.length===1?1000:700;return {audioBase64:wav(duration).toString('base64'),subtitles:[{text:input.text,beginMs:0,endMs:duration-100}]};}}});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  assert.equal(fixture.getOperation().status,'processing');
  assert.equal(fixture.getSegments().length,2);
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  assert.equal(calls.length,2);
  assert.equal(fixture.getOperation().status,'ready');
  assert.equal(fixture.getOperation().narration.durationMs,1700);
  assert.deepEqual(fixture.getOperation().narration.timeline.map(cue=>[cue.beginMs,cue.endMs,cue.start,cue.end]),[[0,900,0,150],[1000,1600,150,154]]);
  assert.equal(fixture.getOperation().narration.synchronized,true);
});

test('stored provider result is recovered after a storage acknowledgement failure without another TTS call',async()=>{
  const files=new Map(),calls=[];let failOnce=true;
  const storage={
    async write(path,value){files.set(path,Buffer.from(value));if(path.endsWith('.wav')&&failOnce){failOnce=false;throw new Error('ack lost');}return {fileID:`private://${path}`};},
    async read(path){if(!files.has(path))throw new Error('not found');return files.get(path);},
    async stat(path){if(!files.has(path))throw new Error('not found');return {bytes:files.get(path).length,fileID:`private://${path}`};},
  };
  const fixture=narrationFixture({storage,provider:{async synthesize({text}){calls.push(text);return {audioBase64:wav().toString('base64'),subtitles:[{text,beginMs:0,endMs:900}]};}}});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  assert.equal(calls.length,1);
  assert.equal(fixture.getSegments()[0].status,'ready');
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  assert.equal(calls.length,1);
  assert.equal(fixture.getOperation().status,'ready');
});

test('a restarted submitted segment becomes unknown instead of being submitted twice',async()=>{
  const calls=[],fixture=narrationFixture({provider:{async synthesize(){calls.push('called');throw Object.assign(new Error('connection closed'),{code:'ECONNRESET'});}}});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  assert.equal(calls.length,1);
  assert.equal(fixture.getSegments()[0].status,'unknown');
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  assert.equal(calls.length,1);
  assert.equal(fixture.getOperation().status,'unknown');
});

test('a Tencent permission denial is final and explains the missing service permission',async()=>{
  const fixture=narrationFixture({provider:{async synthesize(){throw Object.assign(new Error('denied'),{code:'AuthFailure.UnauthorizedOperation',definitelyNotSubmitted:true});}}});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  assert.equal(fixture.getOperation().status,'failed');
  assert.deepEqual(fixture.getOperation().error,{code:'TTS_PERMISSION_REQUIRED',message:'朗读服务还没有开通腾讯云语音合成权限'});
});

test('clone voice generation is rechecked before every segment',async()=>{
  let profile={status:'ready',generation:4,providerVoiceId:'clone-private'},calls=0;
  const fixture=narrationFixture({text:'甲'.repeat(150)+'乙。',voice:{kind:'clone',id:'voice-a',generation:4,fastVoiceType:'clone-private'},provider:{async synthesize({text}){calls++;return {audioBase64:wav().toString('base64'),subtitles:[{text,beginMs:0,endMs:900}]};}}});
  fixture.repo.getVoiceProfile=async()=>profile;
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  profile={...profile,status:'disabled',generation:5};
  await fixture.processor.process({operationId:'family-a_audio-job',generation:1});
  assert.equal(calls,1);
  assert.equal(fixture.getOperation().status,'cancelled');
  assert.equal(fixture.getOperation().error.code,'VOICE_DISABLED');
});

test('narration runner scans durable operations instead of relying on page polling',async()=>{
  const calls=[],runner=createNarrationRunner({repo:{async listRunnableNarrations(){return [{id:'operation-a',generation:3}];}},processor:{async process(job){calls.push(job);}}});
  assert.equal(await runner.runOnce(),true);
  assert.deepEqual(calls,[{operationId:'operation-a',generation:3}]);
});

test('repository initializes long narration as small idempotent transactions',async()=>{
  const records=new Map([['operation-a',{id:'operation-a',kind:'narration',status:'queued',generation:1}]]);let writes=0,maxWrites=0;
  const db={
    collection(){return {doc(id){return {async get(){if(!records.has(id))throw new Error('document not found');return {data:structuredClone(records.get(id))};},async set({data}){writes++;records.set(id,structuredClone(data));}};}};},
    async runTransaction(callback){writes=0;const result=await callback(db);maxWrites=Math.max(maxWrites,writes);return result;},
  };
  const repo=createNarrationWorkerRepository({db,command:{in:value=>value}}),segments=Array.from({length:140},(_,index)=>({id:`operation-a_segment_${String(index).padStart(5,'0')}`,kind:'narration_segment',parentOperationId:'operation-a',parentGeneration:1,index,digest:`digest-${index}`,status:'queued'}));
  assert.equal(await repo.initializeNarration('operation-a',{status:'queued',generation:1},{status:'processing',segmentCount:segments.length},segments),true);
  assert.equal(maxWrites,1);
  assert.equal(records.get('operation-a').segmentCount,140);
  assert.equal(records.get('operation-a_segment_00139').digest,'digest-139');
});
