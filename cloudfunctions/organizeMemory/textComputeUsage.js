// Deployed independently with each text function. Keep copies byte-identical.
const { randomUUID, createHash } = require('node:crypto');
const COLLECTION = 'text_compute_operations';
const PRICE_VERSION = 'tokenhub-console-2026-09-23-estimate-v1';
const KINDS = ['chatInterview', 'organizeMemory', 'generateBiography'];

function peakAt(ms) {
  const date = new Date(ms + 8 * 3600_000);
  const day = date.getUTCDay(), hour = date.getUTCHours();
  return day > 0 && day < 6 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}
function tokenUsage(payload) {
  const u = payload?.usage;
  const input = u?.prompt_tokens, output = u?.completion_tokens;
  const cached = u?.prompt_tokens_details?.cached_tokens;
  if (![input, output, cached].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000) || cached > input)
    return null;
  if (u.total_tokens !== undefined && u.total_tokens !== input + output) return null;
  // Reasoning tokens are included in output, never added again.
  return { input, output, cached };
}
function estimate(usage, model, baseUrl, start, end) {
  if (!usage || model !== 'deepseek/deepseek-flash' || baseUrl !== 'https://tokenhub.tencentmaas.com/v1' ||
      peakAt(start) !== peakAt(end)) return null;
  // Integer hundredths of micro-compute per token. This tariff snapshot is NOT
  // a provider invoice; free credits, holidays and boundary billing are unverified.
  const peak = peakAt(start);
  const numerator = BigInt(usage.input - usage.cached) * BigInt(peak ? 400 : 200) +
    BigInt(usage.output) * BigInt(peak ? 1600 : 800) + BigInt(usage.cached) * BigInt(peak ? 8 : 4);
  const micros = Number((numerator + 99n) / 100n);
  return Number.isSafeInteger(micros) ? micros : null;
}
function summary(record) {
  const attempts = record.attempts || [];
  const unknownAttempts = attempts.filter(a => a.estimatedMicros === null).length;
  const knownMicros = attempts.reduce((sum, a) => sum + (a.estimatedMicros ?? 0), 0);
  return { id: record.operationId, kind: record.kind, startedAt: record.startedAt,
    status: unknownAttempts ? 'pending_reconciliation' : 'tariff_estimate',
    estimatedMicros: unknownAttempts ? null : knownMicros,
    knownMicros, attempts: attempts.length, unknownAttempts };
}
function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : null;
}

function createTextMeter({ db, identity, kind, model, baseUrl, fetcher, env = process.env, now = Date.now }) {
  const enabled = env.TEXT_COMPUTE_USAGE_ENABLED === 'true';
  // Wall-clock diagnostics are separate from the billing clock and contain no
  // request text, URLs, account identifiers, response bodies or raw errors.
  function timings() { return { pendingWriteMs: null, providerMs: null, receiptWriteMs: null }; }
  function elapsed(start) { return Math.max(0, Date.now() - start); }
  function logTiming(timing) {
    try { console.info('TEXT_AI_STAGE_TIMING', JSON.stringify({
      kind: KINDS.includes(kind) ? kind : 'unknown', meteringEnabled: enabled,
      pendingWriteMs: timing.pendingWriteMs, providerMs: timing.providerMs,
      receiptWriteMs: timing.receiptWriteMs,
    })); } catch { /* Diagnostics must never change the request outcome. */ }
  }
  if (!enabled) return {
    snapshot: () => null,
    async fetch(url, options) {
      const timing = timings();
      const started = Date.now();
      let response;
      try { response = await fetcher(url, options); }
      catch (error) { timing.providerMs = elapsed(started); logTiming(timing); throw error; }
      if (!response.ok) { timing.providerMs = elapsed(started); logTiming(timing); return response; }
      // Match the metered response contract; include body delivery/parsing in
      // provider latency, which is significant for non-streaming completions.
      return { ok: response.ok, status: response.status, headers: response.headers,
        async json() {
          try { return await response.json(); }
          finally { timing.providerMs = elapsed(started); logTiming(timing); }
        },
      };
    },
  };
  if (!db || !/^account_[0-9a-f]{24}$/.test(identity?.accountId || '') || !KINDS.includes(kind))
    throw new Error('TEXT_COMPUTE_IDENTITY_REQUIRED');
  const operationId = randomUUID();
  const record = { operationId, accountId: identity.accountId, kind, model,
    priceVersion: PRICE_VERSION, startedAt: now(), attempts: [] };
  const ref = db.collection(COLLECTION).doc(operationId);
  let recordingFailed = false;
  async function persist() { await ref.set({ data: { ...record, updatedAt: now() } }); }
  return {
    snapshot: () => ({ version: 1, unit: 'compute', ...summary(record), recordingFailed }),
    async fetch(url, options) {
      if (record.attempts.length >= 2) throw new Error('TEXT_COMPUTE_ATTEMPT_LIMIT');
      const attempt = { requestId: `text-${operationId}-${record.attempts.length + 1}`,
        startedAt: now(), completedAt: null, httpStatus: null, usage: null,
        estimatedMicros: null, providerRequestId: null, responseId: null };
      record.attempts.push(attempt);
      const timing = timings();
      let response, payload, parsed = false;
      try {
        // Durable pending record BEFORE submission. A crash/timeout is not free.
        const pendingStarted = Date.now();
        try { await persist(); }
        finally { timing.pendingWriteMs = elapsed(pendingStarted); }
        if (options.signal?.aborted) {
          const error = new Error('The operation was aborted'); error.name = 'AbortError'; throw error;
        }
        const providerStarted = Date.now();
        try {
          response = await fetcher(url, { ...options, headers: { ...options.headers, 'X-Request-ID': attempt.requestId } });
          attempt.httpStatus = response.status;
          attempt.providerRequestId = safeId(response.headers?.get('x-request-id'));
          payload = await response.json(); parsed = true;
          attempt.usage = tokenUsage(payload);
          attempt.responseId = safeId(payload?.id);
          attempt.completedAt = now();
          attempt.estimatedMicros = estimate(attempt.usage, model, baseUrl, attempt.startedAt, attempt.completedAt);
        } finally {
          timing.providerMs = elapsed(providerStarted);
          // Never persist prompts, generated text, raw errors or credentials.
          const receiptStarted = Date.now();
          try { await persist(); }
          catch { recordingFailed = true; console.warn('TEXT_COMPUTE_RECEIPT_WRITE_PENDING'); }
          finally { timing.receiptWriteMs = elapsed(receiptStarted); }
        }
      } finally { logTiming(timing); }

      return { ok: response.ok, status: response.status, headers: response.headers,
        json: async () => { if (!parsed) throw new Error('INVALID_MODEL_RESPONSE'); return payload; } };
    },
  };
}

async function readRecentTextUsage(db, context, env = process.env) {
  if (env.TEXT_COMPUTE_USAGE_ENABLED !== 'true') return { version: 1, unit: 'compute', enabled: false, operations: [] };
  if (!/^wx[0-9A-Za-z_-]{1,80}$/.test(context?.APPID || '') || context.APPID !== env.WECHAT_APP_ID ||
      !/^[0-9A-Za-z_-]{1,128}$/.test(context?.OPENID || '')) throw new Error('AUTH_REQUIRED');
  const accountDocumentId = 'account_' + createHash('sha256').update(context.OPENID).digest('hex').slice(0, 24);
  const account = (await db.collection('user_accounts').doc(accountDocumentId).get()).data;
  if (account?.status !== 'active' || account.wxOpenId !== context.OPENID || !/^account_[0-9a-f]{24}$/.test(account.accountId))
    throw new Error('AUTH_REQUIRED');
  const result = await db.collection(COLLECTION).where({ accountId: account.accountId }).orderBy('startedAt', 'desc').limit(10).get();
  // Recheck revocation after the read; no client-provided account id is used.
  const latest = (await db.collection('user_accounts').doc(accountDocumentId).get()).data;
  if (latest?.status !== 'active' || latest.accountId !== account.accountId || latest.wxOpenId !== context.OPENID) throw new Error('AUTH_REQUIRED');
  return { version: 1, unit: 'compute', enabled: true,
    operations: result.data.filter(r => r.accountId === account.accountId).map(summary) };
}
module.exports = { createTextMeter, readRecentTextUsage, tokenUsage, estimate, peakAt, summary, PRICE_VERSION };
