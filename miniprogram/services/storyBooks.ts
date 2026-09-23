import { FamilyRoomState, Story, ManuscriptRevision } from '../domain/biography';
import * as core from '../domain/storyBookCore';
import { loadRoomStateRemoteFirst, usesCloudStorage } from './roomRepository';
import { saveRoomState } from './roomStorage';
import { newStoryId } from './storyRecords';

export { activeStory, current as currentStoryManuscript, history as storyManuscriptHistory, fingerprint as storySourceFingerprint } from '../domain/storyBookCore';
export const operationId = () => 'op-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12);
function canReadLegacyStories(error: unknown): boolean {
  const detail = error as { code?: unknown; errCode?: unknown; errMsg?: unknown; message?: unknown } | undefined;
  const text = [detail?.code, detail?.errCode, detail?.errMsg, detail?.message, error].map(String).join(' ');
  return /MIGRATION_NOT_READY|故事库.*(?:准备|迁移测试范围)|新版故事库正在准备|FUNCTION_NOT_FOUND|-501000|FunctionName parameter could not be found|unexpected cloud function:\s*storyBooks/i.test(text);
}
async function call(action: string, data: Record<string,unknown> = {}): Promise<Record<string,unknown>> {
  const response = await wx.cloud.callFunction({name:'storyBooks',data:{...data,action}});
  const result = response.result as {error?:string;code?:string;message?:string;[key:string]:unknown};
  if (!result || result.error) {
    const error = new Error(result?.message || '故事服务暂不可用，请重试') as Error & { code?: string };
    if (result?.code) error.code = result.code;
    throw error;
  }
  return result;
}
export async function ensureStoryBooks(): Promise<FamilyRoomState> {
  let state = await loadRoomStateRemoteFirst();
  if (state.storyMigration?.status === 'active') return state;
  if (usesCloudStorage()) {
    // Each bounded invocation resumes the same migration cursor. No paid model calls.
    for (let i=0;i<100;i++) {
      let result: Record<string, unknown>;
      try {
        result = await call('migrate');
      } catch (error) {
        // An older deployment can still show every legacy story. Writes remain
        // blocked by storyCommand until the new cloud function is deployed.
        if (canReadLegacyStories(error)) return state;
        throw error;
      }
      if (result.status === 'active') return loadRoomStateRemoteFirst();
    }
    throw new Error('旧书整理仍在继续，请稍后再次打开书架');
  }
  state = core.migrate(state,'local'); saveRoomState(state); return state;
}
export async function storyCommand(command: Record<string,unknown>): Promise<FamilyRoomState> {
  const state = await loadRoomStateRemoteFirst();
  if (usesCloudStorage()) { await call(String(command.action),command); return loadRoomStateRemoteFirst(); }
  const next = core.apply(state,command); saveRoomState(next); return next;
}
export async function createStoryBook(input:{title:string;writingMode:'objective'|'creative';memoryIds?:string[];storyId?:string;requestId?:string}) {
  if (input.memoryIds?.length) await ensureStoryBooks();
  const storyId = input.storyId || newStoryId();
  const state = await storyCommand({...input,storyId,requestId:input.requestId || operationId(),action:'create'});
  return {state,story:core.activeStory(state,storyId)};
}
export function updateStoryBook(story:Story, patch:Partial<Pick<Story,'title'|'bookTitle'|'writingMode'|'coverImageId'>>, requestId = operationId()) {
  return storyCommand({action:'update',storyId:story.id,expectedVersion:story.version,patch,requestId});
}
export function linkStoryMemories(story:Story,memoryIds:string[],requestId = operationId()) {
  return storyCommand({action:'link',storyId:story.id,expectedVersion:story.version,memoryIds,requestId});
}
export function saveStoryRevision(revision:ManuscriptRevision,expectedRevisionId:string) {
  return storyCommand({action:'save',storyId:revision.storyId,expectedVersion:revision.expectedStoryVersion,expectedRevisionId,revision,requestId:revision.id});
}
export function resolveStoryChapter(story:Story,pendingId:string,revision:ManuscriptRevision) {
  return storyCommand({action:'resolve',storyId:story.id,expectedVersion:story.version,expectedRevisionId:story.currentRevisionId || '',pendingId,revision,requestId:revision.id});
}
export function resolveStoryAsset(story:Story,pendingId:string) {
  return storyCommand({action:'resolveAsset',storyId:story.id,expectedVersion:story.version,pendingId,requestId:'resolve-asset-'+core.hash(story.id+'|'+pendingId)});
}
export async function storyAiContext(storyId:string,memoryIds?:string[]) {
  return call('context',{storyId,...(memoryIds ? {memoryIds} : {})}) as Promise<{
    story: Story;
    draft?: import('../domain/biography').BiographyDraft;
    memories: import('../domain/biography').MemoryContribution[];
    fingerprint: string;
  }>;
}
