import { CHAPTER_DELIVERY_ENABLED } from '../config/runtime';
import { listChapterDeliveryInbox, readChapterDelivery, importChapterDelivery } from './chapterDelivery';
export interface AccountActivity {
  id:string; deliveryId?:string; accountKey:string; name:string; verified:boolean; at:string; kind:string; title:string; text:string; imageCount:number;
  changes:Array<{kind:string;action:string;before:string;after:string}>; comparisonAvailable:boolean; storyId:string; revisionId:string;
}
async function readActivity(): Promise<AccountActivity[]> {
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

/** Only deliveries addressed to this authenticated recipient; never browse another account's drafts. */
export async function loadAccountActivity(): Promise<AccountActivity[]> {
  let events = await readActivity();
  if (!CHAPTER_DELIVERY_ENABLED) return events;
  const inbox = await listChapterDeliveryInbox();
  const known = new Set(events.map(event => event.deliveryId).filter(Boolean));
  const missing = inbox.items.filter(item => item.status !== 'declined' && !known.has(item.deliveryId));
  for (let i = 0; i < missing.length; i += 3) {
    await Promise.all(missing.slice(i, i + 3).map(item => readChapterDelivery(item.deliveryId)));
  }
  if (missing.length) events = await readActivity();
  const available = new Map(inbox.items.map(item => [item.deliveryId, item.status]));
  return events.map(event => {
    if (!event.deliveryId || event.storyId) return event;
    const status = available.get(event.deliveryId);
    return status === 'declined' || !status
      ? { ...event, deliveryId: undefined, kind: status === 'declined' ? '已谢绝的分享' : event.kind }
      : event;
  });
}
export async function openSharedArticle(event: AccountActivity): Promise<void> {
  let storyId = event.storyId;
  if (!storyId && event.deliveryId) {
    const result = await importChapterDelivery(event.deliveryId, {
      mode: 'new', storyId: `story-received-${event.deliveryId}`, title: event.title || '收到的文章',
    });
    storyId = result.storyId || '';
  }
  if (!storyId) throw new Error('这条记录没有可打开的文章，收到的内容已显示在这里');
  wx.navigateTo({ url: '/pages/book/book?storyId=' + encodeURIComponent(storyId) });
}
