/** Stable cross-service categories. Raw provider messages never enter diagnostics. */
export type FailureKind = 'missing' | 'timeout' | 'response-too-large' | 'permission' | 'conflict' | 'unknown';
export function classifyServiceFailure(error: unknown): FailureKind {
  const value = error as { code?: unknown; errCode?: unknown; errMsg?: unknown; message?: unknown } | undefined;
  const text = [value?.code, value?.errCode, value?.errMsg, value?.message, typeof error === 'string' ? error : ''].join(' ');
  if (/response size exceeded|response.{0,20}(?:too large|size limit)/i.test(text)) return 'response-too-large';
  if (/FUNCTION_NOT_FOUND|FunctionName parameter could not be found|function\b[^\n]{0,80}\b(?:does not exist|not found)|unexpected cloud function:\s*storyBooks/i.test(text)) return 'missing';
  if (/timed? ?out|timeout|-504003/i.test(text)) return 'timeout';
  if (/PERMISSION_DENIED|UNAUTHORIZED|FORBIDDEN|ACCESS_DENIED/i.test(text)) return 'permission';
  if (/VERSION_CONFLICT|REQUEST_CONFLICT|已有更新|请求编号冲突/i.test(text)) return 'conflict';
  return 'unknown';
}

type Service = 'storyBooks' | 'storyImages' | 'chatInterview' | 'organizeMemory';
type Phase = 'read' | 'ai' | 'write' | 'refresh';
export function logServiceFailure(service: Service, phase: Phase, error: unknown): void {
  try {
    const detail = { service, phase, kind: classifyServiceFailure(error) };
    console.warn('[service-failure]', detail);
    if (typeof wx !== 'undefined' && typeof wx.getRealtimeLogManager === 'function') wx.getRealtimeLogManager().warn('[service-failure]', detail);
  } catch { /* Diagnostics must never change the operation result. */ }
}

/** A positive write receipt is different from an unknown network outcome. */
export class SavedRefreshError extends Error {
  readonly code = 'SAVED_REFRESH_PENDING';
  readonly saved = true;
  constructor(readonly requestId: string) {
    super('已保存到云端，但页面暂未刷新。请重新打开这本书核对，不必重复提交；历史版本仍保留。');
  }
}
