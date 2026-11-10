const https=require('node:https');
const {StoryAudioError,digest,validRequestId,sourceSnapshot}=require('./core');
// Same MiniMax instrumental request used by drinking-time-local/storyAudio302.
const MODEL='music-2.5';
function musicConfigured(env){return Boolean(env.STORY_MUSIC_302_KEY && env.STORY_MUSIC_ENABLED==='true');}
function request(url,{body,maxBytes=1024*1024,timeoutMs=150000,headers={}}={}) {
  return new Promise((resolve,reject)=>{
    const req=https.request(url,{method:body?'POST':'GET',headers},res=>{
      const chunks=[];let size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)req.destroy(new Error('AUDIO_TOO_LARGE'));else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return reject(new Error('AUDIO_HTTP_'+res.statusCode));resolve(Buffer.concat(chunks));});
    });
    req.setTimeout(timeoutMs,()=>req.destroy(new Error('AUDIO_TIMEOUT')));
    req.on('error',reject);if(body)req.write(body);req.end();
  });
}
function resultUrl(payload){
  if(!payload||typeof payload!=='object')return '';
  for(const key of ['url','audio_url','audioUrl'])if(typeof payload[key]==='string')return payload[key];
  for(const item of Array.isArray(payload.data)?payload.data:[payload.data]){const url=resultUrl(item);if(url)return url;}
  return '';
}
function safeAudioUrl(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||
    !(/^(file\.302\.ai|s3\.amazonaws\.com)$/.test(url.hostname)||/^[a-z0-9.-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)))throw new Error('AUDIO_DOWNLOAD_HOST');
  return url.toString();
}
function mp3Duration(bytes){
  let offset=0,ms=0,frames=0;
  if(bytes.subarray(0,3).toString()==='ID3' && bytes.length>=10)offset=10+((bytes[6]&127)<<21)+((bytes[7]&127)<<14)+((bytes[8]&127)<<7)+(bytes[9]&127);
  while(offset+4<=bytes.length){
    const h=bytes.readUInt32BE(offset),version=(h>>>19)&3,layer=(h>>>17)&3,rate=(h>>>10)&3,index=(h>>>12)&15;
    if((h>>>21)!==2047||version===1||layer!==1||rate===3||!index||index===15){offset++;continue;}
    const sample=[44100,48000,32000][rate]/(version===3?1:version===2?2:4);
    const bitrate=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[index]*1000;
    const length=Math.floor((version===3?144:72)*bitrate/sample)+((h>>>9)&1);
    if(offset+length>bytes.length)break;
    ms+=(version===3?1152:576)*1000/sample;frames++;offset+=length;
  }
  if(frames<2||ms<1000)throw new Error('INVALID_MP3');
  return Math.round(ms);
}
function createMusicService({repo,workerRepo,storage,env=process.env,fetchBytes=request,now=()=>new Date().toISOString()}) {
  async function create(ctx,event){
    if(!ctx?.openid||!ctx.familyId)throw new StoryAudioError('AUTH_REQUIRED','请重新登录');
    if(!validRequestId(event.requestId)||!/^block-[a-f0-9]{64}$/.test(event.blockId||'')||!/^story-[a-z0-9-]+$/.test(event.storyId||'')||!/^revision-[a-zA-Z0-9-]+$/.test(event.revisionId||'')||!/^chapter-[a-z0-9-]+$/.test(event.chapterId||''))throw new StoryAudioError('INVALID_INPUT','请选择已保存的文字模块');
    const input={requestId:event.requestId,storyId:event.storyId,revisionId:event.revisionId,chapterId:event.chapterId,blockId:event.blockId};
    const id=ctx.familyId+'_'+input.requestId,fingerprint=digest({kind:'music',...input}),existing=await repo.getOperation(id);
    if(existing){if(existing.fingerprint!==fingerprint||existing.requesterOpenid!==ctx.openid)throw new StoryAudioError('REQUEST_CONFLICT','声音请求已变化');return {operation:existing};}
    if(!musicConfigured(env))throw new StoryAudioError('MUSIC_NOT_CONFIGURED','纯音乐服务尚未配置');
    const story=await repo.getStory(ctx.familyId,input.storyId);
    if(!story||story.deletedAt||story.currentRevisionId!==input.revisionId)throw new StoryAudioError('REVISION_CHANGED','请等待文字保存后再生成');
    const revision=await repo.getRevision(ctx.familyId,input.revisionId);
    const snapshot=sourceSnapshot({familyId:ctx.familyId,story,revision,...input});
    if(snapshot.text.length>8000)throw new StoryAudioError('TEXT_TOO_LONG','配乐文字请控制在八千字以内');
    const operation={id,kind:'music',familyId:ctx.familyId,requesterOpenid:ctx.openid,...input,fingerprint,snapshot,generation:1,status:'queued',voice:{kind:'official'},model:MODEL,createdAt:now(),updatedAt:now()};
    if(!await repo.createOperation(id,operation)){const raced=await repo.getOperation(id);if(raced?.fingerprint!==fingerprint)throw new StoryAudioError('REQUEST_CONFLICT','声音请求已变化');return {operation:raced};}
    return {operation};
  }
  async function process(operation){
    if(operation.kind!=='music')return operation;
    if(operation.status==='submitted' && Date.parse(now())-Date.parse(operation.updatedAt)>180000){
      await workerRepo.updateOperation(operation.id,{status:'submitted'},{status:'unknown',error:{code:'MUSIC_RESULT_UNKNOWN',message:'配乐结果尚未确认，不会自动重复扣费'},updatedAt:now()});
      return repo.getOperation(operation.id);
    }
    if(operation.status==='queued'){
      if(!musicConfigured(env))return operation;
      await workerRepo.assertNarrationSource(operation);
      // Claim before POST. An interrupted POST is never automatically submitted again.
      if(!await workerRepo.updateOperation(operation.id,{status:'queued'},{status:'submitted',updatedAt:now()}))return repo.getOperation(operation.id);
      try {
        const body=JSON.stringify({model:MODEL,prompt:'Create instrumental music only, no vocals, no spoken words. Match the mood and setting of this passage: '+operation.snapshot.text,lyrics:'[Intro]\n[Inst]\n[Outro]',stream:false,output_format:'url',audio_setting:{sample_rate:44100,bitrate:128000,format:'mp3'}});
        const payload=await require('./computeBilling').billAs({
          operationType:'storyAudio', stableId:operation.id,
          context:require('./computeBilling').contextForOpenid(operation.requesterOpenid, env), env,
        }, () => require('./computeBilling').billCall({
          model:MODEL, url:'https://api.302.ai/minimaxi/v1/music_generation', body,
          call: async () => JSON.parse((await fetchBytes('https://api.302.ai/minimaxi/v1/music_generation',{body,headers:{Authorization:'Bearer '+env.STORY_MUSIC_302_KEY,'Content-Type':'application/json'}})).toString('utf8')),
        }));
        const sourceUrl=safeAudioUrl(resultUrl(payload));
        await workerRepo.updateOperation(operation.id,{status:'submitted'},{status:'storing',sourceUrl,updatedAt:now()});
      } catch (error) {
        if (error?.definitelyNotSubmitted) {
          await workerRepo.updateOperation(operation.id,{status:'submitted'},{status:'failed',error:{code:error.code||'MUSIC_NOT_SUBMITTED',message:error.message||'配乐还没有提交'},updatedAt:now()});
        } else {
          await workerRepo.updateOperation(operation.id,{status:'submitted'},{status:'unknown',error:{code:'MUSIC_RESULT_UNKNOWN',message:'配乐结果尚未确认，已保留请求，不会重复扣费'},updatedAt:now()});
        }
      }
      // Persist the provider result first; download in the next invocation.
      return repo.getOperation(operation.id);
    }
    if(operation.status==='storing'){
      try {
        const bytes=await fetchBytes(safeAudioUrl(operation.sourceUrl),{maxBytes:20*1024*1024,timeoutMs:30000});
        const durationMs=mp3Duration(bytes);
        const stored=await storage.write('story-audio/music/'+digest(operation.id)+'.mp3',bytes,{contentType:'audio/mpeg'});
        await workerRepo.updateOperation(operation.id,{status:'storing'},{status:'ready',work:{fileID:stored.fileID,format:'mp3',durationMs,text:operation.snapshot.text,timeline:[],synchronized:false},updatedAt:now()});
      }catch{ /* Retry storage, never the paid generation. */ }
    }
    return repo.getOperation(operation.id);
  }
  return {create,process};
}
module.exports={createMusicService,musicConfigured,safeAudioUrl,mp3Duration,MODEL};
