/** Atomically fence all prior audio work before any files/records are removed. */
async function beginAudioCleanup(repo,familyId) {
  if(!repo||typeof repo.bumpAudioEpoch!=='function'||typeof repo.cancelAudioForFamily!=='function'||typeof repo.disableVoicesForFamily!=='function')throw new Error('AUDIO_CLEANUP_CONFIG_REQUIRED');
  const epoch=await repo.bumpAudioEpoch(familyId);
  await repo.cancelAudioForFamily(familyId,epoch);
  await repo.disableVoicesForFamily(familyId,epoch);
  return epoch;
}
module.exports={beginAudioCleanup};
