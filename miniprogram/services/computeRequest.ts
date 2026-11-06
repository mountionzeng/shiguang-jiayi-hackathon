/** Stable for one user action. Retries of that same payload must reuse it. */
export function newComputeRequestId(now = Date.now(), random = Math.random): string {
  const suffix = random().toString(36).slice(2, 12).padEnd(8, "0");
  return `cmp-${now.toString(36)}-${suffix}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
}
