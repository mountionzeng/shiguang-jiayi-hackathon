const {assertSpaceOwner,identityError}=require('./identity');
const {allowsSources}=require('./provenance');
const fail=()=>{throw Object.assign(new Error('声音模块无效'),{code:'INVALID_INPUT'});};
const {validateAudioModules}=require('./core');
async function approveAudioModules(repo,ctx,storyId,before,after) {
  for(const m of after.audioModules || []) {
    const existing=before.audioModules?.find(old=>old.id===m.id);
    if(existing){if(existing.operationId!==m.operationId||existing.kind!==m.kind)fail();continue;}
    const op=await repo.get('audio_operations',m.operationId);
    if(!op||op.familyId!==ctx.familyId||op.storyId!==storyId||op.chapterId!==after.id||op.blockId!==m.afterBlockId||
      op.status!=='ready'||op.kind!==m.kind||!op.work?.fileID||!after.content.some(b=>b.blockId===m.afterBlockId))fail();
  }
}
async function readArticleAudio(repo,ctx,input,signMedia) {
  await assertSpaceOwner(repo,ctx);
  const story=await repo.get('stories',`${ctx.familyId}_${input.storyId}`);
  if(!story||story.deletedAt||story.familyId!==ctx.familyId)throw identityError();
  const record=await repo.get('biography_drafts',`${ctx.familyId}_${story.currentRevisionId}`);
  const chapter=record?.revision?.draft?.chapters?.find(c=>c.id===input.chapterId);
  const module=chapter?.audioModules?.find(m=>m.id===input.moduleId);
  if(!module||!await allowsSources(repo,chapter.content.flatMap(b=>b.sourceIds || []),'view'))throw identityError();
  const op=await repo.get('audio_operations',module.operationId);
  if(op?.status!=='ready'||op.kind!==module.kind||!/^cloud:\/\//.test(op.work?.fileID||''))throw identityError();
  const url=await signMedia(op.work.fileID,300);
  if(!/^https:\/\//.test(url))throw identityError();
  return {url};
}
module.exports={validateAudioModules,approveAudioModules,readArticleAudio};
