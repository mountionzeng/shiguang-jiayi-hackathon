const crypto = require('node:crypto');
const core = require('./core');
const SOURCE = /^source-[a-f0-9]{64}$/;
const BLOCK = /^block-[a-f0-9]{64}$/;
const ACTIONS = new Set(['copy','forward','publish','view','ai','export']);
const clone = value => JSON.parse(JSON.stringify(value));
const blockId = parts => 'block-'+crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
function protocolError() { return Object.assign(new Error('这份故事包含来源信息，请使用支持来源保护的新版入口；原稿没有被修改'),{code:'STORY_PROTOCOL_REQUIRED'}); }
function requireValid(value) { if (!value) throw protocolError(); }
function sources(ids) { return Array.isArray(ids) && ids.length <= 64 && new Set(ids).size === ids.length && ids.every(id=>typeof id==='string' && SOURCE.test(id)); }
function validateScope(scope) {
  requireValid(scope && /^family_[0-9A-Za-z_-]{1,120}$/.test(scope.familyId || '') && /^story-[a-z0-9-]{1,100}$/.test(scope.storyId || ''));
}
function validateShape(draft) {
  requireValid(draft && Array.isArray(draft.chapters) && draft.chapters.length <= 30);
  let count=0;
  for(const chapter of draft.chapters) {
    requireValid(chapter && Array.isArray(chapter.content) && Array.isArray(chapter.memoryIds));
    count+=chapter.content.length;
  }
  requireValid(count<=512);
  core.validateDraft(draft,{memoryIds:[...new Set(draft.chapters.flatMap(c=>c.memoryIds))]});
}
function validateProtected(draft) {
  validateShape(draft);requireValid(draft.provenanceVersion===1);
  const seen=new Set();
  for(const chapter of draft.chapters) for(const item of chapter.content) {
    requireValid(item && BLOCK.test(item.blockId || '') && !seen.has(item.blockId) && sources(item.sourceIds));
    seen.add(item.blockId);
  }
}
// Only for server-trusted, legacy OWN content. Never use this to remove metadata
// from a received draft or accept a client-provided copy as independently owned.
function materializeOwnedDraft(draft, scope) {
  validateScope(scope);requireValid(/^revision-[a-zA-Z0-9-]{1,120}$/.test(scope.revisionId || ''));
  validateShape(draft);requireValid(draft.provenanceVersion===undefined);
  const result=clone(draft);
  for(const chapter of result.chapters) chapter.content=chapter.content.map((item,index)=>{
    requireValid(item.blockId===undefined && item.sourceIds===undefined);
    return {...item,blockId:blockId([scope.familyId,scope.storyId,scope.revisionId,chapter.id,index]),sourceIds:[]};
  });
  result.provenanceVersion=1;Object.assign(result,core.flatten(result.chapters));
  return result;
}
// Internal transform, not an authorization endpoint. Callers must supply a
// server-loaded base and commit atomically with identity/version checks.
function applyBlockEdits(base, edits, scope) {
  validateScope(scope);validateProtected(base);
  requireValid(/^[a-zA-Z0-9-]{8,100}$/.test(scope.requestId || '') && Array.isArray(edits) && edits.length<=128);
  const result=clone(base);
  const locate=id=>{for(const chapter of result.chapters){const index=chapter.content.findIndex(b=>b.blockId===id);if(index>=0)return {chapter,index,block:chapter.content[index]};}throw protocolError();};
  edits.forEach((edit,operationIndex)=>{
    const fields={edit:['action','blockId','text'],merge:['action','blockIds','text'],appendOwn:['action','chapterId','text']}[edit?.action];
    requireValid(fields && Object.keys(edit).every(key=>fields.includes(key)) && typeof edit.text==='string' && edit.text.length<=20000);
    if(edit.action==='edit') {
      const target=locate(edit.blockId);requireValid(typeof target.block.text==='string');target.block.text=edit.text;
    } else if(edit.action==='merge') {
      requireValid(Array.isArray(edit.blockIds) && edit.blockIds.length>=2 && edit.blockIds.length<=64 && new Set(edit.blockIds).size===edit.blockIds.length);
      const targets=edit.blockIds.map(locate), first=targets[0];
      requireValid(targets.every(t=>t.chapter===first.chapter && typeof t.block.text==='string'));
      const inherited=[...new Set(targets.flatMap(t=>t.block.sourceIds))].sort();requireValid(sources(inherited));
      const indexes=targets.map(t=>t.index), destination=Math.min(...indexes);
      first.chapter.content=first.chapter.content.flatMap((item,index)=>index===destination?[{text:edit.text,blockId:blockId([scope.familyId,scope.storyId,scope.requestId,operationIndex]),sourceIds:inherited}]:indexes.includes(index)?[]:[item]);
    } else {
      const chapter=result.chapters.find(c=>c.id===edit.chapterId);requireValid(chapter);
      chapter.content.push({text:edit.text,blockId:blockId([scope.familyId,scope.storyId,scope.requestId,operationIndex]),sourceIds:[]});
    }
  });
  Object.assign(result,core.flatten(result.chapters));validateProtected(result);
  return result;
}
// Legacy full-draft writes cannot safely preserve provenance. Fail before any
// update rather than silently treating a stripped received block as own text.
function assertLegacyWritable(story, draft) {
  const marked=value=>value&&(value.blockId!==undefined||value.sourceIds!==undefined||value.provenanceVersion!==undefined);
  if (story?.sourcePolicyRequired || marked(story) || marked(draft) || draft?.content?.some(marked) ||
      draft?.chapters?.some(c=>marked(c)||c.content?.some(marked))) throw protocolError();
}
// Immutable policy receipts survive source deletion and access revocation.
// Traversal never consults mutable original story/grant records.
async function allowsSources(reader, roots, action) {
  if(!ACTIONS.has(action) || !sources(roots))return false;
  const cache=new Map(),memo=new Map();let edges=0;
  async function visit(id,depth,path) {
    if(depth>8 || path.has(id) || ++edges>256)return false;
    const key=id+':'+depth;if(memo.has(key))return memo.get(key);
    if(!cache.has(id)) {
      if(cache.size>=64)return false;
      cache.set(id,await reader.get('story_source_policies',id));
    }
    const policy=cache.get(id);
    if(policy?.version!==1 || policy.permissions?.[action]!==true || !sources(policy.parents) || policy.parents.length>16)return false;
    const next=new Set(path);next.add(id);
    for(const parent of policy.parents)if(!await visit(parent,depth+1,next))return false;
    memo.set(key,true);return true;
  }
  try {for(const root of roots)if(!await visit(root,0,new Set()))return false;return true;}catch{return false;}
}
module.exports={materializeOwnedDraft,applyBlockEdits,allowsSources,assertLegacyWritable,protocolError};
