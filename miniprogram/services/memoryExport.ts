export interface MemoryExportSource {
  kind: 'memory';
  memoryId: string;
  revisionId: string | null;
  sourceVersion: string;
  title: string;
  text: string;
  containsAiText: boolean;
}

async function call<T>(input: {
  memoryId: string;
  revisionId?: string;
  expectedSourceVersion?: string;
}): Promise<T> {
  if (!wx.cloud) throw new Error('发送记忆需要连接云端');
  const response = await wx.cloud.callFunction({
    name: 'storyBooks',
    data: { action: 'memoryExportSource', ...input },
  });
  const result = response.result as { error?: string; code?: string; message?: string } | undefined;
  if (!result || result.error) {
    throw Object.assign(new Error(result?.message || '暂时无法确认记忆来源，请重试'), { code: result?.code });
  }
  return result as T;
}

export const memoryExportApi = {
  resolveSource: (input: { memoryId: string; revisionId?: string }) =>
    call<{ source: MemoryExportSource }>(input),
  recheckSource: (input: { memoryId: string; revisionId?: string; expectedSourceVersion: string }) =>
    call<{ source: MemoryExportSource }>(input),
};
