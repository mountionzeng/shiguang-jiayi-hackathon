const {ownNamesByPrincipal}=require('./displayNames');
const {summarizeChanges}=require('./revisionAttribution');
const { identityError } = require('./identity');
const SUMMARY_FIELDS = { familyId:true, storyId:true, 'revision.id':true, 'revision.storyId':true,
  'revision.kind':true, 'revision.label':true, 'revision.savedAt':true, 'revision.editedByPrincipalId':true, 'revision.editorName':true, 'revision.changeSummary':true, 'revision.receivedFromName':true };

// Called inside the service's existing before/after owner guards. Every detail
// read is authorized again; a list response never grants access to a revision.
async function readHistory(repo, ctx, input) {
  if (!/^story-[a-z0-9-]{1,100}$/.test(input.storyId || '')) throw identityError();
  const story = await repo.get('stories',ctx.familyId+'_'+input.storyId);
  if (!story || story.familyId!==ctx.familyId || story.id!==input.storyId || story.deletedAt) throw identityError();
  const matches = record => record?.familyId===ctx.familyId && record.storyId===story.id &&
    record.revision?.storyId===story.id && typeof record.revision.id==='string';
  if (input.action==='revision') {
    if (!/^revision-[a-zA-Z0-9-]{1,120}$/.test(input.revisionId || '')) throw identityError();
    const record=await repo.get('biography_drafts',ctx.familyId+'_'+input.revisionId);
    if (!matches(record) || record.revision.id!==input.revisionId || !record.revision.draft) throw identityError();
    return {revision:record.revision};
  }
  const rows=await repo.all('biography_drafts',ctx.familyId,SUMMARY_FIELDS);
  const selected=rows.filter(matches);
  const names=await ownNamesByPrincipal(repo,selected.map(row=>row.revision.editedByPrincipalId));
  const optionalRows=async table=>{try{return await repo.all(table,ctx.familyId);}catch(error){if(/collection.*(?:not exist|not found)|DATABASE_COLLECTION_NOT_EXIST/i.test(String(error?.message||error?.errMsg||error)))return [];throw error;}};
  const [copies,edits]=await Promise.all([optionalRows('story_copies'),optionalRows('story_chapter_edits')]);
  const copiesByRevision=new Map(copies.filter(c=>c.storyId===story.id).map(c=>[c.revisionId,c]));
  const editsByRevision=new Map(edits.filter(e=>e.storyId===story.id).map(e=>[e.revisionId,e]));
  const history=selected.map(({revision:r})=>({id:r.id,storyId:r.storyId,kind:r.kind,label:r.label,savedAt:r.savedAt,
    editorName:names.get(r.editedByPrincipalId)||r.editorName||(r.editedByPrincipalId===ctx.principalId&&ctx.principalId?'你':''),
    receivedFromName:r.receivedFromName||copiesByRevision.get(r.id)?.senderName||'',
    changeSummary:r.changeSummary||(editsByRevision.get(r.id)?.changes
      ?summarizeChanges(editsByRevision.get(r.id).changes):'')}));
  history.sort((a,b)=>String(b.savedAt).localeCompare(String(a.savedAt)) || b.id.localeCompare(a.id));
  return {history};
}
module.exports={readHistory};
