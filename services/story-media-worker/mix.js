const crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const privateVoice=value=>typeof value==='string'&&value.startsWith('/private/')&&!value.includes('..');
const licensed=value=>typeof value==='string'&&value.startsWith('/licensed/')&&!value.includes('..');

function workKeys(narration,background,templateVersion) {
  const narrationKey=digest({accountId:narration.accountId,textDigest:narration.textDigest,voiceVersion:narration.voiceVersion,speed:narration.speed});
  const mix=digest({narration:narrationKey,background:background?{id:background.id,volume:background.volume}:null});
  return {narration:narrationKey,mix,video:digest({mix,templateVersion})};
}
function buildMixPlan({voiceFiles,durationMs,background}) {
  if(!Array.isArray(voiceFiles)||!voiceFiles.length||!voiceFiles.every(privateVoice)||!Number.isFinite(durationMs)||durationMs<=0)throw new Error('私有媒体人声文件无效');
  if(background&&(!licensed(background.file)||!Number.isFinite(background.durationMs)||background.durationMs<=0||!Number.isFinite(background.volume)||background.volume<0||background.volume>.4))throw new Error('授权背景音无效');
  const inputs=[...voiceFiles];let filter=`[0:a]${voiceFiles.length>1?`concat=n=${voiceFiles.length}:v=0:a=1`:'anull'}[voice]`;
  if(background){inputs.push(background.file);const loopSize=Math.round(background.durationMs*48);filter+=`;[${voiceFiles.length}:a]aloop=loop=-1:size=${loopSize},atrim=duration=${(durationMs/1000).toFixed(3)},volume=${background.volume}[bg];[voice][bg]amix=inputs=2:duration=first:dropout_transition=0[mix]`;}
  return {inputs,filter,outputLabel:background?'mix':'voice'};
}
function ffmpegMixArgs(plan,{inputs,output}) {
  if(!plan||!Array.isArray(inputs)||inputs.length!==plan.inputs.length||!inputs.every(value=>typeof value==='string'&&value.startsWith('/work/')&&!value.includes('..'))||typeof output!=='string'||!output.startsWith('/work/')||output.includes('..'))throw new Error('媒体工作目录无效');
  const args=['-y'];for(const input of inputs)args.push('-i',input);
  args.push('-filter_complex',plan.filter,'-map',`[${plan.outputLabel}]`,'-ar','24000','-ac','1','-c:a','pcm_s16le',output);
  return args;
}
function runFfmpeg(args,{spawn}={}) {
  if(!Array.isArray(args)||typeof spawn!=='function')throw new Error('FFMPEG_CONFIG_REQUIRED');
  return spawn('ffmpeg',args);
}
module.exports={buildMixPlan,ffmpegMixArgs,runFfmpeg,workKeys};
