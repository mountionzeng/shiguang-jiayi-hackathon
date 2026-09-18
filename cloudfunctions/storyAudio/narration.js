const {StoryAudioError}=require('./core');
const fail=(code,message)=>{throw new StoryAudioError(code,message);};
const BREAKS=new Set(['。','！','？','!','?','；',';','\n']);

function splitNarration(value,maxCodePoints=150) {
  if(typeof value!=='string'||!value.trim())fail('EMPTY_NARRATION','没有可以朗读的文字');
  if(!Number.isInteger(maxCodePoints)||maxCodePoints<10||maxCodePoints>150)fail('INVALID_INPUT','朗读分段上限无效');
  const chars=Array.from(value),parts=[];let start=0;
  while(start<chars.length){
    const hard=Math.min(start+maxCodePoints,chars.length);let end=hard;
    if(hard<chars.length){
      const minimum=start+Math.floor((hard-start)*0.45);
      for(let index=hard-1;index>=minimum;index--){if(BREAKS.has(chars[index])){end=index+1;break;}}
    }
    parts.push({index:parts.length,text:chars.slice(start,end).join(''),start,end});start=end;
  }
  return parts;
}

module.exports={splitNarration};
