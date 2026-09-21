import test,{afterEach,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {audioCreatePath,StoryAudioServiceError,storyAudioApi} from '../miniprogram/services/storyAudioService';

type Definition=Record<string,any>;
async function capture(path:string):Promise<Definition>{
  let definition:Definition|undefined;
  const previous=(globalThis as any).Page;
  (globalThis as any).Page=(value:Definition)=>{definition=value;};
  try{await import(path);}finally{(globalThis as any).Page=previous;}
  assert.ok(definition);return definition;
}
const instance=(definition:Definition):Definition=>{const page:Definition={...definition,data:structuredClone(definition.data)};page.setData=(patch:Record<string,unknown>)=>Object.assign(page.data,patch);return page;};
let voiceDefinition:Definition;
let createDefinition:Definition;
let playerDefinition:Definition;
let previousGetApp:unknown;

beforeEach(()=>{
  previousGetApp=(globalThis as any).getApp;
  (globalThis as any).getApp=()=>({globalData:{cloudReady:true,aiReady:true}});
});
afterEach(()=>{(globalThis as any).getApp=previousGetApp;});

test('audio pages live in a separate mini-program package',()=>{
  const app=JSON.parse(readFileSync('miniprogram/app.json','utf8'));
  const audio=app.subPackages.find((item:any)=>item.root==='packages/audio');
  assert.deepEqual(audio.pages.sort(),['pages/create/create','pages/player/player','pages/voices/voices']);
});

test('saved story, revision and chapter are all retained in the create route',()=>{
  const path=audioCreatePath({storyId:'story-a',revisionId:'revision-a',chapterId:'chapter-a'});
  assert.equal(path,'/packages/audio/pages/create/create?storyId=story-a&revisionId=revision-a&chapterId=chapter-a');
});

test('create page stays fail-closed when capabilities are disabled',async context=>{
  const toasts:string[]=[];let calls=0;
  const previous=(globalThis as any).wx;
  (globalThis as any).wx={cloud:{callFunction:async()=>{calls++;return {result:{apiVersion:1,provider:'tencent-cloud',voiceClone:{enabled:false,reason:'not_verified'},voiceEnrollment:{enabled:false,reason:'not_verified'},tts:{enabled:false,reason:'pricing_not_configured'},timestamps:{enabled:false},mixing:{enabled:false},video:{enabled:false},submission:{enabled:false,reason:'implementation_not_ready'},pricingVersion:null}};}},showToast:({title}:{title:string})=>toasts.push(title),navigateTo:()=>undefined};
  context.after(()=>{(globalThis as any).wx=previous;});
  const page=instance(createDefinition=await capture('../miniprogram/packages/audio/pages/create/create'));
  page.onLoad({storyId:'story-a',revisionId:'revision-a',chapterId:'chapter-a'});
  await page.refreshCapabilities();
  page.startCreate();
  assert.equal(calls,1);
  assert.equal(page.data.canCreate,false);
  assert.match(toasts[0],/费用配置|暂未开放|安全验证/);
});

test('audio release gate prevents cloud calls before the configured function is ready',async context=>{
  const previousWx=(globalThis as any).wx,previousGetApp=(globalThis as any).getApp;
  let calls=0;
  (globalThis as any).getApp=()=>({globalData:{cloudReady:true,aiReady:false}});
  (globalThis as any).wx={cloud:{callFunction:async()=>{calls+=1;return {result:{}};}}};
  context.after(()=>{(globalThis as any).wx=previousWx;(globalThis as any).getApp=previousGetApp;});
  await assert.rejects(storyAudioApi.capabilities(),(error:unknown)=>error instanceof StoryAudioServiceError&&error.code==='STORY_AUDIO_NOT_READY');
  assert.equal(calls,0);
});

test('create page submits the saved version once a selected voice is available',async context=>{
  const calls:any[]=[];const previous=(globalThis as any).wx;
  (globalThis as any).wx={cloud:{callFunction:async({data}:any)=>{calls.push(data);return data.action==='capabilities'?{result:{apiVersion:1,provider:'tencent-cloud',voiceClone:{enabled:true},voiceEnrollment:{enabled:true},tts:{enabled:true},timestamps:{enabled:true},mixing:{enabled:false},video:{enabled:false},submission:{enabled:true},pricingVersion:'test'}}:{result:{operation:{id:'family_audio-test',status:'queued',snapshot:{title:'第一章',bookTitle:'旧书'}}}};}},showToast:()=>undefined,navigateTo:()=>undefined};
  context.after(()=>{(globalThis as any).wx=previous;});
  const page=instance(createDefinition);
  page.onLoad({storyId:'story-a',revisionId:'revision-a',chapterId:'chapter-a'});await page.refreshCapabilities();
  page.setData({selectedVoice:{kind:'clone',id:'voice-a',label:'我的声音'}});
  await page.startCreate();
  const create=calls.find(call=>call.action==='create');
  assert.equal(create.storyId,'story-a');assert.equal(create.voice.id,'voice-a');assert.match(create.requestId,/^audio-/);
});

test('player releases its sole audio owner on hide and unload',async()=>{
  const page=instance(playerDefinition=await capture('../miniprogram/packages/audio/pages/player/player'));
  let destroyed=0;
  page.player={destroy:()=>{destroyed++;}};
  page.onHide();
  assert.equal(destroyed,1);assert.equal(page.player,undefined);
  page.onUnload();
  assert.equal(destroyed,1);
});

test('player accepts only a ready server playback contract and highlights its current cue',async context=>{
  const previous=(globalThis as any).wx;let onTime:undefined|(()=>void);
  const audio={src:'',currentTime:0,duration:2,play:()=>undefined,pause:()=>undefined,stop:()=>undefined,destroy:()=>undefined,seek:()=>undefined,onTimeUpdate:(fn:()=>void)=>{onTime=fn;},onPlay:()=>undefined,onPause:()=>undefined,onWaiting:()=>undefined,onCanplay:()=>undefined,onEnded:()=>undefined};
  (globalThis as any).wx={createInnerAudioContext:()=>audio,cloud:{callFunction:async()=>({result:{operation:{status:'ready',snapshot:{title:'第一章',bookTitle:'旧书'},playback:{audioUrl:'https://signed.example/work.wav',text:'第一句第二句',durationMs:2000,synchronized:true,timeline:[{text:'第一句',start:0,end:3,beginMs:0,endMs:900},{text:'第二句',start:3,end:6,beginMs:1000,endMs:1900}]}}}})}};
  context.after(()=>{(globalThis as any).wx=previous;});
  const page=instance(playerDefinition);page.onLoad({requestId:'audio-a'});await page.refresh();
  assert.equal(page.data.ready,true);assert.equal(page.data.lines.length,1);
  assert.equal(page.data.lines[0].text,'第一句第二句');
  audio.currentTime=1.2;onTime?.();
  assert.equal(page.data.lines[0].active,true);
  assert.equal(page.data.activeLineId,'story-line-0');
});

test('player keeps polling a queued narration and stops polling when hidden',async context=>{
  const previousWx=(globalThis as any).wx,previousSetTimeout=globalThis.setTimeout,previousClearTimeout=globalThis.clearTimeout;
  let scheduled:(()=>void)|undefined,calls=0,cleared=0;
  (globalThis as any).wx={
    cloud:{callFunction:async()=>{
      calls++;
      return {result:{operation:{status:'processing',snapshot:{title:'第一章',bookTitle:'旧书'}}}};
    }},
  };
  (globalThis as any).setTimeout=(callback:()=>void)=>{scheduled=callback;return 17;};
  (globalThis as any).clearTimeout=()=>{cleared++;};
  context.after(()=>{(globalThis as any).wx=previousWx;(globalThis as any).setTimeout=previousSetTimeout;(globalThis as any).clearTimeout=previousClearTimeout;});
  const page=instance(playerDefinition);page.onLoad({requestId:'audio-a'});page.hidden=false;await page.refresh();
  assert.equal(calls,1);assert.ok(scheduled);assert.match(page.data.notice,/制作/);
  page.onHide();scheduled?.();
  assert.equal(calls,1);assert.ok(cleared>=1);
});

test('voice page clears recording state when hidden',async()=>{
  const previous=(globalThis as any).wx;
  (globalThis as any).wx={getStorageSync:()=>undefined};
  try{
    voiceDefinition=await capture('../miniprogram/packages/audio/pages/voices/voices');
    const page=instance(voiceDefinition);
    page.data.recording=true;
    page.onHide();
    assert.equal(page.data.recording,false);
    assert.equal(page.hidden,true);
  }finally{(globalThis as any).wx=previous;}
});

test('voice page locks immediately so a double tap opens only one consent flow',async()=>{
  const previous=(globalThis as any).wx;
  let resolveModal:((value:{confirm:boolean})=>void)|undefined,modalCalls=0,cloudCalls=0;
  (globalThis as any).wx={
    getStorageSync:()=>undefined,setStorageSync:()=>undefined,
    showModal:({success}:{success:(value:{confirm:boolean})=>void})=>{modalCalls++;resolveModal=success;},
    cloud:{callFunction:async()=>{cloudCalls++;return {result:{}};}},showToast:()=>undefined,
  };
  try{
    const consent=await import('../miniprogram/services/voiceConsent');consent.clearVoiceConsent();
    const page=instance(voiceDefinition);
    page.data.available=true;page.data.voiceGender=1;page.accountScope='account-a';
    const first=page.beginRecording(),second=page.beginRecording();
    assert.equal(page.data.busy,true);assert.equal(modalCalls,1);
    resolveModal?.({confirm:false});
    await Promise.all([first,second]);
    assert.equal(cloudCalls,0);assert.equal(page.data.busy,false);
  }finally{(globalThis as any).wx=previous;}
});
