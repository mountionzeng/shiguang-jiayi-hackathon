import {storySharing,Invitation,InviteStatus,sharingHome,invitationPath,sharedReadPath} from '../../../../services/storySharing';
import {storyCopies,StoryReturn,copyRequestId} from '../../../../services/storyCopies';
const statusLabel=(status:string)=>({pending:'等待主人确认',approved:'已获准阅读',rejected:'申请未通过',revoked:'已撤销',expired:'已过期',unrequested:'等待申请'}[status] || '暂不可用');
Page({
  data:{recipient:false,available:false,loading:false,busy:false,title:'',notice:'',displayName:'',forward:false,edit:false,editAvailable:false,copy:false,copyAvailable:false,shareReady:false,
    chapters:[] as Array<{id:string;title:string;checked:boolean}>,invitations:[] as Array<Invitation & {label:string}>,returns:[] as StoryReturn[],status:null as InviteStatus|null,statusText:''},
  storyId:'',familyId:'',token:'',shareToken:'',epoch:0,hidden:false,
  returnDecisionRequests:{} as Record<string,string>,
  onLoad(options:{storyId?:string;token?:string}={}) {
    this.storyId=options.storyId || '';this.token=options.token || '';
    this.setData({recipient:Boolean(this.token)});wx.hideShareMenu();
  },
  onShow(){this.hidden=false;void this.refresh();},
  onHide(){this.hidden=true;this.epoch++;this.shareToken='';this.familyId='';this.setData({title:'',chapters:[],invitations:[],returns:[],status:null,statusText:'',displayName:'',forward:false,edit:false,editAvailable:false,copy:false,copyAvailable:false,shareReady:false,available:false,busy:false});},
  onUnload(){this.onHide();this.token='';},
  async refresh() {
    const epoch=++this.epoch;this.shareToken='';
    this.setData({loading:true,notice:'',available:false,title:'',chapters:[],invitations:[],returns:[],status:null,statusText:'',forward:false,edit:false,editAvailable:false,copy:false,copyAvailable:false,shareReady:false});
    try {
      const caps=await storySharing.capabilities();if(this.hidden || epoch!==this.epoch)return;
      if(!caps.invitations || !caps.familyId){this.setData({notice:'亲友邀请尚未开放。已有故事不受影响。'});return;}
      this.familyId=caps.familyId;this.setData({editAvailable:caps.sharedEdit===true,copyAvailable:caps.copy===true});
      if(this.data.recipient) {
        const status=await storySharing.status(this.token);if(this.hidden || epoch!==this.epoch)return;
        this.setData({status,statusText:statusLabel(status.status),available:true});
      } else {
        const result=await storySharing.manage(this.familyId,this.storyId);if(this.hidden || epoch!==this.epoch)return;
        const returns=caps.copy?(await storyCopies.returns()).returns.filter(item=>item.sourceStoryId===this.storyId):[];if(this.hidden || epoch!==this.epoch)return;
        this.setData({available:true,title:result.story.title,chapters:result.chapters.map(c=>({...c,checked:false})),invitations:result.invitations.map(i=>({...i,label:statusLabel(i.status)})),returns});
      }
    } catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'暂时打不开邀请'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({loading:false});}
  },
  chooseChapters(event:WechatMiniprogram.CustomEvent<{value:string[]}>) {this.setData({chapters:this.data.chapters.map(c=>({...c,checked:event.detail.value.includes(c.id)}))});},
  chooseForward(event:WechatMiniprogram.CustomEvent<{value:boolean}>) {this.setData({forward:event.detail.value});},
  chooseEdit(event:WechatMiniprogram.CustomEvent<{value:boolean}>) {this.setData({edit:event.detail.value});},
  chooseCopy(event:WechatMiniprogram.CustomEvent<{value:boolean}>) {this.setData({copy:event.detail.value});},
  enterName(event:WechatMiniprogram.Input){this.setData({displayName:event.detail.value});},
  async create() {
    if(this.data.busy || !this.data.available || this.data.recipient)return;
    const ids=this.data.chapters.filter(c=>c.checked).map(c=>c.id);
    if(!ids.length){this.setData({notice:'请先选择至少一个章节。'});return;}
    const epoch=this.epoch;this.setData({busy:true,notice:'',shareReady:false});this.shareToken='';
    try {
      const result=await storySharing.create(this.familyId,this.storyId,ids,this.data.forward,this.data.editAvailable && this.data.edit,this.data.copyAvailable && this.data.copy);
      if(this.hidden || epoch!==this.epoch)return;
      this.shareToken=result.token;this.setData({shareReady:true,notice:'邀请已生成，24 小时内可申请。发给亲友后，请回到这里刷新并确认申请。'});
    }catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'生成失败；请刷新查看是否已创建，避免重复生成'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
  async apply() {
    if(this.data.busy || !this.data.available || !this.data.recipient)return;
    const epoch=this.epoch;this.setData({busy:true,notice:''});
    try {const status=await storySharing.apply(this.token,this.data.displayName);if(this.hidden || epoch!==this.epoch)return;this.setData({status,statusText:statusLabel(status.status)});}
    catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'申请未完成，请重试'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
  async decide(event:WechatMiniprogram.TouchEvent) {
    if(this.data.busy || !this.data.available)return;
    const {invitationId,applicantId,decision}=event.currentTarget.dataset;
    if(decision!=='approve' && decision!=='reject')return;
    const invitation=this.data.invitations.find(i=>i.invitationId===invitationId), applicant=invitation?.applicants.find(a=>a.applicantId===applicantId);
    if(!applicant)return;
    const epoch=this.epoch;this.setData({busy:true});
    try {
      const confirmation=await new Promise<WechatMiniprogram.ShowModalSuccessCallbackResult>((resolve,reject)=>wx.showModal({
        title:decision==='approve'?'核对这位亲友':'拒绝这次申请？',
        content:decision==='approve'?'请通过微信聊天或电话，向本人索取申请页上的 8 位核对码。称呼由申请人填写，不能单凭称呼认人。':'拒绝后，对方无法通过这份邀请重新申请。',
        editable:decision==='approve',placeholderText:'输入亲友发来的核对码',confirmText:decision==='approve'?'确认授权':'拒绝申请',success:resolve,fail:reject}));
      if(!confirmation.confirm || this.hidden || epoch!==this.epoch)return;
      const code=decision==='approve'?(confirmation.content || '').trim():applicant.verificationCode;
      if(code!==applicant.verificationCode){this.setData({notice:'核对码不一致，没有发放权限。请再向本人确认。'});return;}
      await storySharing.decide(this.familyId,this.storyId,invitationId,applicantId,decision,code);
      if(!this.hidden && epoch===this.epoch){this.setData({busy:false});await this.refresh();}
    }catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'操作未完成，请刷新后重试'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
  async revoke(event:WechatMiniprogram.TouchEvent) {
    if(this.data.busy || !this.data.available)return;
    const epoch=this.epoch;this.setData({busy:true});
    try {
      const confirmed=await new Promise<boolean>((resolve,reject)=>wx.showModal({title:'撤销这份邀请？',content:'尚未通过的申请将失效，已获准的亲友也不能再读取原稿。',success:r=>resolve(r.confirm),fail:reject}));
      if(!confirmed || this.hidden || epoch!==this.epoch)return;
      await storySharing.revoke(this.familyId,this.storyId,event.currentTarget.dataset.invitationId);
      if(!this.hidden && epoch===this.epoch){this.shareToken='';this.setData({shareReady:false,busy:false});await this.refresh();}
    }catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'撤销失败，请重试'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
  async decideReturn(event:WechatMiniprogram.TouchEvent){
    if(this.data.busy)return;const {returnId,decision}=event.currentTarget.dataset;if(decision!=='accept'&&decision!=='reject')return;
    const item=this.data.returns.find(value=>value.returnId===returnId);if(!item||item.status!=='pending')return;
    const confirmed=await new Promise<boolean>(resolve=>wx.showModal({title:decision==='accept'?'收进原故事？':'不收这段补充？',
      content:decision==='accept'?'会在原章节末尾生成一个新版本，旧版本仍会保留。':'原故事不会改变，对方已保存的故事也不受影响。',
      confirmText:decision==='accept'?'收下':'不收',success:r=>resolve(r.confirm),fail:()=>resolve(false)}));if(!confirmed)return;
    const key=returnId+':'+decision;if(!this.returnDecisionRequests[key])this.returnDecisionRequests[key]=copyRequestId().replace(/^receive-/,"decision-");
    const epoch=this.epoch;this.setData({busy:true,notice:''});
    try{await storyCopies.decideReturn({returnId,decision,requestId:this.returnDecisionRequests[key]});delete this.returnDecisionRequests[key];if(!this.hidden&&epoch===this.epoch){this.setData({busy:false});await this.refresh();}}
    catch(error){if(!this.hidden&&epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'操作未确认，请重试'});}
    finally{if(!this.hidden&&epoch===this.epoch)this.setData({busy:false});}
  },
  openStory(){const s=this.data.status;if(s?.status==='approved' && s.familyId && s.storyId)wx.navigateTo({url:sharedReadPath(s.familyId,s.storyId)});},
  onShareAppMessage(){return this.shareToken && this.data.shareReady?{...sharingHome,title:'邀请你阅读一段故事',path:invitationPath(this.shareToken)}:sharingHome;},
  onShareTimeline(){return {title:sharingHome.title,imageUrl:sharingHome.imageUrl};},
});
