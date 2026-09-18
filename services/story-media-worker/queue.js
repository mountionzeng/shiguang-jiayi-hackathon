function createQueue({repo,workerId,nowMs=Date.now,leaseMs=60_000}) {
  if(!repo||!workerId)throw new Error('QUEUE_CONFIG_REQUIRED');

  async function claimNext() {
    const now=nowMs(), candidates=await repo.listClaimable({nowMs:now,limit:10});
    for(const candidate of candidates) {
      const expected={status:candidate.status};
      if(candidate.status==='claimed')expected.leaseExpiresAtMs=candidate.leaseExpiresAtMs;
      const fencingToken=Number(candidate.fencingToken || 0)+1;
      const claimed={
        status:'claimed',leaseOwner:workerId,leaseExpiresAtMs:now+leaseMs,
        fencingToken,claimedAtMs:now,updatedAtMs:now,
      };
      if(await repo.compareAndSet(candidate.id,expected,claimed))return {...candidate,...claimed};
    }
    return undefined;
  }

  async function renew(claim) {
    const now=nowMs();
    return repo.compareAndSet(claim.id,{status:'claimed',leaseOwner:workerId,fencingToken:claim.fencingToken,generation:claim.generation},{leaseExpiresAtMs:now+leaseMs,updatedAtMs:now});
  }

  async function complete(claim,result) {
    const now=nowMs();
    return repo.compareAndSet(claim.id,{status:'claimed',leaseOwner:workerId,fencingToken:claim.fencingToken,generation:claim.generation},{...result,status:'ready',completedAtMs:now,updatedAtMs:now,leaseExpiresAtMs:null});
  }

  async function fail(claim,error) {
    const now=nowMs();
    return repo.compareAndSet(claim.id,{status:'claimed',leaseOwner:workerId,fencingToken:claim.fencingToken,generation:claim.generation},{status:'failed',error:{code:error?.code || 'WORKER_ERROR',message:'媒体处理失败，请稍后重试'},updatedAtMs:now,leaseExpiresAtMs:null});
  }

  return {claimNext,renew,complete,fail};
}

module.exports={createQueue};
