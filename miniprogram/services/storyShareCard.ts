export type ShareCardBlock = {blockId:string;kind:'text'|'photo';preview?:string;characterCount?:number;photoId?:string;publishable:boolean};
export type ShareCardChapter = {id:string;title:string;blocks:ShareCardBlock[]};
export type ShareCardSource = {story:{id:string;title:string;version:number};revisionId:string;chapters:ShareCardChapter[]};
export type ShareCardDescriptor = {id:string;version:1;storyId:string;revisionId:string;storyVersion:number;chapterId:string;title:string;chapterTitle:string;byline:string;paragraphs:string[];photos:Array<{photoId:string;blockId:string}>};
export type ShareCardSelection = {familyId?:string;storyId:string;revisionId:string;chapterId:string;blockIds:string[];photoIds:string[]};
async function call<T>(action:string,data:Record<string,unknown>):Promise<T>{
  if(!wx.cloud)throw new Error('当前版本暂不支持故事卡片');
  const response=await wx.cloud.callFunction({name:'storyBooks',data:{...data,action}});
  const result=response.result as {error?:string;message?:string;code?:string}|undefined;
  if(!result || result.error)throw Object.assign(new Error(result?.message || '故事卡片暂不可用，请稍后重试'),{code:result?.code});
  return result as T;
}
export const storyShareCard={
  source:async(storyId:string,familyId?:string)=>{
    const capabilities=await call<{shareCard?:boolean}>('capabilities',{});
    if(capabilities.shareCard!==true)throw new Error('故事卡片尚未开放。已有故事不受影响。');
    return call<ShareCardSource>('shareCardSource',{storyId,...(familyId?{familyId}:{})});
  },
  preview:(selection:ShareCardSelection)=>call<{descriptor:ShareCardDescriptor}>('shareCardPreview',selection),
  material:(selection:ShareCardSelection,descriptorId:string)=>call<{descriptor:ShareCardDescriptor;media:Array<{photoId:string;url:string;requestedMaxAgeSeconds:number}>}>('shareCardExport',{...selection,descriptorId}),
};
