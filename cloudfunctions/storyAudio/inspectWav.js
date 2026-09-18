function inspectWav(input) {
  const buffer=Buffer.isBuffer(input)?input:Buffer.from(input || []);
  if(buffer.length<44||buffer.toString('ascii',0,4)!=='RIFF'||buffer.toString('ascii',8,12)!=='WAVE')throw new Error('INVALID_WAV_HEADER');
  let offset=12,format,dataBytes;
  while(offset+8<=buffer.length) {
    const id=buffer.toString('ascii',offset,offset+4),size=buffer.readUInt32LE(offset+4),start=offset+8,end=start+size;
    if(end>buffer.length)throw new Error('INVALID_WAV_CHUNK');
    if(id==='fmt ') {
      if(size<16)throw new Error('INVALID_WAV_FORMAT');
      format={audioFormat:buffer.readUInt16LE(start),channels:buffer.readUInt16LE(start+2),sampleRate:buffer.readUInt32LE(start+4),byteRate:buffer.readUInt32LE(start+8),blockAlign:buffer.readUInt16LE(start+12),bitsPerSample:buffer.readUInt16LE(start+14)};
    } else if(id==='data')dataBytes=size;
    offset=end+(size%2);
  }
  if(!format||dataBytes===undefined||format.audioFormat!==1||!format.byteRate)throw new Error('INVALID_WAV_PCM');
  const expectedBlockAlign=format.channels*format.bitsPerSample/8;
  if(!Number.isInteger(expectedBlockAlign)||format.blockAlign!==expectedBlockAlign||format.byteRate!==format.sampleRate*expectedBlockAlign||dataBytes%expectedBlockAlign!==0)throw new Error('INVALID_WAV_PCM_LAYOUT');
  if(buffer.readUInt32LE(4)!==buffer.length-8)throw new Error('INVALID_WAV_RIFF_SIZE');
  return {durationMs:Math.round(dataBytes/format.byteRate*1000),bytes:buffer.length,format:'wav',channels:format.channels,bitsPerSample:format.bitsPerSample,sampleRate:format.sampleRate};
}

module.exports={inspectWav};
