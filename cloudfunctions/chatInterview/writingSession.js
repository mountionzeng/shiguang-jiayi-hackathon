const {assertIdentityStillActive} = require('./aiGuard');
const initialized = new WeakSet();
const COLLECTION = 'writing_sessions';
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const missing = error => /DOCUMENT_NOT_FOUND|document (?:does not exist|not found)|\bdocument\.get:fail document with _id \S+ does not exist\b|document\.get:fail -1\b/i.test(String(error?.message || error?.errMsg));
async function optional(db, collection, id) {
  try {return (await db.collection(collection).doc(id).get()).data;}
  catch(error) {if(missing(error))return;throw error;}
}
async function ownMemory(db, identity, id) {
  if(!validId(id))throw new Error('WRITING_SESSION_INVALID');
  const memory=await optional(db,'memories',`${identity.familyId}_${id}`);
  if(!memory || memory.deletedAt || memory.scope!=='personal' || memory.familyId!==identity.familyId || memory._openid!==identity.openid)
    throw new Error('WRITING_SESSION_MEMORY_UNAVAILABLE');
  return memory;
}
function snapshot(value) {
  if(!value || typeof value!=='object' || JSON.stringify(value).length>150000)throw new Error('WRITING_SESSION_TOO_LARGE');
  const text=(v,n)=>{if(typeof v!=='string' || v.length>n)throw new Error('WRITING_SESSION_INVALID');return v;};
  if(!Array.isArray(value.messages) || value.messages.length>200 || !Array.isArray(value.answers) || value.answers.length>200)throw new Error('WRITING_SESSION_TOO_LARGE');
  const messages=value.messages.map(m=>{
    if(!m || !['opening','answer','followup','research','request'].includes(m.kind))throw new Error('WRITING_SESSION_INVALID');
    return {id:text(m.id,80),kind:m.kind,text:text(m.text,5000),label:text(m.label || '',100),sources:(Array.isArray(m.sources)?m.sources:[]).slice(0,10).map(s=>{
      if(!Number.isSafeInteger(s.index) || !/^https?:\/\//.test(s.url))throw new Error('WRITING_SESSION_INVALID');
      return {index:s.index,title:text(s.title,160),url:text(s.url,2000)};
    })};
  });
  return {messages,answers:value.answers.map(v=>text(v,5000)),inputText:text(value.inputText || '',10000),
    askedDimensions:(value.askedDimensions || []).filter(v=>['time','place','person','event','feeling'].includes(v)).slice(0,200),
    draftTitle:text(value.draftTitle || '',80),draftText:text(value.draftText || '',10000),draftSummary:text(value.draftSummary || '',500),
    ...(value.draftAiText ? {draftAiText:text(value.draftAiText,10000),draftAiTitle:text(value.draftAiTitle || '',80)} : {}),
    ...(value.writingInstruction ? {writingInstruction:text(value.writingInstruction,300)} : {}),
    ...(value.outputStoryId ? {outputStoryId:text(value.outputStoryId,120),outputStoryRevisionId:text(value.outputStoryRevisionId || '',128)} : {}),
    draftOrganizationMode:value.draftOrganizationMode==='cloud-ai'?'cloud-ai':'local-demo',
    outputMemoryId:value.outputMemoryId ? text(value.outputMemoryId,128):'', saved:value.saved===true};
}
async function writingSession(event, db, identity) {
  if(event.expectedFamilyId!==identity.familyId)throw new Error('WRITING_SESSION_SCOPE_CHANGED');
  await ownMemory(db,identity,event.memoryId);
  if(event.operation!=='get' && event.operation!=='save')throw new Error('WRITING_SESSION_INVALID');
  // Cloud-only collection: no client database access rules are expanded.
  if(db.createCollection && !initialized.has(db)) {
    try {await db.createCollection(COLLECTION);}catch(error){if(!/already exists|ResourceExist|COLLECTION_(ALREADY_)?EXIST|Table (?:already )?exist/i.test(String(error?.message || error?.errMsg)))throw error;}
    initialized.add(db);
  }
  let rootId=event.memoryId;
  if(event.operation==='get') {
    const direct=await optional(db,COLLECTION,`${identity.accountId}_${rootId}`);
    if(!direct) {
      const matches=await db.collection(COLLECTION).where({accountId:identity.accountId,familyId:identity.familyId,outputMemoryId:rootId}).limit(1).get();
      if(matches.data[0])rootId=matches.data[0].memoryId;
    }
  }
  return db.runTransaction(async tx=>{
    await assertIdentityStillActive(tx,identity);
    const family=await optional(tx,"families",identity.familyId);
    if(family?.ownerAccountId!==identity.accountId)throw new Error("WRITING_SESSION_SCOPE_CHANGED");
    await ownMemory(tx,identity,rootId);
    const ref=tx.collection(COLLECTION).doc(`${identity.accountId}_${rootId}`);
    const current=await optional(tx,COLLECTION,`${identity.accountId}_${rootId}`);
    if(current && (current.accountId!==identity.accountId || current.familyId!==identity.familyId || current.memoryId!==rootId))throw new Error('WRITING_SESSION_FORBIDDEN');
    if(event.operation==='get')return {memoryId:rootId,revision:current?.revision || 0,mutationId:current?.mutationId || '',snapshot:current?.snapshot || null};
    if(!validId(event.mutationId))throw new Error('WRITING_SESSION_INVALID');
    if(current?.mutationId===event.mutationId)return {memoryId:rootId,revision:current.revision,mutationId:current.mutationId};
    if(event.revision!==(current?.revision || 0))throw new Error('WRITING_SESSION_CONFLICT');
    const next=snapshot(event.snapshot);
    if(next.outputMemoryId)await ownMemory(tx,identity,next.outputMemoryId);
    const revision=(current?.revision || 0)+1;
    await ref.set({data:{accountId:identity.accountId,familyId:identity.familyId,_openid:identity.openid,memoryId:rootId,
      outputMemoryId:next.outputMemoryId,revision,mutationId:event.mutationId,snapshot:next,updatedAtMs:Date.now()}});
    return {memoryId:rootId,revision,mutationId:event.mutationId};
  });
}
module.exports={writingSession,snapshot};
