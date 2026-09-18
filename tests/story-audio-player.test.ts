import test from 'node:test';
import assert from 'node:assert/strict';
import {AudioCue} from '../miniprogram/domain/audioTimeline';
import {StoryAudioPlayer} from '../miniprogram/services/storyAudioPlayer';
import {saveStoryVideo} from '../miniprogram/services/storyAudioService';

class FakeAudio {
  src='';currentTime=0;duration=3;destroyed=false;stopped=false;played=false;paused=false;
  time?:()=>void;playEvent?:()=>void;pauseEvent?:()=>void;waiting?:()=>void;canplay?:()=>void;ended?:()=>void;
  play(){this.played=true;this.playEvent?.();} pause(){this.paused=true;this.pauseEvent?.();} stop(){this.stopped=true;} destroy(){this.destroyed=true;}
  seek(value:number){this.currentTime=value;this.time?.();}
  onTimeUpdate(callback:()=>void){this.time=callback;} onPlay(callback:()=>void){this.playEvent=callback;} onPause(callback:()=>void){this.pauseEvent=callback;}
  onWaiting(callback:()=>void){this.waiting=callback;} onCanplay(callback:()=>void){this.canplay=callback;} onEnded(callback:()=>void){this.ended=callback;}
}

const cues:AudioCue[]=[
  {text:'第一句',start:0,end:3,beginMs:0,endMs:900},
  {text:'第二句',start:3,end:6,beginMs:1000,endMs:1900},
];

test('player uses actual audio time for cue selection, pause and seek',()=>{
  const audio=new FakeAudio(),updates:any[]=[];
  const player=new StoryAudioPlayer(()=>audio,progress=>updates.push(progress));
  player.load({url:'https://signed.example/audio.wav',durationMs:3000,cues});
  player.play();
  audio.currentTime=1.2;audio.time?.();
  assert.deepEqual(updates[updates.length-1],{positionMs:1200,durationMs:3000,cueIndex:1,playing:true,waiting:false});
  player.pause();
  assert.equal(updates[updates.length-1].playing,false);
  player.seekToCue(0);
  assert.equal(audio.currentTime,0);
});

test('late callbacks from a replaced audio instance cannot overwrite the current story',()=>{
  const first=new FakeAudio(),second=new FakeAudio(),updates:any[]=[];let index=0;
  const player=new StoryAudioPlayer(()=>[first,second][index++],progress=>updates.push(progress));
  player.load({url:'https://signed.example/a.wav',durationMs:3000,cues});
  player.load({url:'https://signed.example/b.wav',durationMs:3000,cues});
  first.currentTime=1.2;first.time?.();
  assert.equal(updates[updates.length-1].positionMs,0);
  assert.equal(first.destroyed,true);
  second.currentTime=1.2;second.time?.();
  assert.equal(updates[updates.length-1].positionMs,1200);
});

test('destroy stops and releases the only native audio instance',()=>{
  const audio=new FakeAudio(),player=new StoryAudioPlayer(()=>audio,()=>undefined);
  player.load({url:'https://signed.example/audio.wav',durationMs:3000,cues});
  player.destroy();
  assert.equal(audio.stopped,true);assert.equal(audio.destroyed,true);
});

test('video delivery downloads the already-finished private work and retries without regeneration',async()=>{
  const calls:string[]=[];const wxMock:any={downloadFile:({success}:any)=>{calls.push('download');success({statusCode:200,tempFilePath:'/tmp/story.mp4'});},saveVideoToPhotosAlbum:({success}:any)=>{calls.push('save');success();}};
  await saveStoryVideo('https://signed.example/story.mp4',wxMock);
  assert.deepEqual(calls,['download','save']);
  await assert.rejects(saveStoryVideo('https://bad.example/story.mp4',wxMock),/播放地址/);
});
