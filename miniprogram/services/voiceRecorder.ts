export interface RecordedVoiceSample {tempFilePath:string;duration:number;fileSize:number}

let manager:WechatMiniprogram.RecorderManager|undefined;
let pending:{resolve:(value:RecordedVoiceSample)=>void;reject:(error:Error)=>void}|undefined;

function recorder(){
  if(manager)return manager;
  manager=wx.getRecorderManager();
  manager.onStop(result=>{const current=pending;pending=undefined;current?.resolve({tempFilePath:result.tempFilePath,duration:result.duration,fileSize:result.fileSize});});
  manager.onError(error=>{const current=pending;pending=undefined;current?.reject(new Error(String((error as {errMsg?:string}).errMsg||'录音失败，请检查麦克风权限')));});
  manager.onInterruptionBegin(()=>{const current=pending;pending=undefined;manager?.stop();current?.reject(new Error('录音被通话或系统音频中断，请重新录制'));});
  return manager;
}

export function validateRecordedVoiceSample(sample:RecordedVoiceSample){
  if(!sample.tempFilePath||sample.duration<=5000||sample.duration>=15000)throw new Error('请录制大于 5 秒、小于 15 秒的声音');
  if(!Number.isFinite(sample.fileSize)||sample.fileSize<=0||sample.fileSize>2*1024*1024)throw new Error('录音需小于 2MB，请重新录制');
  return sample;
}

export function recordVoiceSample():Promise<RecordedVoiceSample>{
  if(pending)return Promise.reject(new Error('正在录音，请先结束本次录音'));
  return new Promise((resolve,reject)=>{
    pending={resolve,reject};
    try{recorder().start({duration:14000,sampleRate:24000,numberOfChannels:1,encodeBitRate:96000,format:'wav'});}
    catch(error){pending=undefined;reject(error instanceof Error?error:new Error('无法开始录音'));}
  });
}
export function stopVoiceRecording(){if(pending)recorder().stop();}
