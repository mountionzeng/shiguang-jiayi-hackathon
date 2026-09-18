const {StoryAudioError,assertUnrestrictedStory}=require('./core');
const OPERATIONS='audio_operations';
const STORIES='stories';
const REVISIONS='biography_drafts';
const VOICES='voice_profiles';

const documentId=(familyId,id)=>familyId+'_'+id;
const isMissing=error=>/does not exist|not found|cannot find document/i.test(String(error?.errMsg || error?.message || error));
const withoutId=value=>{const {_id,...data}=value;return data;};

async function getDocument(target,collection,id) {
  try{return (await target.collection(collection).doc(id).get()).data;}
  catch(error){if(isMissing(error))return undefined;throw error;}
}

function createStoryAudioRepository(db,{signFile}={}) {
  return {
    async getStory(familyId,storyId) {
      const story=await getDocument(db,STORIES,documentId(familyId,storyId));
      return story?.familyId===familyId && story.id===storyId ? story : undefined;
    },
    async getRevision(familyId,revisionId) {
      const record=await getDocument(db,REVISIONS,documentId(familyId,revisionId));
      if(record?.familyId!==familyId || record.revision?.id!==revisionId)return undefined;
      return record.revision;
    },
    async getVoiceProfile(familyId,voiceId) {
      const voice=await getDocument(db,VOICES,documentId(familyId,voiceId));
      return voice?.familyId===familyId && voice.id===voiceId ? voice : undefined;
    },
    async createVoiceProfile(familyId,voiceId,profile) {
      const id=documentId(familyId,voiceId);
      return db.runTransaction(async transaction=>{
        if(await getDocument(transaction,VOICES,id))return false;
        await transaction.collection(VOICES).doc(id).set({data:withoutId(profile)});
        return true;
      });
    },
    async updateVoiceProfile(familyId,voiceId,expected,patch) {
      const id=documentId(familyId,voiceId);
      return db.runTransaction(async transaction=>{
        const current=await getDocument(transaction,VOICES,id);
        if(!current||current.familyId!==familyId||Object.entries(expected).some(([key,value])=>current[key]!==value))return false;
        await transaction.collection(VOICES).doc(id).set({data:withoutId({...current,...patch})});
        return true;
      });
    },
    getOperation(operationId){return getDocument(db,OPERATIONS,operationId);},
    async createOperation(operationId,operation) {
      return db.runTransaction(async transaction=>{
        if(await getDocument(transaction,OPERATIONS,operationId))return false;
        if(operation.storyId&&operation.revisionId) {
          const story=await getDocument(transaction,STORIES,documentId(operation.familyId,operation.storyId));
          const revision=await getDocument(transaction,REVISIONS,documentId(operation.familyId,operation.revisionId));
          if(!story||story.familyId!==operation.familyId||story.deletedAt)throw new StoryAudioError('STORY_NOT_FOUND','这本故事书已不可用');
          if(story.currentRevisionId!==operation.revisionId||revision?.revision?.storyId!==operation.storyId)throw new StoryAudioError('REVISION_CHANGED','书稿版本已经变化，请重新制作');
          assertUnrestrictedStory(story,revision.revision.draft);
        }
        await transaction.collection(OPERATIONS).doc(operationId).set({data:withoutId(operation)});
        return true;
      });
    },
    async signWork(operation) {
      const fileID=operation?.work?.fileID;
      if(operation?.status!=='ready'||operation?.work?.format!=='wav'||typeof fileID!=='string'||!fileID.startsWith('cloud://')||typeof signFile!=='function')throw new StoryAudioError('WORK_NOT_READY','作品尚未准备好播放');
      const audioUrl=await signFile(fileID);
      if(typeof audioUrl!=='string'||!audioUrl.startsWith('https://'))throw new StoryAudioError('WORK_NOT_READY','暂时无法打开这份有声作品');
      return {audioUrl};
    },
  };
}

module.exports={createStoryAudioRepository,documentId};
