import { sha256Hex } from "../domain/chapterPackage";
import { cachedAccountScope } from "./cloudRoomStorage";
import { classifyServiceFailure } from "./serviceFailure";

/** Stable for one user action. Retries of that same payload must reuse it. */
export function newComputeRequestId(now = Date.now(), random = Math.random): string {
  const suffix = random().toString(36).slice(2, 12).padEnd(8, "0");
  return `cmp-${now.toString(36)}-${suffix}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
}

const openOperations = new Map<string, string>();

function isUnknownOutcome(error: unknown): boolean {
  const record = error && typeof error === "object"
    ? error as { name?: unknown; code?: unknown; message?: unknown; errMsg?: unknown; billingState?: { phase?: unknown } }
    : {};
  const failure = classifyServiceFailure(error);
  const detail = [record.name, record.code, record.message, record.errMsg].join(" ");
  return record.billingState?.phase === "unknown" || failure === "timeout" || failure === "response-too-large"
    || /SUBMISSION_UNKNOWN|COMPUTE_REPLAY|COMPUTE_UNAVAILABLE|SCENE_BILLING_UNKNOWN|VISION_BILLING_UNKNOWN|AbortError|NetworkError|ECONNRESET|network (?:error|fail)|fetch failed|request:fail|算力暂不可用|尚未确认|请勿重复发起|MODEL_REQUEST_FAILED_(?:408|409|425|5\d\d)/i.test(detail);
}

const STORAGE_PREFIX = "compute-request:v1:";

function operationKey(actionKey: string): string {
  const account = cachedAccountScope();
  const fingerprint = sha256Hex(JSON.stringify([account ?? null, actionKey.trim()]));
  return account ? STORAGE_PREFIX + fingerprint : fingerprint;
}

function getOperationId(key: string, createId = newComputeRequestId): string {
  const pending = openOperations.get(key);
  if (pending) return pending;

  const persistent = key.startsWith(STORAGE_PREFIX) && typeof wx !== "undefined";
  if (persistent) {
    try {
      const saved = wx.getStorageSync<string>(key);
      if (typeof saved === "string" && /^(?:cmp|req)-[a-z0-9]+-[a-z0-9]{8,10}$/.test(saved)) {
        openOperations.set(key, saved);
        return saved;
      }
    } catch { /* Retain in-process retries if local storage is unavailable. */ }
  }

  const id = createId();
  openOperations.set(key, id);
  if (persistent) {
    try { wx.setStorageSync(key, id); }
    catch { /* Retain in-process retries if local storage is unavailable. */ }
  }
  return id;
}

function finishOperation(key: string, error?: unknown, operationId?: string): void {
  const existing = openOperations.get(key);
  if (!existing || (operationId && operationId !== existing)) return;
  if (error && isUnknownOutcome(error)) return;

  openOperations.delete(key);
  if (key.startsWith(STORAGE_PREFIX) && typeof wx !== "undefined") {
    try { wx.removeStorageSync(key); }
    catch { /* A stale ID is safe to replay against the ledger. */ }
  }
}

export function computeOperationId(actionKey: string, _options: { retry?: boolean; lastError?: unknown } = {}): string {
  return getOperationId(operationKey(actionKey));
}

export function noteComputeOperationOutcome(actionKey: string, error?: unknown, operationId?: string): void {
  finishOperation(operationKey(actionKey), error, operationId);
}

export function finishImageComputeRequest(operationId: string): void {
  if (!/^req-[a-z0-9]+-[a-z0-9]{8}$/.test(operationId)) return;
  for (const [key, pending] of openOperations) {
    if (pending === operationId) finishOperation(key, undefined, operationId);
  }
  if (typeof wx === "undefined") return;
  const receiptKey = `compute-image-request:v1:${operationId}`;
  try {
    const key = wx.getStorageSync<string>(receiptKey);
    if (typeof key !== "string" || !/^compute-request:v1:[a-f0-9]{64}$/.test(key)) return;
    if (wx.getStorageSync(key) === operationId) wx.removeStorageSync(key);
    if (openOperations.get(key) === operationId) openOperations.delete(key);
    wx.removeStorageSync(receiptKey);
  } catch { /* A retained id is safe to replay. */ }
}

export async function withComputeRequest<T>(
  actionKey: string, fn: (computeRequestId: string) => Promise<T>,
  options: { createId?: () => string; retainUntilImageStatus?: boolean; retain?: (result: T) => boolean } = {},
): Promise<T> {
  const key = operationKey(actionKey);
  const computeRequestId = getOperationId(key, options.createId);
  if (options.retainUntilImageStatus && key.startsWith(STORAGE_PREFIX) && typeof wx !== "undefined") {
    try { wx.setStorageSync(`compute-image-request:v1:${computeRequestId}`, key); }
    catch { /* Draft-persistence fallback is still in memory. */ }
  }
  try {
    const result = await fn(computeRequestId);
    if (options.retain?.(result)) return result;
    const envelope = result as { billingState?: { phase?: string }; result?: { billingState?: { phase?: string } } } | undefined;
    const state = envelope?.result ?? envelope;
    finishOperation(key, state?.billingState?.phase === "unknown" ? state : undefined, computeRequestId);
    if (options.retainUntilImageStatus && state?.billingState?.phase !== "unknown") finishImageComputeRequest(computeRequestId);
    return result;
  } catch (error) {
    finishOperation(key, error, computeRequestId);
    if (options.retainUntilImageStatus && !isUnknownOutcome(error)) finishImageComputeRequest(computeRequestId);
    throw error;
  }
}
