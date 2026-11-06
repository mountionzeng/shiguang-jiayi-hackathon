const test=require('node:test');const assert=require('node:assert/strict');
const {createMusicService,safeAudioUrl,mp3Duration}=require('../cloudfunctions/storyAudio/music');
const {validateAudioModules,approveAudioModules}=require('../cloudfunctions/storyBooks/articleAudio');
const blockId='block-'+'a'.repeat(64),ctx={familyId:'family-test',openid:'owner'};
const input={requestId:'audio-test123',storyId:'story-test',revisionId:'revision-test',chapterId:'chapter-test',blockId};
function setup(){
 const records=new Map();let calls=0,failStore=false;
 const bytes=Buffer.alloc(417*40);for(let i=0;i<40;i++)bytes.writeUInt32BE(0xfffb9000,i*417);
 const revision={id:input.revisionId,storyId:input.storyId,draft:{title:'Title',chapters:[{id:input.chapterId,title:'Chapter',content:[{blockId,text:'Quiet rainy street'},{blockId:'block-'+'b'.repeat(64),text:'Other text'}]}]}};
 const repo={getOperation:async id=>records.get(id),getStory:async()=>({id:input.storyId,currentRevisionId:input.revisionId}),getRevision:async()=>revision,createOperation:async(id,op)=>{if(records.has(id))return false;records.set(id,structuredClone(op));return true;}};
 const workerRepo={assertNarrationSource:async()=>{},updateOperation:async(id,expected,patch)=>{const current=records.get(id);if(Object.entries(expected).some(([k,v])=>current[k]!==v))return false;records.set(id,{...current,...patch});return true;}};
 const service=createMusicService({repo,workerRepo,env:{STORY_MUSIC_ENABLED:'true',STORY_MUSIC_302_KEY:'test'},storage:{write:async()=>{if(failStore)throw Error('disk');return {fileID:'cloud://env/music.mp3'};}},fetchBytes:async(url,options)=>{
  if(options.body){calls++;const body=JSON.parse(options.body);assert.ok(body.prompt.includes('Quiet rainy street'));assert.ok(!body.prompt.includes('Other text'));assert.equal(body.lyrics,'[Intro]\n[Inst]\n[Outro]');assert.equal(body.aigc_watermark,undefined);return Buffer.from(JSON.stringify({data:{audio_url:'https://file.302.ai/music.mp3'}}));}
  return bytes;
 }});
 return {service,repo,records,calls:()=>calls,failStore:value=>{failStore=value;},bytes};
}
test('music snapshots one block and concurrent polls submit one paid request',async()=>{
 const f=setup(),{operation}=await f.service.create(ctx,input);
 await Promise.all([f.service.process(operation),f.service.process(operation)]);
 assert.equal(f.calls(),1);assert.equal((await f.repo.getOperation(operation.id)).status,'storing');
 await f.service.process(await f.repo.getOperation(operation.id));assert.equal((await f.repo.getOperation(operation.id)).status,'ready');
 assert.equal((await f.service.create(ctx,input)).operation.status,'ready');assert.equal(f.calls(),1);
});
test('failed audio storage retries download without paying again',async()=>{
 const f=setup(),{operation}=await f.service.create(ctx,input);f.failStore(true);
 const storing=await f.service.process(operation);assert.equal(storing.status,'storing');
 assert.equal((await f.service.process(storing)).status,'storing');f.failStore(false);
 assert.equal((await f.service.process(storing)).status,'ready');assert.equal(f.calls(),1);
});
test('audio downloads reject untrusted destinations and require real MP3 frames',()=>{
 for(const url of ['http://file.302.ai/a','https://localhost/a','https://evil.example/a','https://file.302.ai:8443/a','https://user@file.302.ai/a'])assert.throws(()=>safeAudioUrl(url));
 assert.throws(()=>mp3Duration(Buffer.from('not audio')));assert.ok(mp3Duration(setup().bytes)>1000);
});
test('new chapter audio cannot point at another owner or another source block',async()=>{
 const module={id:'audio-test123',operationId:'family_owner_audio-test123',afterBlockId:blockId,kind:'music'};
 const after={id:'chapter-test',content:[{blockId,text:'source'}],audioModules:[module]};validateAudioModules(after);
 const repo={get:async()=>({familyId:'family-other',storyId:'story-test',chapterId:'chapter-test',blockId,status:'ready',kind:'music',work:{fileID:'cloud://f'}})};
 await assert.rejects(()=>approveAudioModules(repo,{familyId:'family_owner'},'story-test',{content:[]},after));
});
