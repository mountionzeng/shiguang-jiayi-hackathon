import {AudioCue,currentCue} from '../domain/audioTimeline';

export interface NativeStoryAudio {
  src:string;currentTime:number;duration:number;
  play():void;pause():void;stop():void;destroy():void;seek(position:number):void;
  onTimeUpdate(callback:()=>void):void;onPlay(callback:()=>void):void;onPause(callback:()=>void):void;
  onWaiting(callback:()=>void):void;onCanplay(callback:()=>void):void;onEnded(callback:()=>void):void;
}
export interface StoryAudioPlaybackInput {url:string;durationMs:number;cues:AudioCue[]}
export interface StoryAudioProgress {positionMs:number;durationMs:number;cueIndex:number;playing:boolean;waiting:boolean}

/** One page owns exactly one native audio context. Its generation blocks late events from an old work. */
export class StoryAudioPlayer {
  private audio?:NativeStoryAudio;
  private generation=0;
  private input?:StoryAudioPlaybackInput;
  private playing=false;
  private waiting=false;

  constructor(private readonly createAudio:()=>NativeStoryAudio,private readonly onProgress:(progress:StoryAudioProgress)=>void) {}

  load(input:StoryAudioPlaybackInput):void {
    this.destroy();
    this.input={...input,cues:[...input.cues]};
    const generation=++this.generation,audio=this.createAudio();
    this.audio=audio;audio.src=input.url;
    audio.onTimeUpdate(()=>this.publish(generation));
    audio.onPlay(()=>{if(generation!==this.generation)return;this.playing=true;this.waiting=false;this.publish(generation);});
    audio.onPause(()=>{if(generation!==this.generation)return;this.playing=false;this.publish(generation);});
    audio.onWaiting(()=>{if(generation!==this.generation)return;this.waiting=true;this.publish(generation);});
    audio.onCanplay(()=>{if(generation!==this.generation)return;this.waiting=false;this.publish(generation);});
    audio.onEnded(()=>{if(generation!==this.generation)return;this.playing=false;this.waiting=false;this.publish(generation,true);});
    this.publish(generation);
  }

  play():void { this.audio?.play(); }
  pause():void { this.audio?.pause(); }
  seek(positionMs:number):void {
    if(!this.audio||!this.input)return;
    const safe=Math.max(0,Math.min(this.input.durationMs,Math.round(positionMs)));
    this.audio.seek(safe/1000);
    this.publish(this.generation);
  }
  seekToCue(index:number):void { const cue=this.input?.cues[index];if(cue)this.seek(cue.beginMs); }
  destroy():void {
    this.generation++;
    if(this.audio){this.audio.stop();this.audio.destroy();}
    this.audio=undefined;this.input=undefined;this.playing=false;this.waiting=false;
  }

  private publish(generation:number,atEnd=false):void {
    if(generation!==this.generation||!this.audio||!this.input)return;
    const durationMs=this.input.durationMs>0?this.input.durationMs:Math.max(0,Math.round(this.audio.duration*1000));
    const positionMs=atEnd?durationMs:Math.max(0,Math.min(durationMs,Math.round(this.audio.currentTime*1000)));
    const cue=currentCue(this.input.cues,positionMs);
    this.onProgress({positionMs,durationMs,cueIndex:cue?this.input.cues.indexOf(cue):-1,playing:this.playing,waiting:this.waiting});
  }
}
