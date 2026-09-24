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
