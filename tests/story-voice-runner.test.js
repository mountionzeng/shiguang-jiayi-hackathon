const test=require('node:test');
const assert=require('node:assert/strict');
const {createVoiceRunner}=require('../services/story-media-worker/voiceRunner');

test('voice runner processes one profile at a time and routes cleanup separately',async()=>{
  const jobs=[{familyId:'family-a',id:'voice-a',generation:1,status:'preparing_text'},{familyId:'family-a',id:'voice-b',generation:2,status:'deleting'}];
  const calls=[];
  const runner=createVoiceRunner({repo:{async listRunnableVoiceProfiles(){return jobs.splice(0,1);}},processor:{async process(job){calls.push(['process',job.profileId]);},async cleanup(job){calls.push(['cleanup',job.profileId]);}}});
  assert.equal(await runner.runOnce(),true);
  assert.equal(await runner.runOnce(),true);
  assert.equal(await runner.runOnce(),false);
  assert.deepEqual(calls,[['process','voice-a'],['cleanup','voice-b']]);
});

test('voice runner never overlaps ticks and keeps polling after an item fails',async()=>{
  const scheduled=[];let active=0,maxActive=0,items=2;
  const runner=createVoiceRunner({
    repo:{async listRunnableVoiceProfiles(){return items-- >0?[{familyId:'family-a',id:'voice-a',generation:1,status:'training'}]:[];}},
    processor:{async process(){active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;throw new Error('temporary');},async cleanup(){}},
    setTimer:fn=>{scheduled.push(fn);return scheduled.length;},clearTimer:()=>undefined,log:{error:()=>undefined},pollMs:1,
  });
  runner.start();assert.equal(scheduled.length,1);
  const first=scheduled.shift();await first();assert.equal(scheduled.length,1);
  const second=scheduled.shift();await second();
  assert.equal(maxActive,1);assert.equal(scheduled.length,1);
  runner.stop();
});

test('voice runner refuses to start when the production gate is closed',()=>{
  const runner=createVoiceRunner({enabled:false,repo:{},processor:{}});
  assert.equal(runner.start(),false);
});
