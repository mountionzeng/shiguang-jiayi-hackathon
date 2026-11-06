import { storyImageApi, newImageRequestId } from './storyImageService';
import { storyAudioApi, newAudioRequestId } from './storyAudioService';
import { storyImageReferenceId } from './bookImages';
import { requestAiConsent } from './aiConsent';
export type ArticleMediaKind='image'|'music'|'narration';
export interface ArticleMediaTask {kind:ArticleMediaKind;requestId:string;storyId:string;revisionId:string;chapterId:string;blockId:string;text:string;jobId?:string;voiceId?:string}
export type ArticleMediaResult={kind:'image';photoId:string;url:string}|{kind:'music'|'narration';operationId:string};
export function pendingArticleMedia(key:string):ArticleMediaTask[] {
  const value=wx.getStorageSync(key);
  return Array.isArray(value)?value:[];
}
export function storeArticleMedia(key:string,task:ArticleMediaTask) {
  const previous=pendingArticleMedia(key).filter(t=>t.requestId!==task.requestId);
  wx.setStorageSync(key,[...previous,task]);
}
export function finishArticleMedia(key:string,requestId:string) {
  wx.setStorageSync(key,pendingArticleMedia(key).filter(t=>t.requestId!==requestId));
}
export function createArticleMediaTask(input:Omit<ArticleMediaTask,'requestId'>):ArticleMediaTask {
  return {...input,requestId:input.kind==='image'?newImageRequestId():newAudioRequestId()};
}
/** Persist each server acknowledgement before polling; retries reuse the same paid request. */
export async function runArticleMedia(task:ArticleMediaTask,persist:()=>void,active:()=>boolean):Promise<ArticleMediaResult|undefined> {
  if(!await requestAiConsent())throw Object.assign(new Error('未允许使用 AI，尚未生成'),{code:'NOT_SUBMITTED'});
  if(!active())return;
  if(task.kind==='image') {
    if(!task.jobId){const job=await storyImageApi.submitChapterImage({...task,purpose:'illustration',selectedText:task.text,selectedBlockId:task.blockId});task.jobId=job.jobId;persist();}
  } else if(task.kind==='music') {
    await storyAudioApi.createMusic(task);
  } else {
    if(!task.voiceId){const caps=await storyAudioApi.capabilities();task.voiceId=caps.officialVoices?.[0]?.id;if(!caps.tts.enabled||!task.voiceId)throw Object.assign(new Error('朗读服务暂时不可用'),{code:'NOT_SUBMITTED'});persist();}
    await storyAudioApi.create({...task,voice:{kind:'official',id:task.voiceId}});
  }
  for(let attempt=0;active() && attempt<60;attempt++) {
    if(task.kind==='image') {
      const result=await storyImageApi.checkImageJob(task.jobId!,task.storyId);
      if(result.image?.url && result.image.moderation==='pass')return {kind:'image',photoId:storyImageReferenceId(result.image.imageId),url:result.image.url};
      if(['failed','blocked','unknown','expired'].includes(result.job.status))throw new Error(result.job.message || '配图未完成，请稍后再试');
    } else {
      const {operation}=await storyAudioApi.status(task.requestId);
      if(operation.status==='ready')return {kind:task.kind,operationId:operation.id};
      if(['failed','unknown','cancelled'].includes(operation.status))throw new Error(operation.error?.message || '声音生成未完成，请稍后再试');
    }
    if(active())await new Promise<void>(resolve=>setTimeout(resolve,3000));
  }
  if(active())throw new Error('仍在生成，稍后重新打开本章会继续读取结果');
}

export function mediaDefinitelyNotSubmitted(error:unknown):boolean {
  return ['NOT_SUBMITTED','MUSIC_NOT_CONFIGURED','REVISION_CHANGED','INVALID_INPUT','EMPTY_NARRATION','TEXT_TOO_LONG','STORY_PROTOCOL_REQUIRED','AUDIO_NOT_READY','AUDIO_NOT_CONFIGURED','VOICE_NOT_FOUND','CONSENT_DECLINED'].includes((error as {code?:string})?.code || '');
}
