import {currentFamilyId} from './cloudRoomStorage';
import {requestAiConsent} from './aiConsent';
import {requestPhotoAiConsent} from './photoAiConsent';
import {saveLocalPhoto} from './bookImages';
import {ensurePhotoUploads} from './photoCloud';
import {classifyImportFiles,readImportTextFile,type ImportFileLike} from './memoryImport';

export interface CaptureAudioFile {id:string;name:string;path:string;bytes:number;extension:string;fileID?:string}
export interface MemoryCaptureDraft {id:string;sessionId?:string;familyId:string;composerText?:string;submittedText?:string;text:string;photoIds:string[];photoPaths:string[];audio:CaptureAudioFile[];submitted?:boolean}
export interface MaterialAnalysis {status:'pending'|'processing'|'uncertain'|'ready';message?:string;pollAfterMs?:number}
export interface MemoryCaptureReceipt {analysis?:MaterialAnalysis;id:string;sessionId?:string;familyId:string;status:'received'|'processing'|'uncertain'|'ready'|'saved';text:string;photoIds:string[];audio:Array<{id:string;name:string;fileID?:string}>;evidence:Array<{sourceId:string;kind:string;text:string}>;draft?:{title:string;body:string};memoryId:string;message:string;createdAtMs:number;pollAfterMs?:number}
const makeId=()=>`capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`;
const key=(familyId:string,sessionId?:string)=>sessionId ? `memory-capture:v2:${familyId}:${sessionId}` : `memory-capture:v1:${familyId}`;
const pendingKey=(familyId:string)=>`memory-capture-pending:v2:${familyId}`;
export async function assertCaptureScope(familyId:string){if(await currentFamilyId()!==familyId)throw new Error('账号已切换，素材仍保留在原账号，请重新打开聊天');}
async function call<T>(action:string,data:Record<string,unknown>={},familyId?:string):Promise<T>{
  const expectedFamilyId=familyId || await currentFamilyId();
  await assertCaptureScope(expectedFamilyId);
  const result=(await wx.cloud.callFunction({name:'organizeMemory',data:{action,...data,expectedFamilyId}})).result as T & {error?:{message?:string}};
  if(result?.error)throw new Error(result.error.message || '素材服务尚未就绪');
  await assertCaptureScope(expectedFamilyId);
  return result;
}
export async function loadCaptureDraft(sessionId?:string):Promise<MemoryCaptureDraft | undefined>{
  const familyId=await currentFamilyId(),draft=wx.getStorageSync<MemoryCaptureDraft>(key(familyId,sessionId));
  return draft?{...draft,familyId}:undefined;
}
export async function pendingCaptureDrafts():Promise<MemoryCaptureDraft[]>{
  const familyId=await currentFamilyId();
  const ids=wx.getStorageSync<string[]>(pendingKey(familyId)) || [];
  return [wx.getStorageSync<MemoryCaptureDraft>(key(familyId)),...ids.map(id=>wx.getStorageSync<MemoryCaptureDraft>(key(familyId,id)))].filter(draft=>draft && (draft.composerText?.trim() || draft.text || draft.photoIds.length || draft.audio.length));
}
export async function storeCaptureDraft(draft:MemoryCaptureDraft | undefined,familyId?:string,expectedId?:string,sessionId?:string){
  const scope=draft?.familyId || familyId || await currentFamilyId(),session=draft?.sessionId || sessionId,name=key(scope,session);
  if(draft)wx.setStorageSync(name,draft);
  else {const previous=wx.getStorageSync<MemoryCaptureDraft>(name);if(!expectedId || previous?.id===expectedId)wx.removeStorageSync(name);}
  if(session){
    const ids=wx.getStorageSync<string[]>(pendingKey(scope)) || [];
    const stored=wx.getStorageSync<MemoryCaptureDraft>(name);
    const hasContent=stored && (stored.composerText?.trim() || stored.text || stored.photoIds.length || stored.audio.length);
    wx.setStorageSync(pendingKey(scope),[...ids.filter(id=>id!==session),...(hasContent?[session]:[])]);
  }
}
export async function stageCaptureFiles(files:ImportFileLike[],current?:MemoryCaptureDraft,sessionId?:string):Promise<MemoryCaptureDraft>{
  const classified=classifyImportFiles(files);
  if(classified.unsupportedNames.length)throw new Error(`暂不支持${classified.unsupportedNames.join('、')}。可选图片、TXT/MD或MP3/M4A/WAV/Ogg录音。`);
  const familyId=current?.familyId || await currentFamilyId();
  await assertCaptureScope(familyId);
  const id=makeId();
  const draft:MemoryCaptureDraft=current?{...current,photoIds:[...current.photoIds],photoPaths:[...current.photoPaths],audio:[...current.audio]}:{id,familyId,text:'',photoIds:[],photoPaths:[],audio:[],...(sessionId!==undefined?{sessionId:sessionId || id}:{})};
  if(draft.submitted)throw new Error('上一批素材已提交，请先完成保存');
  if(draft.photoIds.length+draft.audio.length+classified.images.length+classified.audio.length>6)throw new Error('一批最多6份素材');
  if(draft.audio.length+classified.audio.length>3)throw new Error('一批最多3段录音');
  // Persist after every upload/save, so partial progress survives app interruption.
  await storeCaptureDraft(draft);
  if(classified.text){const imported=await readImportTextFile(classified.text);const text=[draft.text,imported.segments.join('\n')].filter(Boolean).join('\n');if(text.length>4000)throw new Error('一批最多4000字，请拆分后发送');draft.text=text;await storeCaptureDraft(draft);}
  for(const image of classified.images){await assertCaptureScope(familyId);const saved=await saveLocalPhoto(image.path,'import');draft.photoIds.push(saved.id);draft.photoPaths.push(saved.path);await storeCaptureDraft(draft);}
  for(const file of classified.audio){
    if(!file.size || file.size>8*1024*1024)throw new Error('单段录音需在8MB以内');
    const saved=await new Promise<{savedFilePath:string}>((resolve,reject)=>wx.getFileSystemManager().saveFile({tempFilePath:file.path,success:resolve,fail:reject}));
    draft.audio.push({id:makeId(),name:file.name || '录音.mp3',path:saved.savedFilePath,bytes:file.size,extension:file.name?.split('.').pop()?.toLowerCase() || 'mp3'});
    await storeCaptureDraft(draft);
  }
  await assertCaptureScope(familyId);
  return draft;
}
export async function captureReceiptList(){return (await call<{items:MemoryCaptureReceipt[]}>('captureList')).items;}
export async function sendMemoryCapture(draft:MemoryCaptureDraft,text:string,onReceipt:(receipt:MemoryCaptureReceipt)=>void){
  await assertCaptureScope(draft.familyId);
  if(!draft.submitted && !draft.text.trim() && !text.trim() && !draft.photoIds.length && !draft.audio.length)throw new Error('先添加文字、图片或录音');
  if(draft.sessionId){
    const capabilities=await call<{sessionVersion:number}>('captureCapabilities',{},draft.familyId);
    if(capabilities.sessionVersion!==1)throw new Error('云端记录接口尚未更新，请稍后重试');
  }
  if(!draft.submitted){draft.composerText=text;draft.submittedText=[draft.text,text].filter(Boolean).join('\n');if(draft.submittedText.length>4000)throw new Error('一批最多4000字，请拆分后发送');draft.submitted=true;await storeCaptureDraft(draft);}
  await ensurePhotoUploads(draft.photoIds);
  await assertCaptureScope(draft.familyId);
  const received=await call<MemoryCaptureReceipt & {uploads:Array<{id:string;cloudPath:string;fileID:string}>}>('captureReceive',{id:draft.id,...(draft.sessionId?{sessionId:draft.sessionId}:{}),text:draft.submittedText ?? draft.text,photoIds:draft.photoIds,audio:draft.audio.map(({path,fileID,...file})=>file)},draft.familyId);
  if(draft.sessionId && received.sessionId!==draft.sessionId)throw new Error('云端记录接口尚未更新，原件已保留，请稍后重试');
  onReceipt(received);
  for(const file of draft.audio){
    const slot=received.uploads.find(item=>item.id===file.id);if(!slot)throw new Error('没有找到录音上传位置');
    const fileID=slot.fileID || file.fileID || (await wx.cloud.uploadFile({cloudPath:slot.cloudPath,filePath:file.path})).fileID;
    file.fileID=fileID;await storeCaptureDraft(draft);
    if(!slot.fileID)await call('captureRegister',{id:draft.id,fileId:file.id,fileID},draft.familyId);
  }
  onReceipt(await saveCaptureOriginal(received.id,draft.familyId));
  await storeCaptureDraft(undefined,draft.familyId,draft.id,draft.sessionId);
}
export async function continueMemoryCapture(receipt:MemoryCaptureReceipt,onReceipt:(receipt:MemoryCaptureReceipt)=>void){
  await assertCaptureScope(receipt.familyId);
  if(receipt.status==='saved'||receipt.status==='uncertain'||receipt.status==='processing')return;
  const allowed=await requestAiConsent();
  const photoConsent=receipt.photoIds.length ? allowed && await requestPhotoAiConsent(receipt.photoIds.length) : true;
  const audioConsent=receipt.audio.length ? allowed && await new Promise<boolean>(resolve=>wx.showModal({title:'允许将这次录音转成文字？',content:'仅将本次选中的录音发送给豆包语音服务转写，再由AI整理为记忆。原录音私密保留，不用于声音复刻。不同意仍可保存原件。',confirmText:'转写整理',cancelText:'只存原件',success:result=>resolve(result.confirm),fail:()=>resolve(false)})) : true;
  if(!allowed || !photoConsent || !audioConsent){onReceipt(await call<MemoryCaptureReceipt>('captureOriginal',{id:receipt.id},receipt.familyId));return;}
  for(let step=0;step<8;step++){
    const updated=await call<MemoryCaptureReceipt>('captureProcess',{id:receipt.id,audioConsent,photoConsent},receipt.familyId);onReceipt(updated);
    if(updated.status!=='received' && updated.status!=='ready')return;
    // The existing per-account AI throttle is one second; each step has its own durable receipt.
    await new Promise(resolve=>setTimeout(resolve,Math.max(1100,Math.min(updated.pollAfterMs || 0,5000))));
  }
}
export async function saveCaptureOriginal(id:string,familyId:string){return call<MemoryCaptureReceipt>('captureOriginal',{id},familyId);}
export async function captureAudioUrl(id:string,fileId:string){return (await call<{url:string}>('captureAudio',{id,fileId})).url;}

export async function readMemoryCapture(id:string){return call<MemoryCaptureReceipt>('captureRead',{id});}
export async function readCaptureSession(id:string){return call<{sessionId:string;items:MemoryCaptureReceipt[]}>('captureSessionRead',{id});}


export function captureHasUnreadMedia(receipt: MemoryCaptureReceipt): boolean {
  return receipt.photoIds.some(id=>!receipt.evidence?.some(e=>e.sourceId===id && e.kind==='image-reading')) ||
    receipt.audio.some(file=>!receipt.evidence?.some(e=>e.sourceId===file.id && e.kind==='transcript'));
}

/** Keep machine readings distinct from original speech, including when a source could not be read. */
export function captureSourceText(items: MemoryCaptureReceipt[]): string {
  return items.map((item,index)=>{
    const parts=[`【材料 ${index+1}】`,item.text.trim() ? `用户原文：\n${item.text}` : ''];
    for(const evidence of item.evidence || []) {
      if(evidence.kind==='user-text')continue;
      const photoIndex=item.photoIds.indexOf(evidence.sourceId);
      const audio=item.audio.find(file=>file.id===evidence.sourceId);
      if(photoIndex>=0 && ['image-reading','image-description'].includes(evidence.kind))parts.push(`图片 ${photoIndex+1}（AI读取，请核对，不是用户亲历自述）：\n${evidence.text}`);
      else if(audio && evidence.kind==='transcript')parts.push(`录音 ${audio.name}（机器转写，请核对）：\n${evidence.text}`);
    }
    if(captureHasUnreadMedia(item))parts.push('还有图片或录音未完成读取，不推断未读内容。');
    return parts.filter(Boolean).join('\n\n');
  }).join('\n\n');
}

export async function readCaptureMaterials(
  items: MemoryCaptureReceipt[],
  onReceipt: (receipt: MemoryCaptureReceipt)=>void,
  isActive: ()=>boolean = ()=>true,
): Promise<boolean> {
  const pending=items.filter(captureHasUnreadMedia);
  if(!pending.length)return true;
  if(!await requestAiConsent() || !isActive())return false;
  const photoCount=pending.reduce((n,item)=>n+item.photoIds.length,0);
  const photoConsent=!photoCount || await requestPhotoAiConsent(photoCount,'material-reading');
  if(!photoConsent || !isActive())return false;
  const audioConsent=!pending.some(item=>item.audio.length) || await new Promise<boolean>(resolve=>wx.showModal({title:'读取这些录音里的内容？',content:'将这段记忆中的录音发送给豆包语音服务转成文字，保留原件供你核对。不同意仍可保存和查看原件。',confirmText:'允许转写',cancelText:'只存原件',success:result=>resolve(result.confirm),fail:()=>resolve(false)}));
  if(!audioConsent || !isActive())return false;
  for(const item of pending) {
    let current=item;
    for(let step=0;step<8 && captureHasUnreadMedia(current);step++) {
      if(!isActive())return false;
      current=await call<MemoryCaptureReceipt>('captureReadMaterials',{id:item.id,photoConsent,audioConsent,...(step===0 && item.analysis?.status==='uncertain'?{retry:true}:{})},item.familyId);
      if(!isActive())return false;
      onReceipt(current);
      if(!current.analysis)throw new Error('材料读取接口尚未更新，原件已保留。');
      if(current.analysis.status==='uncertain')throw new Error(current.analysis.message || '材料尚未读完，已保留原件，可继续读取。');
      if(current.analysis.status==='processing')throw new Error('材料正在读取，请稍后继续，原件已保留。');
      if(captureHasUnreadMedia(current))await new Promise(resolve=>setTimeout(resolve,Math.max(1100,Math.min(current.analysis?.pollAfterMs || 0,5000))));
    }
    if(captureHasUnreadMedia(current))throw new Error('材料还在读取，已读内容已保留，稍后点击继续读取。');
    // Keep consecutive batches outside the server's per-account throttle window.
    if(item!==pending[pending.length-1])await new Promise(resolve=>setTimeout(resolve,1100));
  }
  return true;
}
