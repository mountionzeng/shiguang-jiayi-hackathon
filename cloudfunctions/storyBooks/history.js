const { identityError } = require('./identity');
const SUMMARY_FIELDS = { familyId:true, storyId:true, 'revision.id':true, 'revision.storyId':true,
  'revision.kind':true, 'revision.label':true, 'revision.savedAt':true };

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
  const rows=await repo.all('biography_drafts',ctx.familyId,SUMMARY_FIELDS,{storyId:story.id});
  const history=rows.filter(matches).map(({revision:r})=>({id:r.id,storyId:r.storyId,kind:r.kind,label:r.label,savedAt:r.savedAt}));
  history.sort((a,b)=>String(b.savedAt).localeCompare(String(a.savedAt)) || b.id.localeCompare(a.id));
  return {history};
}
module.exports={readHistory};
