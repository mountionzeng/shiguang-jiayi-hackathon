import {accountOwner, memoryPool, type BiographyDraft, type GenerationMode, type ManuscriptRevision} from '../domain/biography';
import {current, hash} from '../domain/storyBookCore';
import {draftWithChapters} from './chapters';
import {ensureStoryBooks, storyCommand} from './storyBooks';
import type {WritingDocumentPlan} from './articleFinalDocument';

/** Persist approved prose in one existing story-create transaction. */
export async function saveWritingDocument(plan: WritingDocumentPlan) {
  if (!plan.title.trim() || plan.title.length > 40 || !plan.sections.length ||
      plan.sections.some(section => !section.title.trim() || section.title.length > 40 || !section.text.trim()) ||
      plan.sections.reduce((total, section) => total + section.text.length, 0) > 20000) {
    throw new Error('文档标题或正文超出保存范围，请调整后再试。');
  }
  const state = await ensureStoryBooks();
  const initial = state.stories?.find(story => story.id === plan.storyId);
  if (initial?.deletedAt) throw new Error('这份文档在最近删除中，可以先恢复再打开。');
  const draft = draftWithChapters({title:plan.title, introduction:'', paragraphs:[], sourceCount:0, generatedAt:'', generationMode:'cloud-ai'},
    plan.sections.map((section,index) => ({id:`chapter-draft-${index + 1}`,title:section.title,memoryIds:[],
      content:[{text:section.text}], ...(index === 0 ? {generationMode:'cloud-ai' as const} : {handEdited:true})})));
  const revisionId = 'revision-' + hash(JSON.stringify([plan.storyId,draft]));
  const confirm = (state: Awaited<ReturnType<typeof ensureStoryBooks>>) => {
    const saved = current(state,plan.storyId);
    if (saved.revisionId !== revisionId || saved.draft?.title !== plan.title ||
        saved.draft.chapters?.length !== plan.sections.length ||
        !plan.sections.every((section,index) => {
          const chapter = saved.draft!.chapters![index];
          return chapter.title === section.title && chapter.content.length === 1 && chapter.content[0].text === section.text;
        })) throw new Error('文档保存结果尚未确认，定稿仍保留。');
    return {storyId:plan.storyId,title:plan.title};
  };
  if (initial) return confirm(state);
  const revision: ManuscriptRevision = {id:revisionId,memberId:'',storyId:plan.storyId,kind:'version',label:'确认定稿',
    savedAt:'',sourceFingerprint:'',draft};
  return confirm(await storyCommand({action:'create',storyId:plan.storyId,title:plan.title,writingMode:'creative',memoryIds:[],
    revision,requestId:revisionId}, {view:'home'}));
}

/** Write a complete story to the existing shelf, leaving its source memory untouched. */
export async function saveWritingStory(input:{storyId:string;revisionId:string;memoryId:string;title:string;text:string;generationMode:GenerationMode}) {
  const state=await ensureStoryBooks();
  const owner=accountOwner(state.members);
  const memory=memoryPool(state.contributions).find(m=>m.id===input.memoryId && m.authorMemberId===owner?.id);
  if(!memory)throw new Error('原始记忆已不可用，故事草稿仍保留');
  const existing=state.stories?.find(s=>s.id===input.storyId);
  if(existing?.deletedAt)throw new Error('这个故事已移入最近删除，草稿仍保留，请先恢复故事');
  const title=input.title.trim().slice(0,40) || '还没取名的故事';
  const body=input.text.trim();
  if(!body)throw new Error('故事正文不能为空');
  const saved=existing ? current(state,existing.id) : undefined;
  const chapter=saved?.draft?.chapters?.[0];
  if(existing && saved?.draft?.chapters?.length===1 && chapter?.title===title &&
    chapter.content.length===1 && chapter.content[0].text===body+'\n' && chapter.memoryIds.includes(input.memoryId)) {
    return {storyId:existing.id,revisionId:saved.revisionId}; // Also reconciles a lost write acknowledgement.
  }
  if(existing && (!input.revisionId || saved?.revisionId!==input.revisionId))throw new Error('故事已在别处修改，请从书架查看；这里的草稿仍保留');
  const draft:BiographyDraft=draftWithChapters({title,paragraphs:[],sourceCount:1,generatedAt:'',generationMode:input.generationMode},[
    {id:'chapter-writing',title,memoryIds:[input.memoryId],content:[{text:body+'\n'}],generationMode:input.generationMode},
  ]);
  const revisionId='revision-'+hash(JSON.stringify([input.storyId,input.revisionId,draft]));
  const revision:ManuscriptRevision={id:revisionId,memberId:'',storyId:input.storyId,kind:'version',label:'生成故事',savedAt:'',sourceFingerprint:'',draft};
  let command:Record<string,unknown>;
  if(existing)command={action:'save',storyId:existing.id,expectedVersion:existing.version,expectedRevisionId:input.revisionId,revision,requestId:revisionId};
  else {
    const duplicate=state.stories?.some(s=>!s.deletedAt && s.title===title);
    const shelfTitle=duplicate ? title.slice(0,30)+' · '+input.storyId.slice(-6) : title;
    command={action:'create',storyId:input.storyId,title:shelfTitle,writingMode:'creative',memoryIds:[input.memoryId],revision,requestId:revisionId};
  }
  const next=await storyCommand(command,{view:'home'});
  const confirmed=current(next,input.storyId);
  if(confirmed.revisionId!==revisionId)throw new Error('故事保存结果尚未确认，草稿仍保留，请点完成重试');
  return {storyId:input.storyId,revisionId};
}
