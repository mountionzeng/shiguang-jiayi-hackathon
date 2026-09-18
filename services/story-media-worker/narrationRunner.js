function createNarrationRunner({repo,processor,enabled=true,pollMs=2000,setTimer=setTimeout,clearTimer=clearTimeout,log=console}) {
  if(!repo||!processor)throw new Error('NARRATION_RUNNER_CONFIG_REQUIRED');
  let running=false,timer;
  async function runOnce() {
    const [operation]=await repo.listRunnableNarrations({limit:1});
    if(!operation)return false;
    await processor.process({operationId:operation.id,generation:operation.generation});
    return true;
  }
  const schedule=()=>{if(running)timer=setTimer(tick,pollMs);};
  async function tick(){if(!running)return;try{await runOnce();}catch(error){log.error('narration runner failed',{code:error?.code||'NARRATION_RUNNER_ERROR'});}schedule();}
  function start(){if(!enabled||running)return false;running=true;schedule();return true;}
  function stop(){running=false;if(timer!==undefined)clearTimer(timer);timer=undefined;}
  return {runOnce,start,stop,isRunning:()=>running};
}
module.exports={createNarrationRunner};
