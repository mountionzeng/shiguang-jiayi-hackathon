const test=require('node:test');
const assert=require('node:assert/strict');
const {buildMixPlan,ffmpegMixArgs,runFfmpeg,workKeys}=require('../services/story-media-worker/mix');
const {frameAt,videoArgs}=require('../services/story-media-worker/render');
const {publishWork}=require('../services/story-media-worker/storage');

test('mix plan loops a short licensed background without changing narration identity',()=>{
  const base={accountId:'account-a',textDigest:'text-a',voiceVersion:'voice-a',speed:0};
  const keys=workKeys(base,{id:'warm-room-v1',volume:.12},'template-v1');
  assert.equal(keys.narration,workKeys(base,{id:'other',volume:.3},'template-v1').narration);
  assert.notEqual(keys.mix,workKeys(base,{id:'other',volume:.3},'template-v1').mix);
  const plan=buildMixPlan({voiceFiles:['/private/one.wav','/private/two.wav'],durationMs:3100,background:{file:'/licensed/warm.mp3',durationMs:900,volume:.12}});
  assert.deepEqual(plan.inputs,['/private/one.wav','/private/two.wav','/licensed/warm.mp3']);
  assert.match(plan.filter,/aloop=loop=-1:size=43200/);
  assert.match(plan.filter,/volume=0.12/);
});

test('mix plan rejects user URLs and unsafe filesystem paths',()=>{
  assert.throws(()=>buildMixPlan({voiceFiles:['https://attacker.example/a.wav'],durationMs:1000}),/私有媒体/);
  assert.throws(()=>buildMixPlan({voiceFiles:['/private/a.wav'],durationMs:1000,background:{file:'/tmp/a.mp3',durationMs:1000,volume:.1}}),/授权背景音/);
});

test('FFmpeg is invoked with an argument array and normalized WAV output',async()=>{
  const plan=buildMixPlan({voiceFiles:['/private/a.wav'],durationMs:1000});
  const args=ffmpegMixArgs(plan,{inputs:['/work/a.wav'],output:'/work/mixed.wav'});
  assert.deepEqual(args.slice(0,4),['-y','-i','/work/a.wav','-filter_complex']);
  assert.ok(args.includes('-ac'));assert.ok(args.includes('1'));assert.ok(args.includes('24000'));
  let received;await runFfmpeg(args,{spawn:(_bin,input)=>{received=input;return Promise.resolve();}});
  assert.equal(received,args);
});

test('video renderer uses the portable timeline and fixed vertical MP4 contract',()=>{
  const timeline=[{text:'第一句',beginMs:0,endMs:900},{text:'第二句',beginMs:1000,endMs:1900}];
  assert.equal(frameAt(timeline,1200).text,'第二句');
  assert.equal(frameAt(timeline,950),undefined);
  const args=videoArgs({frames:'/work/frames/%06d.png',audio:'/work/mixed.wav',output:'/work/story.mp4',fps:25});
  assert.deepEqual(args.slice(0,6),['-y','-framerate','25','-i','/work/frames/%06d.png','-i']);
  assert.match(args[args.indexOf('-vf')+1],/720:1280/);assert.ok(args.includes('libx264'));assert.ok(args.includes('aac'));
});

test('completed media is published only after probe validation and matching fencing claim',async()=>{
  const calls=[];const queue={async complete(claim,result){calls.push({claim,result});return true;}};
  const accepted=await publishWork({queue,claim:{id:'job-a',generation:2,fencingToken:4},file:{fileID:'cloud://private/work.mp4',bytes:123},probe:async()=>({format:'mp4',durationMs:1200,hasVideo:true,hasAudio:true}),work:{text:'第一句',timeline:[],synchronized:false,durationMs:1200}});
  assert.equal(accepted,true);assert.equal(calls[0].result.work.fileID,'cloud://private/work.mp4');
  await assert.rejects(publishWork({queue,claim:{},file:{fileID:'https://bad',bytes:1},probe:async()=>({})}),/成品媒体/);
});
