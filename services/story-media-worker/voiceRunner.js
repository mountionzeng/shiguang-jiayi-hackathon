const DELETION_STATUSES=new Set(['deleting','deletion_pending_provider','deletion_pending_sample']);

function createVoiceRunner({repo,processor,enabled=true,pollMs=2000,setTimer=setTimeout,clearTimer=clearTimeout,log=console}) {
  if(!repo||!processor)throw new Error('VOICE_RUNNER_CONFIG_REQUIRED');
  let running=false,timer;

  async function runOnce() {
    const [profile]=await repo.listRunnableVoiceProfiles({limit:1});
    if(!profile)return false;
    const job={familyId:profile.familyId,profileId:profile.id,generation:profile.generation};
    if(DELETION_STATUSES.has(profile.status))await processor.cleanup(job);
    else await processor.process(job);
    return true;
  }

  const schedule=()=>{if(running)timer=setTimer(tick,pollMs);};
  async function tick(){
    if(!running)return;
    try{await runOnce();}catch(error){log.error('voice runner failed',{code:error?.code||'VOICE_RUNNER_ERROR'});}
    schedule();
  }
  function start(){if(!enabled||running)return false;running=true;schedule();return true;}
  function stop(){running=false;if(timer!==undefined)clearTimer(timer);timer=undefined;}
  return {runOnce,start,stop,isRunning:()=>running};
}

module.exports={createVoiceRunner,DELETION_STATUSES};
