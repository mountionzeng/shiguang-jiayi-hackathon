const crypto=require('node:crypto');
const {publicPricing}=require('./pricing');

class StoryAudioError extends Error {
  constructor(code,message){super(message);this.name='StoryAudioError';this.code=code;}
}
const fail=(code,message)=>{throw new StoryAudioError(code,message);};
const stable=value=>{
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
  return JSON.stringify(value);
};
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:stable(value)).digest('hex');
const validId=(value,prefix,max=120)=>typeof value==='string'&&value.startsWith(prefix)&&value.length<=max&&/^[a-zA-Z0-9_-]+$/.test(value);
const validRequestId=value=>validId(value,'audio-',100);
const validVoiceProfileId=value=>validId(value,'voice-',106)&&/^voice-[a-z0-9-]+$/.test(value);

function publicCapabilities(config={}) {
  const pricing=publicPricing(config),pricingVersion=pricing.version;
  const capability=(enabled,missing='not_verified')=>enabled&&pricing.configured?{enabled:true}:{enabled:false,reason:enabled?pricing.reason:missing};
  const officialVoices=Array.isArray(config.officialVoices)?config.officialVoices.filter(item=>item&&typeof item.id==='string'&&typeof item.label==='string').map(item=>({id:item.id,label:item.label})):[];
  return {
    apiVersion:1,
    provider:'tencent-cloud',
    voiceClone:capability(Boolean(config.voiceCloneEnabled)),
    voiceEnrollment:capability(Boolean(config.voiceEnrollmentEnabled),'not_verified'),
    tts:capability(Boolean(config.ttsEnabled)),
    timestamps:capability(Boolean(config.timestampsEnabled)),
    mixing:capability(Boolean(config.mixingEnabled)),
    video:capability(Boolean(config.videoEnabled)),
    submission:capability(Boolean(config.submissionEnabled),'implementation_not_ready'),
    pricingVersion,
    ...(officialVoices.length?{officialVoices}:{}),
  };
}

function assertUnrestrictedStory(story,draft) {
  const marked=item=>item&&['sourceIds','blockId','provenanceVersion'].some(key=>Object.prototype.hasOwnProperty.call(item,key));
  if(story?.sourcePolicyRequired||marked(draft)||marked(story)||
    (draft?.content||[]).some(marked)||
    (draft?.chapters||[]).some(chapter=>marked(chapter)||(chapter.content||[]).some(marked)))
    fail('STORY_PROTOCOL_REQUIRED','这份故事含来源限制，暂不支持制作有声书');
}

function chapterSnapshot({familyId,story,revision,chapterId}) {
  if(!story||!revision||revision.storyId!==story.id)fail('REVISION_NOT_FOUND','找不到这本书的保存版本');
  assertUnrestrictedStory(story,revision.draft);
  const chapter=revision.draft?.chapters?.find(item=>item.id===chapterId);
  if(!chapter)fail('CHAPTER_NOT_FOUND','找不到要朗读的章节');
  const blocks=[];let text='';
  for(const item of chapter.content||[]) {
    if(typeof item.text==='string'&&item.photoId===undefined){blocks.push({kind:'text',text:item.text});text+=item.text;continue;}
    if(typeof item.photoId==='string'&&/^photo-[a-z0-9-]{1,120}$/.test(item.photoId)&&item.text===undefined){blocks.push({kind:'image',imageId:item.photoId});continue;}
    fail('INVALID_CHAPTER','章节里有无法朗读的内容');
  }
  if(!text.trim())fail('EMPTY_NARRATION','这一章还没有可以朗读的文字');
  const snapshot={familyId,storyId:story.id,revisionId:revision.id,chapterId,title:String(chapter.title||''),bookTitle:String(revision.draft.title||story.bookTitle||story.title||''),text,blocks};
  return {...snapshot,digest:digest(snapshot)};
}

function normalizeCreateInput(event={}) {
  if(!validRequestId(event.requestId))fail('INVALID_INPUT','声音请求编号无效');
  if(!validId(event.storyId,'story-',120)||!validId(event.revisionId,'revision-',140)||!validId(event.chapterId,'chapter-',100))fail('INVALID_INPUT','故事或版本信息无效');
  const voice=event.voice;
  if(!voice||!['official','clone'].includes(voice.kind)||typeof voice.id!=='string'||!voice.id.trim()||voice.id.length>120)fail('INVALID_INPUT','请选择可用的声音');
  const background=event.background;
  if(background!==undefined) {
    if(!background||typeof background.id!=='string'||!background.id.trim()||background.id.length>80||!Number.isFinite(background.volume)||background.volume<0||background.volume>0.4)fail('INVALID_INPUT','背景音设置无效');
  }
  return {requestId:event.requestId,storyId:event.storyId,revisionId:event.revisionId,chapterId:event.chapterId,voice:{kind:voice.kind,id:voice.id.trim()},...(background?{background:{id:background.id.trim(),volume:background.volume}}:{})};
}

function publicOperation(operation,playback){return {id:operation.id,storyId:operation.storyId,revisionId:operation.revisionId,chapterId:operation.chapterId,status:operation.status,createdAt:operation.createdAt,updatedAt:operation.updatedAt,snapshot:{title:operation.snapshot.title,bookTitle:operation.snapshot.bookTitle,digest:operation.snapshot.digest},voice:{kind:operation.voice.kind},...(operation.background?{background:operation.background}:{}),...(playback?{playback}:{}),...(operation.error?{error:operation.error}:{})};}

module.exports={StoryAudioError,stable,digest,validId,validRequestId,validVoiceProfileId,publicCapabilities,assertUnrestrictedStory,chapterSnapshot,normalizeCreateInput,publicOperation};
