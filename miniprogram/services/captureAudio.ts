import type {ImportFileLike} from './memoryImport';
let manager: WechatMiniprogram.RecorderManager | undefined;
let pending: {resolve:(file:ImportFileLike)=>void;reject:(error:Error)=>void} | undefined;
function recorder() {
  if(manager)return manager;
  manager=wx.getRecorderManager();
  manager.onStop(result=>{
    const current=pending;pending=undefined;
    if(!result.fileSize || result.fileSize>8*1024*1024) {current?.reject(new Error('录音为空或超过8MB'));return;}
    current?.resolve({name:`录音-${Date.now()}.mp3`,path:result.tempFilePath,size:result.fileSize,type:'audio'});
  });
  manager.onError(err=>{const current=pending;pending=undefined;current?.reject(new Error(err.errMsg || '录音失败'));});
  manager.onInterruptionBegin(()=>{const current=pending;pending=undefined;manager?.stop();current?.reject(new Error('录音被系统中断，之前的素材仍保留'));});
  return manager;
}
/** Ordinary memory input, deliberately independent of voice-clone sampling. */
export async function recordCaptureAudio():Promise<ImportFileLike> {
  if(pending)throw new Error('请先结束当前录音');
  await new Promise<void>((resolve,reject)=>wx.authorize({scope:'scope.record',success:()=>resolve(),fail:()=>reject(new Error('未获得麦克风权限，也可以从微信聊天选择录音文件'))}));
  return new Promise((resolve,reject)=>{
    pending={resolve,reject};
    try {recorder().start({duration:600000,sampleRate:16000,numberOfChannels:1,encodeBitRate:64000,format:'mp3'});}
    catch(err){pending=undefined;reject(err);}
  });
}
export function stopCaptureAudio(){if(pending)recorder().stop();}
export function cancelCaptureAudio(){const current=pending;pending=undefined;if(current){manager?.stop();current.reject(new Error('录音已取消'));}}
