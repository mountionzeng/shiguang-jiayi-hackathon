const test=require('node:test');
const assert=require('node:assert/strict');
const {createQueue}=require('../services/story-media-worker/queue');

function fixture() {
  const jobs=new Map([['job-1',{id:'job-1',status:'queued',generation:2,updatedAtMs:0}]]);
  const repo={
    async listClaimable(){return [...jobs.values()].filter(job=>job.status==='queued'||(job.status==='claimed'&&job.leaseExpiresAtMs<=1000));},
    async compareAndSet(id,expected,patch){const current=jobs.get(id);if(!current||Object.entries(expected).some(([key,value])=>current[key]!==value))return false;jobs.set(id,{...current,...patch});return true;},
    async get(id){return jobs.get(id);},
  };
  return {jobs,queue:createQueue({repo,workerId:'worker-a',nowMs:()=>1000,leaseMs:500})};
}

test('claim issues a fencing token and only one worker can take a queued job',async()=>{
  const {jobs,queue}=fixture();
  const claimed=await queue.claimNext();
  assert.equal(claimed.fencingToken,1);
  assert.equal(claimed.leaseOwner,'worker-a');
  assert.equal(await queue.claimNext(),undefined);
  assert.equal(jobs.get('job-1').status,'claimed');
});

test('expired owner cannot complete after a newer claim',async()=>{
  const {jobs,queue}=fixture();
  const first=await queue.claimNext();
  jobs.set('job-1',{...jobs.get('job-1'),leaseExpiresAtMs:999});
  const second=await queue.claimNext();
  assert.equal(second.fencingToken,2);
  assert.equal(await queue.complete(first,{resultKey:'old'}),false);
  assert.equal(await queue.complete(second,{resultKey:'new'}),true);
  assert.equal(jobs.get('job-1').resultKey,'new');
});

test('generation change prevents a disabled voice job from being accepted',async()=>{
  const {jobs,queue}=fixture();
  const claim=await queue.claimNext();
  jobs.set('job-1',{...jobs.get('job-1'),generation:3});
  assert.equal(await queue.complete(claim,{resultKey:'late'}),false);
  assert.equal(jobs.get('job-1').resultKey,undefined);
});
