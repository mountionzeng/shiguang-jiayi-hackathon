const {StoryAudioError,assertUnrestrictedStory,chapterSnapshot,stable}=require('./core');
const RUNNABLE_NARRATION_STATUSES=['queued','processing'];
const withoutId=value=>{const {_id,...data}=value;return data;};
const isMissing=error=>/not found|does not exist/i.test(String(error?.message||error?.errMsg||error));

function createNarrationWorkerRepository({db,command}) {
  if(!db||!command?.in)throw new Error('NARRATION_REPOSITORY_CONFIG_REQUIRED');
  const operations=target=>target.collection('audio_operations');
  async function get(target,id){try{return (await operations(target).doc(id).get()).data;}catch(error){if(isMissing(error))return undefined;throw error;}}
  async function cas(id,expected,patch) {
    return db.runTransaction(async transaction=>{
      const current=await get(transaction,id);
      if(!current||Object.entries(expected).some(([key,value])=>current[key]!==value))return false;
      await operations(transaction).doc(id).set({data:withoutId({...current,...patch})});
      return true;
    });
  }
  return {
    async assertNarrationSource(operation) {
      return db.runTransaction(async transaction=>{
        const read=async(collection,id)=>{
          try{return (await transaction.collection(collection).doc(id).get()).data;}
          catch(error){if(isMissing(error))return undefined;throw error;}
        };
        const {familyId,storyId,revisionId,chapterId}=operation;
        const denied=()=>{throw new StoryAudioError('NARRATION_SOURCE_INVALID','故事来源已不可用，未继续制作朗读');};
        const story=await read('stories',familyId+'_'+storyId);
        const record=await read('biography_drafts',familyId+'_'+revisionId);
        if(!story||story.familyId!==familyId||story.id!==storyId||story.deletedAt||
          record?.familyId!==familyId||record.revision?.id!==revisionId||record.revision?.storyId!==storyId)denied();
        assertUnrestrictedStory(story,record.revision.draft);
        const current=story.currentRevisionId===revisionId?record:await read('biography_drafts',familyId+'_'+story.currentRevisionId);
        if(current?.familyId!==familyId||current.revision?.id!==story.currentRevisionId||current.revision?.storyId!==storyId)denied();
        assertUnrestrictedStory(story,current.revision.draft);
        const snapshot=chapterSnapshot({familyId,story,revision:record.revision,chapterId});
        if(stable(snapshot)!==stable(operation.snapshot))denied();
      });
    },
    async listRunnableNarrations({limit=1}={}) {
      const response=await operations(db).where({kind:'narration',status:command.in(RUNNABLE_NARRATION_STATUSES)}).orderBy('updatedAt','asc').limit(Math.max(1,Math.min(10,limit))).get();
      return response.data||[];
    },
    getOperation(id){return get(db,id);},
    async getVoiceProfile(familyId,profileId){
      try{
        const profile=(await db.collection('voice_profiles').doc(`${familyId}_${profileId}`).get()).data;
        return profile?.familyId===familyId&&profile?.id===profileId?profile:undefined;
      }catch(error){if(isMissing(error))return undefined;throw error;}
    },
    updateOperation(id,expected,patch){return cas(id,expected,patch);},
    async initializeNarration(id,expected,patch,segments) {
      // Keep each segment in its own small transaction. A 20k-character chapter can
      // exceed a database transaction's document limit, while these deterministic
      // records are safe to create again after a crash.
      for(const segment of segments){
        const accepted=await db.runTransaction(async transaction=>{
          const parent=await get(transaction,id);
          if(!parent||Object.entries(expected).some(([key,value])=>parent[key]!==value))return false;
          const existing=await get(transaction,segment.id);
          if(existing)return existing.parentOperationId===id&&existing.digest===segment.digest&&existing.index===segment.index;
          await operations(transaction).doc(segment.id).set({data:withoutId(segment)});
          return true;
        });
        if(!accepted)return false;
      }
      return cas(id,expected,patch);
    },
    async listNarrationSegments(parentOperationId) {
      const response=await operations(db).where({kind:'narration_segment',parentOperationId}).orderBy('index','asc').get();
      return response.data||[];
    },
    async updateNarrationSegment(parentOperationId,index,expected,patch) {
      const id=`${parentOperationId}_segment_${String(index).padStart(5,'0')}`;
      return cas(id,{parentOperationId,index,...expected},patch);
    },
  };
}

module.exports={RUNNABLE_NARRATION_STATUSES,createNarrationWorkerRepository};
