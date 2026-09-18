function frameAt(timeline,positionMs) {
  if(!Array.isArray(timeline)||!Number.isFinite(positionMs))return undefined;
  return timeline.find(cue=>cue&&Number.isFinite(cue.beginMs)&&Number.isFinite(cue.endMs)&&positionMs>=cue.beginMs&&positionMs<cue.endMs);
}
function workPath(value){return typeof value==='string'&&value.startsWith('/work/')&&!value.includes('..');}
function videoArgs({frames,audio,output,fps=25}) {
  if(!workPath(frames)||!workPath(audio)||!workPath(output)||!Number.isInteger(fps)||fps<20||fps>30)throw new Error('视频工作目录或帧率无效');
  return ['-y','-framerate',String(fps),'-i',frames,'-i',audio,'-map','0:v:0','-map','1:a:0','-vf','scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',output];
}
module.exports={frameAt,videoArgs};
