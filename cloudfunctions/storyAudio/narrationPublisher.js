const crypto=require('node:crypto');
const {concatWav,inspectWav}=require('./wav');

const MAX_SEGMENT_BYTES=20*1024*1024;
const MAX_WORK_BYTES=50*1024*1024;
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');

function createNarrationPublisher({storage}) {
  if(!storage||typeof storage.readFile!=='function'||typeof storage.write!=='function')throw new Error('NARRATION_PUBLISHER_CONFIG_REQUIRED');
  return {
    async publish({operation,segments,narration}) {
      const ordered=[...segments].sort((left,right)=>left.index-right.index);
      if(!ordered.length||ordered.some(segment=>typeof segment.fileID!=='string'||!segment.fileID.startsWith('cloud://')))throw Object.assign(new Error('朗读片段尚未准备好'),{code:'TTS_SEGMENTS_MISSING'});
      const buffers=[];let total=0;
      for(const segment of ordered){
        const buffer=await storage.readFile(segment.fileID,{maxBytes:MAX_SEGMENT_BYTES});
        total+=buffer.length;if(total>MAX_WORK_BYTES)throw Object.assign(new Error('有声作品过大'),{code:'TTS_WORK_TOO_LARGE'});
        buffers.push(buffer);
      }
      const audio=concatWav(buffers),inspection=inspectWav(audio);
      if(inspection.sampleRate!==16000||inspection.channels!==1||inspection.bitsPerSample!==16)throw Object.assign(new Error('有声作品格式无效'),{code:'TTS_WORK_INVALID'});
      const family=hash(operation.familyId).slice(0,24),key=hash(`${operation.id}:${operation.generation}:${operation.snapshot.digest}:${JSON.stringify(operation.voice)}`).slice(0,40);
      const written=await storage.write(`story-audio/works/${family}/${key}.wav`,audio,{contentType:'audio/wav',private:true});
      if(typeof written?.fileID!=='string'||!written.fileID.startsWith('cloud://'))throw Object.assign(new Error('有声作品没有保存成功'),{code:'TTS_WORK_STORE_FAILED'});
      return {fileID:written.fileID,bytes:inspection.bytes,format:'wav',text:operation.snapshot.text,durationMs:inspection.durationMs,timeline:narration.timeline,synchronized:narration.synchronized===true};
    },
  };
}

module.exports={createNarrationPublisher};
