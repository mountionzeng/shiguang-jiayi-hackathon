import {startPerformanceMeasure} from "./performanceLog";
import { logServiceFailure } from './serviceFailure';
import type {ShiguangAppOptions} from '../app';
import type {InterviewDimension} from '../domain/interview';
import {CLOUD_AI_ENABLED} from '../config/runtime';
import {hasAiConsent, requestAiConsent, currentConsentVersion} from './aiConsent';
import {promptComputeBillingFailure} from './computeBillingPrompt';
import {newComputeRequestId} from './computeRequest';
export interface DailyTopic {anchor:string; focus:'experience'|'choice'|'feeling'|'expression'; gap:string}
export interface DailyQuestion {text:string; dimension:InterviewDimension; sourceId:string; anchor:string; generationMode:'cloud-ai'; focus?:DailyTopic['focus']; gap?:string}
interface Entry {version:string; day:string; question:DailyQuestion; history:string[]; topics?:DailyTopic[]}
function validTopics(value:unknown):DailyTopic[] {
  return Array.isArray(value) ? value.filter((item):item is DailyTopic => Boolean(item && typeof item.anchor==='string' && item.anchor.length>=4 && item.anchor.length<=60 && ['experience','choice','feeling','expression'].includes(item.focus) && typeof item.gap==='string' && item.gap.length>=4 && item.gap.length<=80)).slice(-24) : [];
}
export class DailyQuestionCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<DailyQuestion>>();
  private latest = new Map<string, string>();
  constructor(private storage?:{read:(scope:string)=>Entry | undefined; write:(scope:string,entry:Entry)=>void}) {}
  async get(scope:string, version:string, day:string, force:boolean, generate:(history:string[],topics:DailyTopic[])=>Promise<DailyQuestion>):Promise<DailyQuestion> {
    const entry=this.entries.get(scope) || this.storage?.read(scope);
    const key=JSON.stringify([scope,version,day]);
    this.latest.set(scope,key);
    const pending=this.pending.get(key);
    if(pending) return pending;
    if(!force && entry?.version===version && entry.day===day) return entry.question;
    const request=generate(entry?.history || [],validTopics(entry?.topics)).then(question=>{
      if (this.latest.get(scope)!==key) return question;
      const history=this.entries.get(scope)?.history || entry?.history || [];
      const topics=validTopics(this.entries.get(scope)?.topics || entry?.topics);
      this.entries.delete(scope);
      this.entries.set(scope,{version,day,question,history:[...history,question.text].slice(-24),topics:[...topics,...validTopics([{anchor:question.anchor,focus:question.focus,gap:question.gap}])].slice(-24)});
      this.storage?.write(scope,this.entries.get(scope)!);
      if(this.entries.size>24) this.entries.delete(this.entries.keys().next().value as string);
      return question;
    }).finally(()=>{this.pending.delete(key)});
    this.pending.set(key,request);
    return request;
  }
}
// Persistent cache is scoped by the server-owned family + story IDs. Loose
// memories stay session-only, since the page has no authenticated family key.
const CACHE_KEY='shiguang-daily-questions-v1';
export const dailyQuestionCache=new DailyQuestionCache({
  read(scope) {
    if(scope.startsWith('memory:')) return undefined;
    try {
      const rows=wx.getStorageSync(CACHE_KEY);
      const row=Array.isArray(rows) ? rows.find(row=>row.scope===scope)?.entry : undefined;
      return row && typeof row.version==='string' && typeof row.day==='string' && Array.isArray(row.history) && row.history.every((q:unknown)=>typeof q==='string') && row.question?.generationMode==='cloud-ai' && typeof row.question.text==='string' ? row : undefined;
    } catch { return undefined; }
  },
  write(scope,entry) {
    if(scope.startsWith('memory:')) return;
    try { const stored=wx.getStorageSync(CACHE_KEY); const rows=Array.isArray(stored)?stored:[];
      wx.setStorageSync(CACHE_KEY,[...rows.filter(row=>row.scope!==scope).slice(-23),{scope,entry}]);
    } catch { /* Storage pressure does not discard a successful model response. */ }
  },
});
export function dailyQuestionAvailable():boolean {
  if(!CLOUD_AI_ENABLED || typeof getApp!=='function') return false;
  const app=getApp<ShiguangAppOptions>();
  return Boolean(app.globalData.cloudReady && app.globalData.aiReady && wx.cloud);
}
export async function generateDailyQuestion(input:{storyId?:string;memoryId?:string}, previousQuestions:string[], manual:boolean, previousTopics:DailyTopic[]=[]):Promise<DailyQuestion> {
  if(!dailyQuestionAvailable()) throw new Error('DAILY_UNAVAILABLE');
  if(!hasAiConsent()) {
    if(!manual || !await requestAiConsent()) throw new Error('DAILY_CONSENT_REQUIRED');
    // Wait for the receipt before the guarded model request.
    await wx.cloud.callFunction({name:'recordAiConsent',data:{version:currentConsentVersion()}});
  }
  const finish=startPerformanceMeasure('ai.daily-question');
  let outcome:'ok'|'error'='error';
  try {
  const response=await wx.cloud.callFunction({name:'chatInterview',data:{action:'dailyQuestion',...input,previousQuestions,previousTopics:validTopics(previousTopics),computeRequestId:newComputeRequestId()}});
  const result=response.result as Partial<DailyQuestion> | undefined;
  if(result?.generationMode!=='cloud-ai' || typeof result.text!=='string' || !result.text.trim() || result.text.length>80 || typeof result.anchor!=='string' || typeof result.sourceId!=='string' || !['person','time','place','event','feeling'].includes(result.dimension || '')) throw new Error('DAILY_INVALID_RESULT');
  outcome='ok';
  return result as DailyQuestion;
  } catch (error) {
    promptComputeBillingFailure(error);
    logServiceFailure('chatInterview', 'ai', error);
    throw error;
  } finally { finish(outcome); }
}
