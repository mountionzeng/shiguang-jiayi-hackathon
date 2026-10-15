export interface Applicant { applicantId:string; displayName:string; verificationCode:string; status:string }
export interface InvitedMember { name:string; active:boolean; chapterIds:string[]; permissions:{read:boolean;edit?:boolean;copy?:boolean} }
export interface Invitation { invitationId:string; status:string; expiresAtMs:number; chapterIds:string[]; permissions:{read:boolean;forward:boolean;edit?:boolean;copy?:boolean}; applicants:Applicant[]; member?:InvitedMember }
export interface ManagedStory { story:{id:string;title:string}; chapters:Array<{id:string;title:string}>; invitations:Invitation[] }
export interface InviteStatus { status:string; expiresAtMs:number; inviteeName?:string; displayName?:string; applicantId?:string; verificationCode?:string; familyId?:string; storyId?:string }
export interface ChapterChange { revisionId:string; by:string; savedAt:string; title?:{before:string;after:string}; blocks:Array<{index:number;before:string;after:string}> }
export interface SharedChapter { id:string; title:string; content:Array<{text:string;blockIndex?:number}>; textBlocks:Array<{index:number;text:string}> }
export interface SharedStory { story:{id:string;title:string;version:number}; revisionId:string; draftScope:string; chapters:SharedChapter[]; capabilities?:{requestInvitation?:boolean;sharedEdit?:boolean;copy?:boolean} }
export interface SharedExcerptInput {storyId:string;revisionId:string;expectedVersion:number;chapterId:string;text:string;recipientMemberIds:string[];requestId:string}
export const sharingHome = {title:'拾光家忆｜把重要的故事慢慢写下来',path:'/pages/index/index',imageUrl:'/assets/illustrations/story-book-cover.png'};
export const invitationPath = (token:string) => '/packages/story-sharing/pages/invite/index?token='+encodeURIComponent(token);
export const sharedReadPath = (familyId:string,storyId:string) => '/packages/story-sharing/pages/read/index?familyId='+encodeURIComponent(familyId)+'&storyId='+encodeURIComponent(storyId);
export const storyReceivePath = (familyId:string,storyId:string) => '/packages/story-sharing/pages/receive/index?familyId='+encodeURIComponent(familyId)+'&storyId='+encodeURIComponent(storyId);
async function call<T>(action:string,data:Record<string,unknown>={}):Promise<T> {
  if (!wx.cloud) throw new Error('当前版本暂不支持故事共享');
  const response=await wx.cloud.callFunction({name:'storyBooks',data:{...data,action}});
  const result=response.result as {error?:string;message?:string;code?:string}|undefined;
  if (!result || result.error) throw Object.assign(new Error(result?.message || '故事共享暂不可用，请稍后重试'),{code:result?.code});
  return result as T;
}
export const storySharing = {
  capabilities:()=>call<{invitations:boolean;sharedEdit:boolean;copy:boolean;familyId?:string}>('capabilities'),
  manage:(familyId:string,storyId:string)=>call<ManagedStory>('inviteManage',{familyId,storyId}),
  create:(familyId:string,storyId:string,chapterIds:string[],forward:boolean,edit=false,copy=false,inviteeName?:string)=>call<{token:string;invitationId:string}>('inviteCreate',{familyId,storyId,chapterIds,permissions:{read:true,forward,edit,copy},...(inviteeName?{inviteeName}:{})}),
  status:(token:string)=>call<InviteStatus>('inviteGet',{token}),
  accept:(token:string)=>call<InviteStatus>('inviteAccept',{token}),
  revoke:(familyId:string,storyId:string,invitationId:string)=>call('inviteRevoke',{familyId,storyId,invitationId}),
  chapterChanges:(familyId:string,storyId:string,chapterId:string)=>call<{changes:ChapterChange[]}>('chapterChanges',{familyId,storyId,chapterId}),
  setAccess:(familyId:string,storyId:string,invitationId:string,permissions:{read:true;edit:boolean;copy:boolean},chapterIds?:string[])=>call('inviteSetAccess',{familyId,storyId,invitationId,permissions,...(chapterIds?{chapterIds}:{})}),
  read:(familyId:string,storyId:string)=>call<SharedStory>('sharedRead',{familyId,storyId}),
  edit:(input:{familyId:string;storyId:string;chapterId:string;revisionId:string;expectedVersion:number;requestId:string;title:string;textBlocks:Array<{index:number;text:string}>})=>
    call<{ok:true;storyId:string;chapterId:string;revisionId:string;version:number}>('sharedEdit',input),
  shareExcerpt:(input:SharedExcerptInput)=>call<{ok:true;contributionId:string;recipientMemberIds:string[]}>('shareExcerpt',{...input}),
};
