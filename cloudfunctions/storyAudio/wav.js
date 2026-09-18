function chunks(input) {
  const buffer=Buffer.isBuffer(input)?input:Buffer.from(input||[]);
  if(buffer.length<44||buffer.toString('ascii',0,4)!=='RIFF'||buffer.toString('ascii',8,12)!=='WAVE')throw new Error('INVALID_WAV_HEADER');
  let offset=12,format,data;
  while(offset+8<=buffer.length){
    const id=buffer.toString('ascii',offset,offset+4),size=buffer.readUInt32LE(offset+4),start=offset+8,end=start+size;
    if(end>buffer.length)throw new Error('INVALID_WAV_CHUNK');
    if(id==='fmt '){
      if(size<16)throw new Error('INVALID_WAV_FORMAT');
      format={audioFormat:buffer.readUInt16LE(start),channels:buffer.readUInt16LE(start+2),sampleRate:buffer.readUInt32LE(start+4),byteRate:buffer.readUInt32LE(start+8),blockAlign:buffer.readUInt16LE(start+12),bitsPerSample:buffer.readUInt16LE(start+14)};
    }else if(id==='data')data=buffer.subarray(start,end);
    offset=end+(size%2);
  }
  if(!format||!data||format.audioFormat!==1||!format.byteRate)throw new Error('INVALID_WAV_PCM');
  const expectedBlockAlign=format.channels*format.bitsPerSample/8;
  if(!Number.isInteger(expectedBlockAlign)||format.blockAlign!==expectedBlockAlign||format.byteRate!==format.sampleRate*expectedBlockAlign||data.length%expectedBlockAlign!==0)throw new Error('INVALID_WAV_PCM_LAYOUT');
  return {format,data};
}

function inspectWav(input) {
  const buffer=Buffer.isBuffer(input)?input:Buffer.from(input||[]),parsed=chunks(buffer);
  return {durationMs:Math.round(parsed.data.length/parsed.format.byteRate*1000),bytes:buffer.length,format:'wav',channels:parsed.format.channels,bitsPerSample:parsed.format.bitsPerSample,sampleRate:parsed.format.sampleRate};
}

function concatWav(inputs) {
  if(!Array.isArray(inputs)||inputs.length===0)throw new Error('WAV_INPUT_REQUIRED');
  const parsed=inputs.map(chunks),first=parsed[0].format;
  if(parsed.some(item=>item.format.audioFormat!==first.audioFormat||item.format.channels!==first.channels||item.format.sampleRate!==first.sampleRate||item.format.bitsPerSample!==first.bitsPerSample))throw new Error('WAV_FORMAT_MISMATCH');
  const data=Buffer.concat(parsed.map(item=>item.data)),output=Buffer.alloc(44+data.length);
  output.write('RIFF',0);output.writeUInt32LE(36+data.length,4);output.write('WAVE',8);output.write('fmt ',12);output.writeUInt32LE(16,16);output.writeUInt16LE(first.audioFormat,20);output.writeUInt16LE(first.channels,22);output.writeUInt32LE(first.sampleRate,24);output.writeUInt32LE(first.byteRate,28);output.writeUInt16LE(first.blockAlign,32);output.writeUInt16LE(first.bitsPerSample,34);output.write('data',36);output.writeUInt32LE(data.length,40);data.copy(output,44);
  return output;
}

module.exports={concatWav,inspectWav};
