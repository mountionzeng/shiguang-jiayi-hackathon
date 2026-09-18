const RUNNABLE_VOICE_STATUSES=['preparing_text','sample_registered','detected','submitting','training','deleting','deletion_pending_provider','deletion_pending_sample'];
const documentId=(familyId,profileId)=>`${familyId}_${profileId}`;
const withoutId=value=>{const {_id,...data}=value;return data;};

function createVoiceWorkerRepository({db,command}) {
  if(!db||!command?.in)throw new Error('VOICE_REPOSITORY_CONFIG_REQUIRED');
  const collection=()=>db.collection('voice_profiles');
  return {
    async listRunnableVoiceProfiles({limit=1}={}) {
      const response=await collection().where({status:command.in(RUNNABLE_VOICE_STATUSES)}).orderBy('updatedAt','asc').limit(Math.max(1,Math.min(10,limit))).get();
      return response.data||[];
    },
    async getVoiceProfile(familyId,profileId) {
      try{const profile=(await collection().doc(documentId(familyId,profileId)).get()).data;return profile?.familyId===familyId&&profile?.id===profileId?profile:undefined;}
      catch(error){if(/not found|does not exist/i.test(String(error?.message||error?.errMsg||error)))return undefined;throw error;}
    },
    async updateVoiceProfile(familyId,profileId,expected,patch) {
      const id=documentId(familyId,profileId);
      return db.runTransaction(async transaction=>{
        let current;
        try{current=(await transaction.collection('voice_profiles').doc(id).get()).data;}catch{return false;}
        if(!current||current.familyId!==familyId||Object.entries(expected).some(([key,value])=>current[key]!==value))return false;
        await transaction.collection('voice_profiles').doc(id).set({data:withoutId({...current,...patch})});
        return true;
      });
    },
  };
}

module.exports={RUNNABLE_VOICE_STATUSES,createVoiceWorkerRepository};
