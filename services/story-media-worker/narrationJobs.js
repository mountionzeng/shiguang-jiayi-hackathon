const crypto=require('node:crypto');
const {splitNarration}=require('../../cloudfunctions/storyAudio/narration');

const UNKNOWN_ERROR={code:'TTS_RESULT_UNKNOWN',message:'腾讯云是否完成这段朗读尚不明确，不会自动重复提交'};
const rejectionError=error=>String(error?.code||'').includes('UnauthorizedOperation')
  ?{code:'TTS_PERMISSION_REQUIRED',message:'朗读服务还没有开通腾讯云语音合成权限'}
  :{code:error?.code||'TTS_SUBMISSION_REJECTED',message:'这段朗读未能提交'};
const MAX_SEGMENT_BYTES=20*1024*1024;
const hash=value=>crypto.createHash('sha256').update(Buffer.isBuffer(value)?value:String(value)).digest('hex');
const same=(left,right)=>left.length===right.length&&left.every((value,index)=>value===right[index]);

function artifactPaths(operation,segment) {
  const family=hash(operation.familyId).slice(0,24);
  const key=hash(`${operation.id}:${operation.snapshot.digest}:${JSON.stringify(operation.voice)}:${segment.digest}`).slice(0,40);
  const name=String(segment.index).padStart(5,'0');
  const root=`story-audio/narration/${family}/${key}`;
  return {audio:`${root}/${name}.wav`,metadata:`${root}/${name}.json`};
}

function findCueOffsets(text,cues,absoluteStart) {
  const source=Array.from(text);let cursor=0;
  return cues.map(cue=>{
    const target=Array.from(cue.text);let found=-1;
    for(let index=cursor;index+target.length<=source.length;index++){
      if(same(source.slice(index,index+target.length),target)){found=index;break;}
    }
    if(found<0)throw Object.assign(new Error('腾讯云字幕与朗读原文不一致'),{code:'TTS_SUBTITLE_TEXT_MISMATCH'});
    cursor=found+target.length;
    return {...cue,start:absoluteStart+found,end:absoluteStart+cursor};
  });
}

function inspectArtifact({audio,metadata,segment,inspectWav,fileID}) {
  const audioBuffer=Buffer.from(audio),audioDigest=hash(audioBuffer);
  if(metadata.version!==1||metadata.audioDigest!==audioDigest||metadata.segmentDigest!==segment.digest)throw Object.assign(new Error('朗读片段存储校验失败'),{code:'TTS_ARTIFACT_INVALID'});
  const inspection=inspectWav(audioBuffer);
  if(inspection.format!=='wav'||inspection.sampleRate!==16000||inspection.channels!==1||inspection.bitsPerSample!==16||!Number.isFinite(inspection.durationMs)||inspection.durationMs<=0)throw Object.assign(new Error('腾讯云返回的朗读音频格式无效'),{code:'TTS_AUDIO_INVALID'});
  const subtitles=findCueOffsets(segment.text,metadata.subtitles||[],segment.start);
  if(subtitles.some(cue=>cue.endMs>inspection.durationMs))throw Object.assign(new Error('腾讯云字幕超过音频时长'),{code:'TTS_SUBTITLE_TIME_INVALID'});
  return {fileID,durationMs:inspection.durationMs,bytes:inspection.bytes,audioDigest,subtitles,synchronized:subtitles.length>0};
}

async function recoverArtifact({operation,segment,storage,inspectWav}) {
  const paths=artifactPaths(operation,segment);
  try{
    const [metadataBuffer,audio,stat]=await Promise.all([
      storage.read(paths.metadata,{maxBytes:128*1024}),
      storage.read(paths.audio,{maxBytes:MAX_SEGMENT_BYTES+1}),
      storage.stat(paths.audio),
    ]);
    if(Number(stat?.bytes)>MAX_SEGMENT_BYTES)throw Object.assign(new Error('朗读片段过大'),{code:'TTS_AUDIO_TOO_LARGE'});
    const metadata=JSON.parse(Buffer.from(metadataBuffer).toString('utf8'));
    return inspectArtifact({audio,metadata,segment,inspectWav,fileID:stat?.fileID||paths.audio});
  }catch{return undefined;}
}

async function persistArtifact({operation,segment,result,storage,inspectWav}) {
  const audio=Buffer.from(result.audioBase64,'base64');
  if(!audio.length||audio.length>MAX_SEGMENT_BYTES)throw Object.assign(new Error('腾讯云返回的朗读音频大小无效'),{code:'TTS_AUDIO_TOO_LARGE'});
  const paths=artifactPaths(operation,segment),metadata={version:1,segmentDigest:segment.digest,audioDigest:hash(audio),subtitles:result.subtitles||[]};
  try{
    await storage.write(paths.metadata,Buffer.from(JSON.stringify(metadata)),{contentType:'application/json',private:true,ifAbsent:true});
    const written=await storage.write(paths.audio,audio,{contentType:'audio/wav',private:true,ifAbsent:true});
    return inspectArtifact({audio,metadata,segment,inspectWav,fileID:written?.fileID||paths.audio});
  }catch(error){
    const recovered=await recoverArtifact({operation,segment,storage,inspectWav});
    if(recovered)return recovered;
    throw error;
  }
}

function buildTimeline(segments,pauseMs=0) {
  const ordered=[...segments].sort((left,right)=>left.index-right.index);
  if(!Number.isFinite(pauseMs)||pauseMs<0||pauseMs>2000)throw Object.assign(new Error('朗读停顿设置无效'),{code:'TTS_PAUSE_INVALID'});
  let elapsed=0;const timeline=[];
  for(const [index,segment] of ordered.entries()){
    for(const cue of segment.subtitles||[])timeline.push({...cue,beginMs:cue.beginMs+elapsed,endMs:cue.endMs+elapsed});
    elapsed+=segment.durationMs;
    if(index<ordered.length-1)elapsed+=pauseMs;
  }
  const synchronized=ordered.length>0&&ordered.every(segment=>segment.synchronized===true);
  return {durationMs:elapsed,timeline,synchronized};
}

function createNarrationJobProcessor({repo,provider,storage,publisher,inspectWav,now=()=>new Date().toISOString()}) {
  if(!repo||typeof repo.assertNarrationSource!=='function'||!provider||!storage||typeof inspectWav!=='function')throw new Error('NARRATION_JOB_CONFIG_REQUIRED');
  const updateOperation=(operation,expectedStatus,patch)=>repo.updateOperation(operation.id,{status:expectedStatus,generation:operation.generation},{...patch,updatedAt:now()});

  async function sourceAllowed(operation) {
    try{await repo.assertNarrationSource(operation);return true;}
    catch(error){
      if(!['STORY_PROTOCOL_REQUIRED','NARRATION_SOURCE_INVALID','REVISION_NOT_FOUND','CHAPTER_NOT_FOUND','INVALID_CHAPTER','EMPTY_NARRATION'].includes(error?.code))throw error;
      await updateOperation(operation,operation.status,{status:'cancelled',error:{code:error.code,message:'故事来源已变化或含使用限制，未继续制作朗读'}});
      return false;
    }
  }

  async function voiceParameters(operation) {
    if(operation.voice.kind==='official'){
      const voiceType=Number(operation.voice.id);
      if(!Number.isInteger(voiceType)||voiceType<=0)return undefined;
      return {voiceType};
    }
    const profile=await repo.getVoiceProfile(operation.familyId,operation.voice.id);
    if(!profile||profile.status!=='ready'||profile.generation!==operation.voice.generation||profile.providerVoiceId!==operation.voice.fastVoiceType)return undefined;
    return {fastVoiceType:operation.voice.fastVoiceType};
  }

  async function finishSegment(operation,segment,artifact) {
    return repo.updateNarrationSegment(operation.id,segment.index,{status:segment.status,parentGeneration:operation.generation},{status:'ready',...artifact,completedAt:now(),updatedAt:now()});
  }

  async function process(job) {
    const operation=await repo.getOperation(job.operationId);
    if(!operation||operation.generation!==job.generation||['cancelled','failed','ready','deleting','deleted'].includes(operation.status))return operation||{status:'stale'};
    if(!await sourceAllowed(operation))return {status:'cancelled'};
    if(operation.status==='queued'){
      const parts=splitNarration(operation.snapshot.text,150).map(part=>({
        ...part,id:`${operation.id}_segment_${String(part.index).padStart(5,'0')}`,
        parentOperationId:operation.id,parentGeneration:operation.generation,kind:'narration_segment',
        digest:hash(part.text),sessionId:`tts-${hash(`${operation.id}:${operation.generation}:${part.index}:${part.text}`).slice(0,48)}`,
        status:'queued',attempt:0,createdAt:now(),updatedAt:now(),
      }));
      const initialized=await repo.initializeNarration(operation.id,{status:'queued',generation:operation.generation},{status:'processing',segmentCount:parts.length,updatedAt:now()},parts);
      return initialized?{...operation,status:'processing',segmentCount:parts.length}:{status:'stale'};
    }
    if(operation.status!=='processing')return operation;
    const segments=await repo.listNarrationSegments(operation.id);
    if(segments.length!==operation.segmentCount){await updateOperation(operation,'processing',{status:'failed',error:{code:'TTS_SEGMENTS_MISSING',message:'朗读片段记录不完整'}});return {status:'failed'};}
    const blocking=segments.find(segment=>['unknown','failed'].includes(segment.status));
    if(blocking){const status=blocking.status==='unknown'?'unknown':'failed';await updateOperation(operation,'processing',{status,error:blocking.error});return {status,error:blocking.error};}
    const segment=segments.find(item=>item.status!=='ready');
    if(!segment){
      const narration=buildTimeline(segments,Number(operation.segmentPauseMs||0));
      if(!await sourceAllowed(operation))return {status:'cancelled'};
      const work=publisher?await publisher.publish({operation,segments,narration}):undefined;
      const accepted=await updateOperation(operation,'processing',{status:'ready',narration,...(work?{work}:{}),completedAt:now()});
      return accepted?{...operation,status:'ready',narration,...(work?{work}:{})}:{status:'stale'};
    }
    if(segment.status==='submitting'){
      const recovered=await recoverArtifact({operation,segment,storage,inspectWav});
      if(recovered){await finishSegment(operation,segment,recovered);return {...segment,status:'ready',...recovered};}
      await repo.updateNarrationSegment(operation.id,segment.index,{status:'submitting',parentGeneration:operation.generation},{status:'unknown',error:UNKNOWN_ERROR,updatedAt:now()});
      return {status:'unknown',error:UNKNOWN_ERROR};
    }
    if(segment.status!=='queued')return segment;
    const voice=await voiceParameters(operation);
    if(!voice){const error={code:'VOICE_DISABLED',message:'所选声音已停用，未继续提交后续朗读'};await updateOperation(operation,'processing',{status:'cancelled',error});return {status:'cancelled',error};}
    const claimed=await repo.updateNarrationSegment(operation.id,segment.index,{status:'queued',parentGeneration:operation.generation},{status:'submitting',attempt:Number(segment.attempt||0)+1,submissionStartedAt:now(),updatedAt:now()});
    if(!claimed)return {status:'stale'};
    // No provider call has happened yet: a failed verification must not become
    // an ambiguous paid submission. Restore the claim on transient read errors.
    try{
      if(!await sourceAllowed(operation))return {status:'cancelled'};
    }catch(error){
      await repo.updateNarrationSegment(operation.id,segment.index,{status:'submitting',parentGeneration:operation.generation},{status:'queued',updatedAt:now()});
      throw error;
    }
    const submitting={...segment,status:'submitting'};
    try{
      const result=await provider.synthesize({text:segment.text,sessionId:segment.sessionId,...voice,speed:Number(operation.speed||0)});
      const artifact=await persistArtifact({operation,segment,storage,inspectWav,result});
      const accepted=await finishSegment(operation,submitting,artifact);
      return accepted?{...segment,status:'ready',...artifact}:{status:'stale'};
    }catch(error){
      // Keep diagnostics actionable without logging story text, audio or credentials.
      console.error('story audio segment failed',{code:error?.code||error?.name||'TTS_ERROR',requestId:error?.requestId||'',validation:error?.code?.startsWith('TTS_')?error.message:''});
      const definitelyNotSubmitted=error?.definitelyNotSubmitted===true;
      const status=definitelyNotSubmitted?'failed':'unknown';
      const detail=definitelyNotSubmitted?rejectionError(error):UNKNOWN_ERROR;
      await repo.updateNarrationSegment(operation.id,segment.index,{status:'submitting',parentGeneration:operation.generation},{status,error:detail,updatedAt:now()});
      return {status,error:detail};
    }
  }

  return {process};
}

module.exports={UNKNOWN_ERROR,artifactPaths,buildTimeline,createNarrationJobProcessor};
