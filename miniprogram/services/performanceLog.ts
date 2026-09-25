type Operation = 'room.load' | 'room.cloud' | 'room.identity' | 'room.state' | 'story.shelf'
  | 'book.refresh' | 'book.identity' | 'book.photos' | 'book.images';

export interface PerformanceMetrics {
  route?: 'local' | 'cloud' | 'identity' | 'story-service' | 'client-fallback';
  fallback?: 'legacy-response' | 'service-unavailable';
  clientPageReads?: number;
  members?: number;
  memories?: number;
  revisions?: number;
  stories?: number;
  responseBytes?: number;
  responseAnalysisMs?: number;
}

/** Count the UTF-8 size of a JSON response without retaining or logging its contents. */
export function jsonUtf8ByteLength(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return undefined;

    let bytes = 0;
    for (let index = 0; index < json.length; index += 1) {
      const code = json.charCodeAt(index);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < json.length) {
        const next = json.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    }
    return bytes;
  } catch {
    // Diagnostics must never turn an otherwise valid cloud response into a page failure.
    return undefined;
  }
}

/** Fixed metadata only: never log account IDs, memory text, fingerprints or errors. */
export function startPerformanceMeasure(operation: Operation) {
  const startedAt = Date.now();
  let page = '';
  try {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const route = pages[pages.length - 1]?.route;
    if (route && /^[a-zA-Z0-9_/-]{1,100}$/.test(route)) page = route;
  } catch { /* Diagnostics cannot prevent a load. */ }
  return (outcome: 'ok' | 'error', metrics: PerformanceMetrics = {}) => {
    try {
      if (typeof wx === 'undefined' || typeof wx.getRealtimeLogManager !== 'function') return;
      const detail = {
        operation, page, outcome, durationMs: Math.max(0, Date.now() - startedAt), ...metrics,
      };
      console.info('[performance]', detail);
      wx.getRealtimeLogManager().info('[performance]', detail);
    } catch { /* Diagnostics cannot change the result or error of a load. */ }
  };
}

export async function measurePerformance<T>(operation: Operation, work: () => Promise<T>): Promise<T> {
  const finish = startPerformanceMeasure(operation);
  let outcome: 'ok' | 'error' = 'error';
  try {
    const value = await work();
    outcome = 'ok';
    return value;
  } finally {
    finish(outcome);
  }
}
