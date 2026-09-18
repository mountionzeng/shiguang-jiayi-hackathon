/** start/end use Unicode code-point offsets, matching provider cue normalization. */
export interface NarrationPart { text:string; start:number; end:number }
export interface AudioCue extends NarrationPart { beginMs:number; endMs:number }
export interface ReadingLine {text:string;cueIndex:number;endCueIndex:number}

/** Group provider word cues for reading; playback still uses the original clock. */
export function readingLines(text:string,cues:AudioCue[]):ReadingLine[]{
  const chars=Array.from(text),lines:ReadingLine[]=[];
  let start=0,firstCue=0;
  cues.forEach((cue,index)=>{
    const last=index===cues.length-1;
    if(!last&&!/[。！？!?；;\n][”’」』]*$/u.test(cue.text)&&cue.end-start<48)return;
    const end=last?chars.length:cue.end;
    lines.push({text:chars.slice(start,end).join(''),cueIndex:firstCue,endCueIndex:index});
    start=end;firstCue=index+1;
  });
  return lines;
}

export function splitNarration(value:string,maxCodePoints=150):NarrationPart[]{
  if(!Number.isInteger(maxCodePoints)||maxCodePoints<10)throw new Error('朗读分段上限无效');
  const chars=Array.from(value),breaks=new Set(['。','！','？','!','?','；',';','\n']),parts:NarrationPart[]=[];let start=0;
  while(start<chars.length){
    const hard=Math.min(start+maxCodePoints,chars.length);let end=hard;
    if(hard<chars.length){
      const minimum=start+Math.floor((hard-start)*0.45);
      for(let index=hard-1;index>=minimum;index--){if(breaks.has(chars[index])){end=index+1;break;}}
    }
    parts.push({text:chars.slice(start,end).join(''),start,end});start=end;
  }
  return parts;
}

export function shiftCues(cues:AudioCue[],offsetMs:number,textOffset=0):AudioCue[]{return cues.map(cue=>({...cue,beginMs:cue.beginMs+offsetMs,endMs:cue.endMs+offsetMs,start:cue.start+textOffset,end:cue.end+textOffset}));}
export function validateTimeline(cues:AudioCue[]):boolean{return cues.every((cue,index)=>Number.isFinite(cue.beginMs)&&Number.isFinite(cue.endMs)&&cue.beginMs>=0&&cue.endMs>cue.beginMs&&cue.start>=0&&cue.end>cue.start&&(index===0||cue.beginMs>=cues[index-1].endMs)&&(index===0||cue.start>=cues[index-1].end));}
export function currentCue(cues:AudioCue[],positionMs:number):AudioCue|undefined{return cues.find(cue=>positionMs>=cue.beginMs&&positionMs<cue.endMs);}
