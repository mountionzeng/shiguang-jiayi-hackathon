function validFile(file){return file&&typeof file.fileID==='string'&&file.fileID.startsWith('cloud://')&&Number.isFinite(file.bytes)&&file.bytes>0;}
async function publishWork({queue,claim,file,probe,work}) {
  if(!queue||!claim||!validFile(file)||typeof probe!=='function'||!work)throw new Error('成品媒体配置无效');
  const inspected=await probe(file.fileID);
  if(inspected?.format!=='mp4'||!inspected.hasVideo||!inspected.hasAudio||!Number.isFinite(inspected.durationMs)||inspected.durationMs<=0)throw new Error('成品媒体校验失败');
  if(Math.abs(inspected.durationMs-work.durationMs)>250)throw new Error('成品媒体时长不一致');
  return queue.complete(claim,{work:{...work,fileID:file.fileID,bytes:file.bytes,durationMs:inspected.durationMs,format:'mp4'}});
}
module.exports={publishWork};
