export interface AccountActivity {
  id:string; accountKey:string; name:string; verified:boolean; at:string; kind:string; title:string; text:string; imageCount:number;
  changes:Array<{kind:string;action:string;before:string;after:string}>; comparisonAvailable:boolean; storyId:string; revisionId:string;
}
export async function loadAccountActivity(): Promise<AccountActivity[]> {
  if(!wx.cloud) throw new Error('请连接网络查看往来记录');
  const response=await wx.cloud.callFunction({name:'storyBooks',data:{action:'accountActivity'}});
  const result=response.result as {events?:AccountActivity[];error?:string;message?:string};
  if(!result||result.error||!Array.isArray(result.events))throw new Error(result?.message||'往来记录暂时没有加载出来');
  return result.events;
}
export function groupAccountActivity(events:AccountActivity[]) {
  const groups=new Map<string,{id:string;name:string;avatar:string;verified:boolean;count:number;latest:string;events:AccountActivity[]}>();
  for(const event of events){const row=groups.get(event.accountKey)||{id:event.accountKey,name:event.name,avatar:Array.from(event.name.trim())[0]||'人',verified:event.verified,count:0,latest:event.kind,events:[]};row.events.push(event);row.count++;groups.set(row.id,row);}
  return [...groups.values()];
}
