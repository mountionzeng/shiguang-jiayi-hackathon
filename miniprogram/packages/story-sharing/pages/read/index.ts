import {displayLines} from "../../../../services/lineContext";
import {storySharing,SharedChapter,sharingHome,invitationPath} from '../../../../services/storySharing';
import {newStoryId} from '../../../../services/storyRecords';
import {saveCurrentStoryId} from '../../../../services/storySelection';
import {copyRequestId,storyCopies} from '../../../../services/storyCopies';
type EditBlock={index:number;text:string};
type LocalDraft={title:string;textBlocks:EditBlock[];revisionId:string;version:number;requestId:string};
Page({
  data:{loading:false,title:'',chapters:[] as SharedChapter[],readingLines:{} as Record<string,Array<{text:string}>>,notice:'',canInvite:false,canEdit:false,canCopy:false,busy:false,shareReady:false,
    editChapterId:'',editTitle:'',editBlocks:[] as EditBlock[]},
  keepRequestId:'',keepStoryId:'',
  familyId:'',storyId:'',revisionId:'',version:0,draftScope:'',epoch:0,hidden:false,shareToken:'',editRequestId:'',editBaseRevisionId:'',editBaseVersion:0,
  onLoad(options:{familyId?:string;storyId?:string}={}){this.familyId=options.familyId || '';this.storyId=options.storyId || '';wx.hideShareMenu();},
  onShow(){this.hidden=false;if(!this.data.editChapterId)void this.refresh();},
  onHide(){this.hidden=true;this.epoch++;this.shareToken='';this.revisionId='';this.version=0;this.draftScope='';this.setData({title:'',chapters:[],readingLines:{},loading:false,canInvite:false,canEdit:false,canCopy:false,busy:false,shareReady:false,editChapterId:'',editTitle:'',editBlocks:[]});},
  onUnload(){this.onHide();},
  async refresh(){
    const epoch=++this.epoch;this.shareToken='';this.setData({loading:true,title:'',chapters:[],notice:'',canInvite:false,canEdit:false,canCopy:false,shareReady:false});
    try {const result=await storySharing.read(this.familyId,this.storyId);if(this.hidden || epoch!==this.epoch)return;
      this.revisionId=result.revisionId;this.version=result.story.version;this.draftScope=result.draftScope;
      this.setData({title:result.story.title,chapters:result.chapters,readingLines:Object.fromEntries(result.chapters.map(chapter=>[chapter.id,displayLines(chapter.content)])),canInvite:result.capabilities?.requestInvitation===true,
        canEdit:result.capabilities?.sharedEdit===true,canCopy:result.capabilities?.copy===true});}
    catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'暂时无法读取，请重试'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({loading:false});}
  },
  /**
   * 保留或扩写：一键把这份文章收成朋友自己的故事，不问章节、不问放哪、不问名字。
   * 同一个请求号重试不会重复收；书名撞上朋友自己的另一本书时，自动加编号再试。
   * 保留 → 回到小程序首页（那里就是 ta 自己的书）；扩写 → 直接进入第一章接着写。
   */
  async keep(event:WechatMiniprogram.TouchEvent){
    const intent=String(event.currentTarget.dataset.intent || 'keep');
    if(!this.data.canCopy || this.data.loading || this.data.busy || !this.data.chapters.length)return;
    const epoch=this.epoch,chapterIds=this.data.chapters.map(chapter=>chapter.id),base=(this.data.title || '亲友的故事').slice(0,36);
    this.setData({busy:true,notice:'正在收进你的书里…'});
    try{
      let result:{storyId:string}|undefined;
      for(let attempt=1;attempt<=3 && !result;attempt++){
        const title=attempt===1?base:`${base}·${attempt}`;
        try{result=await storyCopies.receive({sourceFamilyId:this.familyId,sourceStoryId:this.storyId,sourceRevisionId:this.revisionId,chapterIds,
          requestId:this.keepRequestId || (this.keepRequestId=copyRequestId()),target:{mode:'new',storyId:this.keepStoryId || (this.keepStoryId=newStoryId()),title}});}
        catch(error){if((error as {code?:string}).code!=='DUPLICATE_TITLE' || attempt===3)throw error;this.keepRequestId='';this.keepStoryId='';}
      }
      if(this.hidden || epoch!==this.epoch || !result)return;
      saveCurrentStoryId(result.storyId);this.keepRequestId='';this.keepStoryId='';
      const book='/pages/book/book?storyId='+encodeURIComponent(result.storyId);
      wx.reLaunch({url:intent==='expand'?book+'&chapterId='+encodeURIComponent(this.data.chapters[0].id):'/pages/index/index'});
    }catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:(error instanceof Error?error.message:'没能收下')+'。可以直接重试，不会重复添加。'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
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
