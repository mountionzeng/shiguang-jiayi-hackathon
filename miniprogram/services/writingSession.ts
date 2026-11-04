import {cachedAccountScope, currentFamilyId} from './cloudRoomStorage';
import type {WritingSource} from './writingSupport';
export interface WritingSnapshot {
  messages:Array<{id:string;kind:'opening'|'followup'|'answer'|'research'|'request';text:string;label:string;sources?:WritingSource[]}>;
  answers:string[];askedDimensions:string[];inputText:string;draftTitle:string;draftText:string;draftSummary:string;
  draftAiText?:string;draftAiTitle?:string;
  draftOrganizationMode:'cloud-ai'|'local-demo';outputMemoryId:string;saved:boolean;
}
interface Pending {revision:number;mutationId:string;snapshot:WritingSnapshot;}
interface Receipt {memoryId:string;revision:number;mutationId:string;snapshot?:WritingSnapshot|null;}
export class WritingSession {
  private queue:Promise<void>=Promise.resolve();
  private blocked=false;
  private key:string;
  private revision=0;
  private timer?: ReturnType<typeof setTimeout>;
  get rootMemoryId():string {return this.memoryId;}
  get canWrite():boolean {return !this.blocked;}
  private lastPending?:Pending;
  private constructor(private memoryId:string, private familyId:string, private notice:(text:string)=>void) {this.key=`writing-session:v1:${cachedAccountScope()}:${familyId}:${memoryId}`;}
  private async call(data:Record<string,unknown>):Promise<Receipt> {
    if(await currentFamilyId()!==this.familyId)throw new Error('账号已切换，请重新打开会话');
    const result=(await wx.cloud.callFunction({name:'chatInterview',data:{action:'writingSession',memoryId:this.memoryId,expectedFamilyId:this.familyId,...data}})).result as Receipt;
    if(await currentFamilyId()!==this.familyId)throw new Error('账号已切换，请重新打开会话');
    if(!result || !Number.isSafeInteger(result.revision) || typeof result.memoryId!=='string')throw new Error('会话同步入口尚未就绪');
    return result;
  }
  static async open(memoryId:string,notice:(text:string)=>void):Promise<{session:WritingSession;snapshot?:WritingSnapshot}> {
    const session=new WritingSession(memoryId,await currentFamilyId(),notice);
    const result=await session.call({operation:'get'});
    session.memoryId=result.memoryId;session.key=`writing-session:v1:${cachedAccountScope()}:${session.familyId}:${session.memoryId}`;session.revision=result.revision;
    const local=wx.getStorageSync<Pending>(session.key);
    if(local && local.mutationId!==result.mutationId) {
      session.lastPending=local;
      if(local.revision!==result.revision) {session.blocked=true;notice('另一处已更新会话，本机未同步内容仍保留。请先核对，勿重复发送。');}
      else {notice('已恢复本机尚未同步的对话');void session.save(local.snapshot);}
      return {session,snapshot:local.snapshot};
    }
    if(local)wx.removeStorageSync(session.key);
    return {session,snapshot:result.snapshot || undefined};
  }
  checkpoint(snapshot:WritingSnapshot):void {
    this.stage(snapshot);
    if(this.timer)clearTimeout(this.timer);
    this.timer=setTimeout(()=>{this.timer=undefined;void this.flush();},800);
  }
  private stage(snapshot:WritingSnapshot):Pending {
    const pending:Pending={revision:this.revision,mutationId:`turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`,snapshot:JSON.parse(JSON.stringify(snapshot))};
    this.lastPending=pending;wx.setStorageSync(this.key,pending);
    return pending;
  }
  save(snapshot:WritingSnapshot):Promise<void> {
    this.stage(snapshot);
    return this.flush();
  }
  flush():Promise<void> {
    if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
    const pending=this.lastPending;
    if(this.blocked || !pending)return this.queue;
    this.queue=this.queue.then(async()=>{
      if(this.blocked)return;
      pending.revision=this.revision;
      if(this.lastPending===pending)wx.setStorageSync(this.key,pending);
      const result=await this.call({operation:'save',...pending});
      this.revision=result.revision;
      if(this.lastPending===pending) {wx.removeStorageSync(this.key);this.lastPending=undefined;this.notice('聊天与草稿已保存');}
      else if(this.lastPending) {this.lastPending.revision=this.revision;wx.setStorageSync(this.key,this.lastPending);}
    }).catch(()=>{this.blocked=true;this.notice('聊天同步未完成，已保留本机副本。请点“重试保存”，不要退出账号。');});
    return this.queue;
  }
  async retry():Promise<void> {
    await this.queue;
    const result=await this.call({operation:'get'}),pending=this.lastPending;
    if(!pending)return;
    if(result.mutationId===pending.mutationId) {this.revision=result.revision;this.blocked=false;this.lastPending=undefined;wx.removeStorageSync(this.key);this.notice('聊天与草稿已保存');return;}
    if(result.revision!==pending.revision)throw new Error('另一处已更新会话，请重新打开核对；本机内容仍保留');
    this.revision=result.revision;this.blocked=false;await this.save(pending.snapshot);
  }
}
