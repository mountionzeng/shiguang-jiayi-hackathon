import type { ShiguangAppOptions } from '../app';
import type { MemoryContribution } from '../domain/biography';
import { currentConsentVersion, hasAiConsent } from './aiConsent';
import { CLOUD_AI_ENABLED } from '../config/runtime';

export interface PersonalInsight {
  lineageKey: string;
  text: string;
  origin: 'user_stated' | 'user_corrected' | 'inferred';
  allowProactiveMention: boolean;
}
export interface PersonalMemoryState { enabled: boolean; insights: PersonalInsight[]; }
async function call(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await wx.cloud.callFunction({name:'personalMemory',data})).result as Record<string, unknown> | undefined;
  if (!result || result.error) throw new Error('暂时无法读取小忆记住的内容，请稍后重试');
  return result;
}
export const personalMemory = {
  async list(): Promise<PersonalMemoryState> { return await call({action:'list'}) as unknown as PersonalMemoryState; },
  async configure(enabled: boolean) {
    if (enabled) {
      if (!hasAiConsent()) throw new Error('请先同意在线 AI 使用授权');
      // Await the server receipt; the existing general consent dialog writes it asynchronously.
      await wx.cloud.callFunction({name:'recordAiConsent',data:{version:currentConsentVersion()}});
    }
    await call({action:'configure',enabled,consentVersion:1});
  },
  async forget(lineageKey: string) { await call({action:'forget',lineageKey}); },
};
// Fire after a successful save, with a stable memory id only. The server checks
// separate opt-in, persisted ownership/evidence and idempotency before any AI call.
export function learnFromSavedMemory(memory: MemoryContribution): void {
  if (memory.scope !== 'personal' || !hasAiConsent() || !CLOUD_AI_ENABLED || typeof getApp !== 'function' || !wx.cloud) return;
  const app = getApp<ShiguangAppOptions>();
  if (!app.globalData.cloudReady || !app.globalData.aiReady) return;
  void call({action:'extract',memoryId:memory.id}).catch(() => {
    // Saving has already succeeded. A later save can retry the same evidence.
    console.warn('个人理解暂未更新，原话已保存');
  });
}
