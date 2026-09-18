const {StoryAudioError}=require('./core');
function playbackFor(operation,signedUrl){
  const work=operation?.work;
  const audioUrl=typeof signedUrl==='string'?signedUrl:signedUrl?.audioUrl;
  const videoUrl=typeof signedUrl==='object'?signedUrl?.videoUrl:undefined;
  if(operation?.status!=='ready'||!work||typeof audioUrl!=='string'||!audioUrl.startsWith('https://')||!Array.isArray(work.timeline)||typeof work.text!=='string'||!Number.isFinite(work.durationMs)||work.durationMs<=0)throw new StoryAudioError('WORK_NOT_READY','作品尚未准备好播放');
  return {audioUrl,...(typeof videoUrl==='string'&&videoUrl.startsWith('https://')?{videoUrl}:{}),text:work.text,durationMs:work.durationMs,timeline:work.timeline,synchronized:work.synchronized===true};
}
module.exports={playbackFor};
