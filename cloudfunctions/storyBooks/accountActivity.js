const crypto=require('node:crypto');
const {assertSpaceOwner}=require('./identity');
const {moduleChanges}=require('./article');
const {ownNamesByPrincipal}=require('./displayNames');
const key=(family,id)=>crypto.createHash('sha256').update(JSON.stringify([family,id])).digest('hex');
const clip=text=>String(text||'').slice(0,800);
async function accountActivity(repo,ctx){
  await assertSpaceOwner(repo,ctx);
  const tables=['account_message_receipts','story_returns','story_copies','biography_drafts','memories','family_members','stories'];
  for(const table of tables.slice(0,3))await repo.ensureCollection?.(table);
  const [deliveries,returns,copies,revisions,memories,members,stories]=await Promise.all(tables.map(table=>repo.all(table,ctx.familyId)));
  const events=[];
  for(const row of deliveries){
    if(row.direction!=='received')continue;
    const pkg=row.package;
    if(!pkg)continue;
    const previous=deliveries.find(item=>item.package?.packageId===pkg.lineage?.parentPackageId)?.package;
    const changes=[];
    if(row.kind==='return'&&previous)for(const chapter of pkg.chapters||[]){
      const before=previous.chapters?.find(c=>c.chapterId===chapter.chapterId);
      if(before)changes.push(...moduleChanges({title:before.title,content:before.blocks.map(b=>({blockId:b.blockId,...(b.type==='text'?{text:b.text}:{photoId:b.assetId})})),layout:before.layout},
        {title:chapter.title,content:chapter.blocks.map(b=>({blockId:b.blockId,...(b.type==='text'?{text:b.text}:{photoId:b.assetId})})),layout:chapter.layout}));
    }
    events.push({id:row._id,accountKey:row.senderKey?'web:'+row.senderKey:'unknown:'+row._id,name:row.senderName||'未记录称呼的账号',verified:Boolean(row.senderKey),
      at:row.createdAt,kind:row.kind==='return'?'发来修改':'发来文章',title:pkg.storyTitle||pkg.chapters?.[0]?.title||'文章',
      text:clip(pkg.chapters?.flatMap(c=>c.blocks.filter(b=>b.type==='text').map(b=>b.text)).join('\n')),imageCount:pkg.assets?.length||0,
      changes:changes.slice(0,30).map(c=>({...c,before:clip(c.before),after:clip(c.after)})),comparisonAvailable:row.kind!=='return'||Boolean(previous),revisionId:'',storyId:''});
  }
  for(const row of returns)events.push({id:row._id,accountKey:'principal:'+row.senderPrincipalId,name:row.senderName||'亲友',verified:Boolean(row.senderPrincipalId),at:row.createdAt,kind:'发来修改',title:'故事回信',text:clip((row.blocks||[]).map(b=>b.text).join('\n')),imageCount:0,changes:(row.sourceEdits||[]).map(b=>({kind:'text',action:'changed',before:'',after:clip(b.text)})),comparisonAvailable:false,storyId:row.sourceStoryId,revisionId:row.resultRevisionId||''});
  for(const row of copies){
    const source=stories.find(story=>story.id===row.storyId)?.receivedSources?.[0];
    const sourcePrincipalId=row.sourcePrincipalId||source?.sourceOwnerPrincipalId;
    const revision=revisions.find(r=>r.revision?.id===row.revisionId)?.revision;
    events.push({id:row._id,accountKey:sourcePrincipalId?'principal:'+sourcePrincipalId:'unknown-copy:'+row._id,name:row.senderName||source?.senderName||'来源账号未记录',verified:Boolean(sourcePrincipalId),at:row.createdAt,kind:'发来文章',title:revision?.draft?.title||'文章',text:clip(revision?.draft?.paragraphs?.join('\n')),imageCount:revision?.draft?.chapters?.reduce((n,c)=>n+c.content.filter(b=>b.photoId).length,0)||0,changes:[],comparisonAvailable:true,storyId:row.storyId,revisionId:row.revisionId});
  }
  for(const row of revisions){
    const revision=row.revision;
    if(!revision?.editedByPrincipalId||revision.editedByPrincipalId===ctx.principalId)continue;
    const previous=revisions.find(r=>r.revision?.id===revision.sourceRevisionId)?.revision;
    const changes=[];
    if(previous)for(const chapter of revision.draft?.chapters||[]){const before=previous.draft?.chapters?.find(c=>c.id===chapter.id);if(before)changes.push(...moduleChanges(before,chapter));}
    events.push({id:revision.id,accountKey:'principal:'+revision.editedByPrincipalId,name:'亲友',verified:true,at:revision.savedAt,kind:'修改了文章',title:revision.draft?.title||'文章',text:'',imageCount:0,changes:changes.slice(0,30).map(c=>({...c,before:clip(c.before),after:clip(c.after)})),comparisonAvailable:Boolean(previous),storyId:revision.storyId,revisionId:revision.id});
  }
  for(const memory of memories){
    const member=members.find(m=>(m.memberId||m.id)===memory.authorMemberId);
    if(!member||member.role==='owner'||memory.deletedAt)continue;
    const actor=member.accountId||member.userAccountId;
    events.push({id:memory._id,accountKey:actor?'account:'+actor:'unverified-member:'+memory.authorMemberId,name:memory.authorName||member.name||'亲友',verified:Boolean(actor),at:memory.createdAt,kind:'发来记忆',title:memory.title||'一段记忆',text:clip(memory.text),imageCount:memory.photoIds?.length||0,changes:[],comparisonAvailable:true,storyId:memory.sourceStoryId||'',revisionId:memory.sourceRevisionId||''});
  }
  for(const event of events){
    if(event.storyId)continue;
    const receipt=deliveries.find(row=>row._id===event.id);
    const matched=revisions.find(row=>row.revision?.draft?.chapters?.some(chapter=>chapter.packageLineage?.receivedPackageId===receipt?.packageId));
    if(matched){event.storyId=matched.storyId;event.revisionId=matched.revision.id;}
  }
  const principals=events.filter(e=>e.accountKey.startsWith('principal:')).map(e=>e.accountKey.slice(10));
  const names=await ownNamesByPrincipal(repo,principals);
  return {events:events.sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,200).map(event=>({...event,name:names.get(event.accountKey.slice(10))||event.name,accountKey:key(ctx.familyId,event.accountKey)}))};
}
module.exports={accountActivity};
