import { dailyQuestionAvailable } from './dailyQuestion';
import { currentConsentVersion, requestAiConsent } from './aiConsent';
import { measurePerformance } from './performanceLog';
export interface MemoryConnection {
  observation: string;
  question: string;
  evidence: Array<{ memoryId: string; title: string; quote: string }>;
  generationMode: 'cloud-ai';
}
export async function exploreMemoryConnection(memoryIds: string[]): Promise<MemoryConnection> {
  if (memoryIds.length < 2 || memoryIds.length > 8) throw new Error('先选 2—8 段记忆，一起看更容易发现线索。');
  if (!dailyQuestionAvailable()) throw new Error('小忆暂时不可用，可以自己写下想法，或直接组合记忆。');
  if (!await requestAiConsent()) throw new Error('未开启在线 AI，可以自己写下想法。');
  await wx.cloud.callFunction({name:'recordAiConsent',data:{version:currentConsentVersion()}});
  let response: { result: unknown };
  try { response = await measurePerformance('ai.memory-connection', () => wx.cloud.callFunction({name:'chatInterview',data:{action:'memoryConnection',memoryIds}})); }
  catch { throw new Error('小忆这次没能看完，可以稍后重试，也可以自己写下想法或直接组合。'); }
  const result = response.result as MemoryConnection | undefined;
  if (!result || result.generationMode !== 'cloud-ai' || typeof result.observation !== 'string' || typeof result.question !== 'string' ||
      !result.question || !Array.isArray(result.evidence) || result.evidence.some(item => !item || !memoryIds.includes(item.memoryId) || typeof item.quote !== 'string' || typeof item.title !== 'string')) {
    throw new Error('这次没能确认记忆之间的线索，可以重新试一次或直接组合。');
  }
  return result;
}
