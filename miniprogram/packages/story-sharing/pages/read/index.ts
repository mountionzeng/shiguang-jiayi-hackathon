import {storySharing,SharedChapter,sharingHome,invitationPath,storyReceivePath} from '../../../../services/storySharing';
type EditBlock={index:number;text:string};
type LocalDraft={title:string;textBlocks:EditBlock[];revisionId:string;version:number;requestId:string};
Page({
  data:{loading:false,title:'',chapters:[] as SharedChapter[],notice:'',canInvite:false,canEdit:false,canCopy:false,busy:false,shareReady:false,
    editChapterId:'',editTitle:'',editBlocks:[] as EditBlock[]},
  familyId:'',storyId:'',revisionId:'',version:0,draftScope:'',epoch:0,hidden:false,shareToken:'',editRequestId:'',editBaseRevisionId:'',editBaseVersion:0,
  onLoad(options:{familyId?:string;storyId?:string}={}){this.familyId=options.familyId || '';this.storyId=options.storyId || '';wx.hideShareMenu();},
  onShow(){this.hidden=false;if(!this.data.editChapterId)void this.refresh();},
  onHide(){this.hidden=true;this.epoch++;this.shareToken='';this.revisionId='';this.version=0;this.draftScope='';this.setData({title:'',chapters:[],loading:false,canInvite:false,canEdit:false,canCopy:false,busy:false,shareReady:false,editChapterId:'',editTitle:'',editBlocks:[]});},
  onUnload(){this.onHide();},
  async refresh(){
    const epoch=++this.epoch;this.shareToken='';this.setData({loading:true,title:'',chapters:[],notice:'',canInvite:false,canEdit:false,canCopy:false,shareReady:false});
    try {const result=await storySharing.read(this.familyId,this.storyId);if(this.hidden || epoch!==this.epoch)return;
      this.revisionId=result.revisionId;this.version=result.story.version;this.draftScope=result.draftScope;
      this.setData({title:result.story.title,chapters:result.chapters,canInvite:result.capabilities?.requestInvitation===true,
        canEdit:result.capabilities?.sharedEdit===true,canCopy:result.capabilities?.copy===true});}
    catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'暂时无法读取，请重试'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({loading:false});}
  },
  receiveCopy(){if(this.data.canCopy && !this.data.loading && !this.data.busy)wx.navigateTo({url:storyReceivePath(this.familyId,this.storyId)});},
  draftKey(chapterId:string){return `story-shared-draft:${this.draftScope}:${chapterId}`;},
  storeDraft(){
    if(!this.data.editChapterId || !this.draftScope)return;
    const draft:LocalDraft={title:this.data.editTitle,textBlocks:this.data.editBlocks.map(block=>({...block})),revisionId:this.editBaseRevisionId,version:this.editBaseVersion,requestId:this.editRequestId};
    try{wx.setStorageSync(this.draftKey(this.data.editChapterId),draft);}catch{this.setData({notice:'修改仍在当前页面，但本机空间不足，离开前请保存。'});}
  },
  beginEdit(event:WechatMiniprogram.TouchEvent){
    if(!this.data.canEdit || this.data.busy)return;
    const chapterId=String(event.currentTarget.dataset.id || ''),chapter=this.data.chapters.find(item=>item.id===chapterId);if(!chapter)return;
    let draft:LocalDraft|undefined;
    try{const saved=wx.getStorageSync(this.draftKey(chapterId)) as LocalDraft|undefined;if(saved && typeof saved.title==='string' && Array.isArray(saved.textBlocks) && typeof saved.revisionId==='string' && Number.isSafeInteger(saved.version))draft=saved;}catch{}
    this.editRequestId=draft?.requestId || 'collab-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
    this.editBaseRevisionId=draft?.revisionId || this.revisionId;this.editBaseVersion=draft?.version || this.version;
    this.setData({editChapterId:chapterId,editTitle:draft?.title ?? chapter.title,editBlocks:(draft?.textBlocks ?? chapter.textBlocks).map(block=>({...block})),
      notice:draft?'已恢复这台设备上未保存的修改。请核对后保存。':''});
  },
  editTitle(event:WechatMiniprogram.Input){this.setData({editTitle:event.detail.value});this.storeDraft();},
  editBlock(event:WechatMiniprogram.CustomEvent<{value:string}>){
    const index=Number(event.currentTarget.dataset.index);this.setData({editBlocks:this.data.editBlocks.map(block=>block.index===index?{...block,text:event.detail.value}:block)});this.storeDraft();
  },
  cancelEdit(){this.setData({editChapterId:'',editTitle:'',editBlocks:[],notice:'修改已留在本机，下次仍可继续。'});},
  async saveEdit(){
    if(!this.data.editChapterId || this.data.busy || !this.data.canEdit)return;this.storeDraft();const epoch=this.epoch;this.setData({busy:true,notice:''});
    try{await storySharing.edit({familyId:this.familyId,storyId:this.storyId,chapterId:this.data.editChapterId,revisionId:this.editBaseRevisionId,
      expectedVersion:this.editBaseVersion,requestId:this.editRequestId,title:this.data.editTitle,textBlocks:this.data.editBlocks});
      if(this.hidden || epoch!==this.epoch)return;try{wx.removeStorageSync(this.draftKey(this.data.editChapterId));}catch{}
      this.setData({editChapterId:'',editTitle:'',editBlocks:[],notice:'修改已保存为新版本，并记录了实际编辑人。'});await this.refresh();}
    catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:(error instanceof Error?error.message:'保存失败')+'。修改仍保留在本机。'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
  async createInvitation(){
    if(!this.data.canInvite || this.data.busy || this.data.loading)return;
    const epoch=this.epoch;this.setData({busy:true});
    try {const result=await storySharing.create(this.familyId,this.storyId,this.data.chapters.map(c=>c.id),false);if(this.hidden || epoch!==this.epoch)return;this.shareToken=result.token;this.setData({shareReady:true,notice:'新邀请只申请阅读这些章节，仍需原主人核对确认。'});}
    catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'暂时无法创建邀请'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
  onShareAppMessage(){return this.shareToken && this.data.shareReady?{...sharingHome,title:'邀请你阅读一段故事',path:invitationPath(this.shareToken)}:sharingHome;},
  onShareTimeline(){return {title:sharingHome.title,imageUrl:sharingHome.imageUrl};},
});
