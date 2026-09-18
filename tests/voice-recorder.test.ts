import test from 'node:test';
import assert from 'node:assert/strict';

test('voice recorder enforces sample boundaries and Tencent WAV options',async context=>{
  const previous=(globalThis as any).wx;
  let options:Record<string,unknown>|undefined;
  let stopHandler:(value:any)=>void=()=>undefined;
  const manager={
    onStop(handler:(value:any)=>void){stopHandler=handler;},
    onError(){},onInterruptionBegin(){},
    start(value:Record<string,unknown>){options=value;},stop(){stopHandler({tempFilePath:'/tmp/voice.wav',duration:6000,fileSize:1000});},
  };
  (globalThis as any).wx={getRecorderManager:()=>manager};
  context.after(()=>{(globalThis as any).wx=previous;});
  const recorder=await import('../miniprogram/services/voiceRecorder');
  assert.throws(()=>recorder.validateRecordedVoiceSample({tempFilePath:'/tmp/a.wav',duration:5000,fileSize:100}),/大于 5 秒/);
  assert.throws(()=>recorder.validateRecordedVoiceSample({tempFilePath:'/tmp/a.wav',duration:15000,fileSize:100}),/大于 5 秒/);
  assert.doesNotThrow(()=>recorder.validateRecordedVoiceSample({tempFilePath:'/tmp/a.wav',duration:5001,fileSize:100}));
  assert.doesNotThrow(()=>recorder.validateRecordedVoiceSample({tempFilePath:'/tmp/a.wav',duration:14999,fileSize:100}));
  assert.throws(()=>recorder.validateRecordedVoiceSample({tempFilePath:'/tmp/a.wav',duration:6000,fileSize:2*1024*1024+1}),/2MB/);
  const pending=recorder.recordVoiceSample();
  assert.deepEqual(options,{duration:14000,sampleRate:24000,numberOfChannels:1,encodeBitRate:96000,format:'wav'});
  recorder.stopVoiceRecording();
  assert.equal((await pending).duration,6000);
});
