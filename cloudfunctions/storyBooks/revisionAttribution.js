const {ownNamesByAccount}=require('./displayNames');
const {stable}=require('./core');
function summarizeChanges(changes=[]){
  const labels={text:'文字',image:'图片',title:'标题',layout:'排版'},actions={added:'新增',changed:'修改',removed:'删除'};
  const counts=new Map();
  for(const change of changes){if(!labels[change.kind]||!actions[change.action])continue;const key=change.action+':'+change.kind;counts.set(key,(counts.get(key)||0)+1);}
  return [...counts].map(([key,count])=>{const [action,kind]=key.split(':');return `${actions[action]} ${count} ${kind==='text'?'段':kind==='image'?'张':'处'}${labels[kind]}`;}).join('，')||'保存文章';
}
function draftSummary(before,after){
  if(!before)return '新建文章';
  const changes=[],prior=new Map((before.chapters||[]).map(c=>[c.id,c]));
  for(const chapter of after?.chapters||[]){const old=prior.get(chapter.id);prior.delete(chapter.id);
    if(!old){changes.push('新增章节');continue;}
    if(stable(old.content||[])!==stable(chapter.content||[]))changes.push('修改文字或图片');
    if(old.title!==chapter.title)changes.push('修改章节标题');
    if(stable(old.layout||null)!==stable(chapter.layout||null))changes.push('调整排版');
    if(old.backdropImageId!==chapter.backdropImageId)changes.push('更换底图');
  }
  if(prior.size)changes.push('删除章节');
  if(before.title!==after?.title)changes.push('修改书名');
  return [...new Set(changes)].join('，')||'保存文章';
}
async function revisionAttribution(reader,ctx,changeSummary,receivedFromName){
  const names=await ownNamesByAccount(reader,[ctx.accountId]);
  return {...(ctx.principalId?{editedByPrincipalId:ctx.principalId}:{}),editorName:names.get(ctx.accountId)||'',
    changeSummary:String(changeSummary||'保存文章').slice(0,200),
    ...(receivedFromName?{receivedFromName:Array.from(String(receivedFromName)).slice(0,40).join('')}:{})};
}
module.exports={revisionAttribution,summarizeChanges,draftSummary};
