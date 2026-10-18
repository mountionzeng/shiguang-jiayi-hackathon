import { BookPerson, Invitation, ManagedBookPeople, invitationPath, sharingHome, storySharing } from '../../../../services/storySharing';
import { takeBookPeople } from '../../../../services/bookPeopleEntry';

interface PersonRow { key:string; memberId:string; invitationId:string; name:string; avatar:string; relation:string; label:string; isOwner:boolean }
const label=(inv:Invitation)=>inv.status==='approved'?(inv.member?.active?'已加入':'权限已关闭'):
  ({pending:'等待本人加入',expired:'邀请已过期',revoked:'邀请已撤销'}[inv.status] || '待确认');
const rows=(people:BookPerson[],invitations:Invitation[]):PersonRow[]=>[
  ...people.map(person=>({key:'person:'+person.id,memberId:person.id,invitationId:'',name:person.name,avatar:Array.from(person.name)[0] || '忆',relation:person.relation,isOwner:person.isOwner,
    label:person.isOwner?'主笔':invitations.some(inv=>inv.memberId===person.id && inv.member?.active)?'已加入':
      invitations.some(inv=>inv.memberId===person.id && inv.status==='pending')?'等待本人加入':'尚未邀请'})),
  ...invitations.filter(inv=>!inv.memberId).map(inv=>({key:'invite:'+inv.invitationId,memberId:'',invitationId:inv.invitationId,
    name:inv.inviteeName || inv.member?.name || '亲友',avatar:Array.from(inv.inviteeName || inv.member?.name || '亲')[0],relation:inv.relation || '',label:label(inv),isOwner:false})),
];
type RowEvent={currentTarget:{dataset:{key?:string;id?:string}}};
Page({
  data:{title:'这本书的人物',people:[] as PersonRow[],loading:false,busy:false,ready:false,notice:'',detail:false,
    name:'',relation:'',memberId:'',isOwner:false,isNew:false,editing:false,active:false,pending:false,inactive:false,copy:false,copyAvailable:false,
    chapters:[] as Array<{id:string;title:string;checked:boolean}>,records:[] as Array<{id:string;label:string}>,selectedInvitationId:'',shareReady:false,candidates:[] as BookPerson[]},
  storyId:'',familyId:'',epoch:0,hidden:false,shareToken:'',model:null as ManagedBookPeople|null,
  onLoad(options:{storyId?:string}={}) {
    this.storyId=options.storyId || '';wx.hideShareMenu();
    const entry=takeBookPeople(this.storyId);
    if(entry){this.familyId=entry.familyId;this.setData({title:entry.title,people:rows(entry.people,[]).map(person=>({...person,label:person.isOwner?'主笔':'权限待核对'}))});}
  },
  onShow(){this.hidden=false;void this.refresh();},
  onHide(){this.hidden=true;this.epoch++;this.shareToken='';this.familyId='';this.model=null;
    this.setData({title:'这本书的人物',people:[],chapters:[],records:[],candidates:[],ready:false,detail:false,shareReady:false,busy:false,loading:false,name:'',relation:'',notice:''});},
  onUnload(){this.onHide();},
  async refresh() {
    if(this.data.busy)return;
    const epoch=++this.epoch;this.shareToken='';this.model=null;
    this.setData({loading:true,ready:false,detail:false,shareReady:false,notice:''});
    try {
      if(!this.storyId)throw new Error('请从一本书的“人物”入口打开。');
      const result=await storySharing.people(this.storyId,this.familyId || undefined);
      if(this.hidden || epoch!==this.epoch)return;
      if(result.bookPeople!==true){this.setData({notice:'章节权限需要更新云端服务后才能使用。'});return;}
      this.familyId=result.familyId;this.model=result;
      this.setData({title:result.story.title,people:rows(result.people,result.invitations),ready:true,copyAvailable:result.copyAvailable,candidates:result.availablePeople || []});
    }catch(error){if(!this.hidden && epoch===this.epoch){
      this.setData({people:[],notice:error instanceof Error?error.message:'人物名单暂时打不开，请重试。'});
    }}finally{if(!this.hidden && epoch===this.epoch)this.setData({loading:false});}
  },
  openPerson(event:RowEvent) {
    if(!this.data.ready || this.data.busy)return;
    const key=event.currentTarget.dataset.key;
    const row=this.data.people.find(item=>item.key===key) || rows(this.data.candidates,[]).find(item=>item.key===key);
    if(!row || !this.model)return;
    const invitations=this.model.invitations.filter((inv:Invitation)=>row.memberId?inv.memberId===row.memberId:inv.invitationId===row.invitationId);
    const current=invitations.find((inv:Invitation)=>inv.member?.active) || invitations.find((inv:Invitation)=>inv.status==='pending') || invitations[0];
    this.shareToken='';this.setData({detail:true,isNew:false,editing:false,memberId:row.memberId,name:row.name,relation:row.relation,isOwner:row.isOwner,
      records:invitations.map((inv:Invitation)=>({id:inv.invitationId,label:label(inv)})),shareReady:false,notice:''});
    this.selectInvitation(current?.invitationId || '');
  },
  selectRecord(event:RowEvent){if(!this.data.busy)this.selectInvitation(event.currentTarget.dataset.id || '');},
  selectInvitation(id:string) {
    const inv=this.model?.invitations.find((item:Invitation)=>item.invitationId===id);
    const active=inv?.member?.active===true,scope=active?inv?.member?.chapterIds:inv?.chapterIds;
    this.setData({selectedInvitationId:id,active,pending:inv?.status==='pending',inactive:inv?.status==='approved' && !active,copy:active?inv?.member?.permissions?.copy===true:inv?.permissions?.copy===true,
      chapters:(this.model?.chapters || []).map((chapter:{id:string;title:string})=>({...chapter,checked:scope?.includes(chapter.id)===true}))});
  },
  addPerson(){if(!this.data.ready || this.data.busy)return;this.shareToken='';this.setData({detail:true,isNew:true,editing:true,memberId:'',name:'',relation:'',isOwner:false,records:[],shareReady:false,notice:''});this.selectInvitation('');},
  chooseExisting(event:WechatMiniprogram.CustomEvent<{value:string}>) {
    if(this.data.busy || !this.model)return;
    const person=this.data.candidates[Number(event.detail.value)];if(!person)return;
    this.openPerson({currentTarget:{dataset:{key:'person:'+person.id}}});
  },
  back(){if(this.data.busy)return;this.shareToken='';this.setData({detail:false,shareReady:false,notice:''});},
  editPerson(){if(!this.data.busy)this.setData({editing:true});},
  enterName(event:WechatMiniprogram.Input){this.setData({name:event.detail.value});},
  enterRelation(event:WechatMiniprogram.Input){this.setData({relation:event.detail.value});},
  chooseChapters(event:WechatMiniprogram.CustomEvent<{value:string[]}>) {if(!this.data.busy && !this.data.pending)this.setData({chapters:this.data.chapters.map(chapter=>({...chapter,checked:event.detail.value.includes(chapter.id)}))});},
  chooseCopy(event:WechatMiniprogram.CustomEvent<{value:boolean}>) {if(!this.data.busy && !this.data.pending)this.setData({copy:event.detail.value});},
  async savePerson(){
    if(this.data.busy || !this.data.ready || !this.data.memberId)return;
    const name=this.data.name.trim(),relation=this.data.relation.trim();if(!name){this.setData({notice:'请填写称呼。'});return;}
    const epoch=this.epoch;this.setData({busy:true,notice:''});
    try {
      const result=await storySharing.updatePerson(this.data.memberId,name,relation);
      if(result.ok!==true)throw new Error('暂未确认保存结果，请刷新核对。');
      if(this.hidden || epoch!==this.epoch)return;
      for(const person of [...(this.model?.people || []),...(this.model?.availablePeople || [])]){
        if(person.id===this.data.memberId){person.name=name;person.relation=relation || '家人';}
      }
      if(this.model)this.setData({people:rows(this.model.people,this.model.invitations),candidates:this.model.availablePeople || [],editing:false,notice:'人物资料已保存。'});
    }catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'保存失败，请重试。'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
  async saveAccess(){
    if(this.data.busy || !this.data.ready || this.data.isOwner || this.data.pending || this.data.inactive || (this.data.editing && !this.data.isNew))return;
    const chapterIds=this.data.chapters.filter(chapter=>chapter.checked).map(chapter=>chapter.id);
    if(!chapterIds.length){this.setData({notice:'请选择至少一个章节；取消全部访问请用“撤销邀请”。'});return;}
    if(!this.data.name.trim()){this.setData({notice:'请填写对方的称呼。'});return;}
    const epoch=this.epoch;this.setData({busy:true,notice:'',shareReady:false});this.shareToken='';
    try {
      if(this.data.active){
        const inv=this.model?.invitations.find((item:Invitation)=>item.invitationId===this.data.selectedInvitationId);
        // This screen does not expose original-edit permissions or erase an existing setting.
        await storySharing.setAccess(this.familyId,this.storyId,this.data.selectedInvitationId,
          {read:true,edit:inv?.member?.permissions.edit===true,copy:this.data.copyAvailable && this.data.copy},chapterIds);
        if(this.hidden || epoch!==this.epoch)return;
        if(inv?.member){inv.member.chapterIds=chapterIds;inv.member.permissions.copy=this.data.copyAvailable && this.data.copy;}
        this.setData({notice:'章节权限已保存，马上生效。'});
      }else{
        const result=await storySharing.invitePerson(this.familyId,this.storyId,chapterIds,this.data.copyAvailable && this.data.copy,
          {memberId:this.data.memberId || undefined,name:this.data.name.trim(),relation:this.data.relation.trim()});
        if(this.hidden || epoch!==this.epoch)return;
        this.shareToken=result.token;
        const known=this.data.candidates.find(person=>person.id===this.data.memberId);
        if(known && this.model && !this.model.people.some((person:BookPerson)=>person.id===known.id))this.model.people.push(known);
        // Reflect the receipt immediately; refresh is only needed to see acceptance.
        this.model?.invitations.push({invitationId:result.invitationId,memberId:this.data.memberId || undefined,inviteeName:this.data.name.trim(),relation:this.data.relation.trim(),
          status:'pending',expiresAtMs:Date.now()+86400000,chapterIds,permissions:{read:true,forward:false,copy:this.data.copyAvailable && this.data.copy},applicants:[]});
        this.setData({selectedInvitationId:result.invitationId,pending:true,isNew:false,editing:false,shareReady:true,
          ...(this.model?{people:rows(this.model.people,this.model.invitations)}:{}),notice:'邀请已生成，24 小时内有效。请只发给本人；第一个接受的人会绑定这位人物。'});
      }
    }catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:(error instanceof Error?error.message:'暂时未完成')+'；请刷新核对后再试，避免重复邀请。'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
  async revoke(){
    if(this.data.busy || !this.data.ready || !this.data.selectedInvitationId)return;
    const epoch=this.epoch,id=this.data.selectedInvitationId;this.setData({busy:true,notice:''});
    try {
      const confirmed=await new Promise<boolean>((resolve,reject)=>wx.showModal({title:'撤销这份邀请？',content:'对方将不能继续读取这份邀请授权的原稿。已保留的副本不会被删除。',success:result=>resolve(result.confirm),fail:reject}));
      if(!confirmed || this.hidden || epoch!==this.epoch)return;
      await storySharing.revoke(this.familyId,this.storyId,id);
      if(this.hidden || epoch!==this.epoch)return;
      this.setData({busy:false});await this.refresh();
    }catch(error){if(!this.hidden && epoch===this.epoch)this.setData({notice:error instanceof Error?error.message:'暂未确认撤销结果，请刷新。'});}
    finally{if(!this.hidden && epoch===this.epoch)this.setData({busy:false});}
  },
  onShareAppMessage(){return this.data.shareReady && this.shareToken?{...sharingHome,title:'邀请你阅读一段故事',path:invitationPath(this.shareToken)}:sharingHome;},
  onShareTimeline(){return {title:sharingHome.title,imageUrl:sharingHome.imageUrl};},
});
