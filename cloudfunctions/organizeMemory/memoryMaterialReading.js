const {createHash} = require('node:crypto');
const {assertIdentityStillActive} = require('./aiGuard');
const COLLECTION = 'material_captures';
const fail = message => {throw new Error(message);};
const photoIdsOf = memory => [...new Set((memory.photoIds || []).filter(id=>/^photo-(?!ai-)[a-z0-9-]{1,80}$/.test(id)))];
const captureIdOf = (memoryId,ids) => 'capture-memory-' + createHash('sha256').update(JSON.stringify([memoryId,ids])).digest('hex').slice(0,32);
async function optional(reader,collection,id) {
  try { return (await reader.collection(collection).doc(id).get()).data; }
  catch(error) {if(/DOCUMENT_NOT_FOUND|does not exist|not found|document\.get:fail -1\b/i.test(String(error.message || error.errMsg)))return;throw error;}
}
async function loadMemory(reader,identity,id) {
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id || ''))fail('材料所属记忆无效');
  const memory = await optional(reader,'memories',`${identity.familyId}_${id}`);
  if(!memory || memory.deletedAt || memory.scope!=='personal' || memory.familyId!==identity.familyId || memory._openid!==identity.openid)fail('材料所属记忆已不可用');
  return memory;
}
async function assertPhotos(reader,identity,ids) {
  for(const id of ids) {
    const photo=await optional(reader,'photos',`${identity.familyId}__${id}`);
    if(!photo || photo.deletedAt || photo._openid!==identity.openid || photo.familyId!==identity.familyId)fail('照片已改变或尚未完成上传');
  }
}
async function prepareMemoryReading(db,identity,memoryId) {
  const memory=await loadMemory(db,identity,memoryId),ids=photoIdsOf(memory);
  if(!ids.length || ids.length>9)fail('请选择1至9张用户照片读取');
  const id=captureIdOf(memoryId,ids), key=`${identity.accountId}_${id}`;
  // Reuse already-read original pages; never rerun vision just because the entry point changed.
  const seed=[];
  if(memory.materialCaptureId) {
    const root=await optional(db,COLLECTION,`${identity.accountId}_${memory.materialCaptureId}`);
    if(root?.accountId===identity.accountId && root.familyId===identity.familyId) {
      for(const captureId of (root.sessionCaptureIds || [root.id]).slice(0,50)) {
        const row=await optional(db,COLLECTION,`${identity.accountId}_${captureId}`);
        if(row?.accountId===identity.accountId && row.familyId===identity.familyId && row.memoryId===memoryId && row.status==='saved')
          seed.push(...(row.evidence || []).filter(e=>e.kind==='image-reading' && ids.includes(e.sourceId) && /【可见文字】\s*\S/.test(e.text || '')));
      }
    }
  }
  await db.runTransaction(async tx=>{
    await assertIdentityStillActive(tx,identity);
    const latest=await loadMemory(tx,identity,memoryId);
    if(JSON.stringify(photoIdsOf(latest))!==JSON.stringify(ids))fail('照片已改变，请重新读取');
    await assertPhotos(tx,identity,ids);
    const old=await optional(tx,COLLECTION,key);
    if(old) {if(old.accountId!==identity.accountId || old.memoryId!==memoryId)fail('材料归属不匹配');return;}
    const now=Date.now();
    await tx.collection(COLLECTION).doc(key).set({data:{id,sessionId:id,sessionCaptureIds:[id],accountId:identity.accountId,familyId:identity.familyId,
      ownerOpenid:identity.openid,_openid:identity.openid,memoryId,memoryPhotoIds:ids,photoIds:ids,audio:[],text:'',status:'saved',
      evidence:ids.map(photoId=>seed.find(e=>e.sourceId===photoId)).filter(Boolean),createdAtMs:now,updatedAtMs:now}});
  });
  return id;
}
function readingText(row,ids) {
  const parts=ids.map((id,index)=>{
    const evidence=row?.evidence?.find(e=>e.sourceId===id && e.kind==='image-reading');
    if(!evidence || typeof evidence.text!=='string')fail('材料文字尚未读完，请先读取全部照片');
    const match=evidence.text.match(/【可见文字】([\s\S]*?)(?=【画面内容】|【不确定处】|$)/);
    if(!match || !match[1].trim())fail('这张照片未返回文字提取结果，请核对后重新读取');
    // Visual observations stay attached to the original, never used as article body.
    return `【图片${index+1}：机器提取的材料原文，不是用户亲历】\n${match[1].trim()}`;
  });
  const text=parts.join('\n\n');
  if(text.length>40000)fail('材料文字过长，请分段整理；原文仍完整保留');
  return text;
}
async function loadMemoryReading(db,identity,memoryId) {
  const memory=await loadMemory(db,identity,memoryId),ids=photoIdsOf(memory);
  if(!ids.length)fail('这段记忆没有可读取的原照片');
  await assertPhotos(db,identity,ids);
  const row=await optional(db,COLLECTION,`${identity.accountId}_${captureIdOf(memoryId,ids)}`);
  if(!row || row.accountId!==identity.accountId || row.familyId!==identity.familyId || row.memoryId!==memoryId)fail('请先读取这段记忆的照片文字');
  return {text:readingText(row,ids),photoIds:ids};
}
module.exports={prepareMemoryReading,loadMemoryReading,photoIdsOf,captureIdOf,readingText};
