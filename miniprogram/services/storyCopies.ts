import { Story } from '../domain/biography';

export interface CopyTargetStory {id:string;title:string;bookTitle?:string;version:number;currentRevisionId:string}
export interface ReceiveStoryCopyInput {
  sourceFamilyId:string;sourceStoryId:string;sourceRevisionId:string;chapterIds:string[];requestId:string;
  target:{mode:'new';storyId:string;title:string}|{mode:'append';storyId:string;expectedVersion:number;expectedRevisionId:string};
}
export interface AppendOwnExperienceInput {storyId:string;revisionId:string;expectedVersion:number;chapterId:string;text:string;requestId:string}
export interface StoryReturn {returnId:string;status:'pending'|'accepted'|'rejected';sourceStoryId:string;sourceChapterId:string;blocks:Array<{blockId:string;text:string}>;createdAt:string;decidedAt:string;resultRevisionId:string}

async function call<T>(action:string,data:Record<string,unknown>={}):Promise<T>{
  if(!wx.cloud)throw new Error('当前版本暂不支持接收故事');
  const response=await wx.cloud.callFunction({name:'storyBooks',data:{...data,action}});
  const result=response.result as ({error?:string;code?:string;message?:string}&T)|undefined;
  if(!result || result.error)throw Object.assign(new Error(result?.message || '故事暂时没有保存，请稍后重试'),{code:result?.code});
  return result;
}

export const copyRequestId=()=>`receive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
export const storyCopies={
  async targets():Promise<CopyTargetStory[]>{
    const state=await call<{stories?:Story[]}>('state');
    return (state.stories || []).filter(story=>!story.deletedAt && Number.isSafeInteger(story.version)).map(story=>({id:story.id,title:story.title,bookTitle:story.bookTitle,
      version:story.version!,currentRevisionId:story.currentRevisionId || ''}));
  },
  receive:(input:ReceiveStoryCopyInput)=>call<{ok:true;storyId:string;revisionId:string;alreadyReceived:boolean}>('copyReceive',{...input}),
  appendOwn:(input:AppendOwnExperienceInput)=>call<{ok:true;storyId:string;revisionId:string;alreadyAppended:boolean}>('copyAppendOwn',{...input}),
  returnOwn:(input:{storyId:string;revisionId:string;expectedVersion:number;chapterId:string;requestId:string})=>call<{ok:true;returnId:string;status:string;alreadySent:boolean}>('copyReturnOwn',{...input}),
  returns:()=>call<{returns:StoryReturn[]}>('copyReturns'),
  decideReturn:(input:{returnId:string;decision:'accept'|'reject';requestId:string})=>call<{ok:true;status:string;revisionId:string;alreadyDecided:boolean}>('copyReturnDecision',{...input}),
};
