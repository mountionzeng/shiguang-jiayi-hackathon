import {requestAiConsent} from './aiConsent';

export interface WritingSource {index:number; title:string; url:string;}
export interface WritingSearchResult {text:string; sources:WritingSource[]; query:string; searchedAt:string;}
interface WritingPreferences {text:string; revision:number;}

export function isWritingSearchRequest(text:string):boolean {
  if (/(?:不要|不用|不必|别|不需要).{0,6}(?:搜|查)|(?:搜|查).{0,3}(?:不要|不用)/.test(text)) return false;
  return /(?:帮我|帮忙|可以|能不能|请|想要|需要).{0,12}(?:搜一下|搜索|搜一搜|查一下|查一查|查资料|查找|检索)|^(?:搜索|搜一下|查一下|查资料|联网查)/.test(text);
}

export async function requestWritingSearch(initialQuery:string, onQuery?:(query:string)=>void):Promise<WritingSearchResult | undefined> {
  const query = await new Promise<string | undefined>(resolve => wx.showModal({
    title:'腾讯云公开资料搜索', editable:true, content:initialQuery.slice(0,300),
    placeholderText:'只填公开检索词，发送至腾讯云 TokenHub；勿填私密信息',
    confirmText:'确认搜索', cancelText:'取消',
    success:result=>resolve(result.confirm ? (result.content || '').trim() : undefined), fail:()=>resolve(undefined),
  }));
  if (query === undefined) return;
  if (!query || query.length > 300) throw new Error('请填写300字以内的公开检索词');
  onQuery?.(query);
  if (!await requestAiConsent()) return;
  const response = await wx.cloud.callFunction({name:'chatInterview',data:{action:'writingSearch',query,searchConsent:true}});
  const value = response.result as WritingSearchResult | undefined;
  if (!value || typeof value.text !== 'string' || !value.text.trim() || !Array.isArray(value.sources) || !value.sources.length ||
      value.sources.some(source=>!Number.isSafeInteger(source.index) || source.index < 1 || typeof source.title !== 'string' || !/^https?:\/\//.test(source.url)))
    throw new Error('这次没有拿到可核对的来源，请稍后重试');
  return value;
}

export function writingSearchContext(result:WritingSearchResult):string {
  return `【联网参考资料，不是用户亲历；检索词：${result.query}】\n${result.text}\n` +
    result.sources.map(source=>`[${source.index}] ${source.title} ${source.url}`).join('\n');
}

async function preferences(data:Record<string,unknown>):Promise<WritingPreferences> {
  const response = await wx.cloud.callFunction({name:'chatInterview',data:{action:'writingPreferences',...data}});
  const value = response.result as WritingPreferences | undefined;
  if (!value || typeof value.text !== 'string' || !Number.isSafeInteger(value.revision)) throw new Error('写作偏好暂时无法读取');
  return value;
}
export async function editWritingPreferences():Promise<void> {
  const current = await preferences({operation:'get'});
  const text = await new Promise<string | undefined>(resolve=>wx.showModal({
    title:'写作偏好（跨次记住）', editable:true, content:current.text,
    placeholderText:'例如：一次只问一个问题；先给例子。留空保存即可清除，最多500字',
    confirmText:'保存偏好', cancelText:'取消',
    success:result=>resolve(result.confirm ? (result.content || '').trim() : undefined), fail:()=>resolve(undefined),
  }));
  if (text === undefined) return;
  if (text.length > 500) throw new Error('偏好请控制在500字以内');
  await preferences({operation:'save',text,revision:current.revision});
  wx.showToast({title:text ? '已记住，之后可随时修改' : '已清除写作偏好',icon:'none'});
}
