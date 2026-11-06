// Shared by every cloud function that calls a model. Keep copies byte-identical.
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { postCompute, getComputeStatement } = require("./computeGateway");

const store = new AsyncLocalStorage();
const moduleHolds = new Map();
const OPERATION_TYPES = new Set(["chatInterview", "organizeMemory", "generateBiography", "storyImages", "storyAudio"]);
const COMPUTE_UNITS_PER_YUAN = 2;
const MINOR_PER_YUAN = 1_000_000;
const DEEPSEEK_MODEL = "deepseek/deepseek-flash";
const DEEPSEEK_BASE = "https://tokenhub.tencentmaas.com/v1";
const PRICE_VERSION = "tokenhub-console-2026-09-23-estimate-v1";
const STATEMENT_STATUSES = new Set(["posted", "reserved", "processing", "reconciliation", "released", "exception"]);

const KNOWN_MODELS = [
  { model: DEEPSEEK_MODEL, provider: "tokenhub", billing: "token", operationTypes: ["chatInterview", "organizeMemory", "generateBiography", "personalMemory"] },
  { model: "hy-image-v3", provider: "tokenhub", billing: "call", operationTypes: ["storyImages"] },
  { model: "hy-vision-2.0-instruct", provider: "tokenhub", billing: "token", operationTypes: ["storyImages", "organizeMemory"] },
  { model: "music-2.5", provider: "302", billing: "call", operationTypes: ["storyAudio"] },
  { model: "volc.seedasr.auc", provider: "volc", billing: "call", operationTypes: ["organizeMemory"] },
  { model: "volc.bigasr.auc_turbo", provider: "volc", billing: "call", operationTypes: ["organizeMemory"] },
  { model: "tencent-tts", provider: "tencent", billing: "call", operationTypes: ["storyAudio"] },
];

function billingError(code, message) {
  return Object.assign(new Error(message), { code, definitelyNotSubmitted: true });
}
function insufficientError() {
  return billingError("INSUFFICIENT_COMPUTE", "算力不足，请先充值");
}
function unpricedError() {
  return billingError("PRICE_NOT_CONFIGURED", "该模型计费暂未配置");
}
function billingEnabled(env = process.env) {
  return env.SHIGUANG_COMPUTE_ENABLED === "true";
}
function activeEnv() {
  return store.getStore()?.env || process.env;
}
function createScope(seed = {}) {
  return {
    operationType: seed.operationType || null,
    requestId: seed.requestId || null,
    stableId: seed.stableId || null,
    context: seed.context || null,
    db: seed.db || null,
    post: seed.post || null,
    env: seed.env || process.env,
    holdStore: seed.holdStore || null,
  };
}
function runScope(box, fn) {
  return store.run(box, fn);
}
function noteBillingIdentity(identity, db) {
  const box = store.getStore();
  if (!box || !identity) return;
  const openid = String(identity.openid || "");
  const appId = String(identity.appId || box.env?.WECHAT_APP_ID || "");
  if (/^wx[0-9A-Za-z_-]{1,80}$/.test(appId) && /^[0-9A-Za-z_-]{1,128}$/.test(openid)) {
    box.context = { APPID: appId, OPENID: openid };
  }
  if (db) box.db = db;
}
async function withStableBillingId(stableId, fn) {
  const box = store.getStore();
  if (!box) return fn();
  const previous = box.stableId;
  box.stableId = stableId;
  try { return await fn(); }
  finally { box.stableId = previous; }
}
function contextForOpenid(openid, env = process.env) {
  const appId = String(env.WECHAT_APP_ID || "");
  if (!/^wx[0-9A-Za-z_-]{1,80}$/.test(appId) || !/^[0-9A-Za-z_-]{1,128}$/.test(String(openid || ""))) return null;
  return { APPID: appId, OPENID: String(openid) };
}
async function billAs(seed, fn) {
  const parent = store.getStore();
  const env = seed.env || parent?.env || process.env;
  if (!billingEnabled(env)) return fn();
  if (parent && !seed.context) return withStableBillingId(seed.stableId, fn);
  return runScope(createScope({
    operationType: seed.operationType || parent?.operationType || null,
    requestId: seed.requestId || parent?.requestId || null,
    stableId: seed.stableId || parent?.stableId || null,
    context: seed.context || parent?.context || null,
    db: seed.db || parent?.db || null,
    post: seed.post || parent?.post || null,
    env, holdStore: seed.holdStore || parent?.holdStore || null,
  }), fn);
}

function envKeySegment(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}
function readConfiguredYuan(env, provider, model) {
  if (!provider || !model) return null;
  const keys = [
    `TEXT_PRICE_${envKeySegment(provider)}_${envKeySegment(model)}_PER_1K_YUAN`,
    `TEXT_PRICE_${envKeySegment(provider)}_PER_1K_YUAN`,
  ];
  for (const key of keys) {
    if (env[key] === undefined) continue;
    const value = Number(env[key]);
    return Number.isFinite(value) && value > 0 ? { yuanPer1k: value, source: key } : { invalid: key };
  }
  return null;
}
function providerForUrl(url) {
  try {
    const host = new URL(url).hostname;
    if (host === "tokenhub.tencentmaas.com") return "tokenhub";
    if (host === "api.302.ai") return "302";
    if (host === "openspeech.bytedance.com") return "volc";
    if (host === "tts.tencentcloudapi.com") return "tencent";
  } catch { /* unrecognised endpoints have no price */ }
  return null;
}
function peakAt(ms) {
  const date = new Date(ms + 8 * 3600_000);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  return day > 0 && day < 6 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}
function tariffMicros(usage, peak) {
  const numerator = BigInt(usage.input - usage.cached) * BigInt(peak ? 400 : 200)
    + BigInt(usage.output) * BigInt(peak ? 1600 : 800)
    + BigInt(usage.cached) * BigInt(peak ? 8 : 4);
  const micros = Number((numerator + 99n) / 100n);
  return Number.isSafeInteger(micros) ? micros : null;
}
function microsToMinor(micros) {
  return Math.max(1, Math.ceil(micros / COMPUTE_UNITS_PER_YUAN));
}
function ceilYuanToMinor(yuan) {
  const minor = Math.ceil(yuan * MINOR_PER_YUAN);
  return Number.isSafeInteger(minor) ? minor : null;
}
function roundYuanToMinor(yuan) {
  const minor = Math.round(yuan * MINOR_PER_YUAN);
  return Number.isSafeInteger(minor) ? minor : null;
}
function messageShape(body) {
  let parsed;
  try { parsed = JSON.parse(body || ""); }
  catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const model = typeof parsed.model === "string" ? parsed.model : null;
  let chars = 0;
  let sawMessage = false;
  if (Array.isArray(parsed.messages)) {
    sawMessage = true;
    for (const message of parsed.messages) {
      const content = message && message.content;
      if (typeof content === "string") chars += content.length;
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === "string") chars += part.length;
          else if (part && part.type === "text") chars += String(part.text || "").length;
          else if (part && part.type === "image_url") chars += 1500;
        }
      }
    }
  }
  const requested = parsed.max_tokens;
  const maxTokens = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 32000) : 8192;
  return { model, chars, maxTokens, chat: sawMessage || /\/chat\/completions$/.test(String(parsed.url || "")) };
}
function isChatUrl(url) {
  return /\/chat\/completions(?:\?|$)/.test(String(url || ""));
}
function quoteCall({ url, body, model, env, now = Date.now() }) {
  const parsed = messageShape(body);
  const resolvedModel = model || parsed?.model || null;
  const provider = providerForUrl(url);
  const configured = readConfiguredYuan(env, provider, resolvedModel);
  if (configured && configured.invalid) return null;
  const chat = isChatUrl(url) || Boolean(parsed && parsed.chat);
  if (configured && chat) {
    const tokens = (parsed ? parsed.chars : 0) + (parsed ? parsed.maxTokens : 8192);
    const maxCostMinor = ceilYuanToMinor((tokens / 1000) * configured.yuanPer1k);
    if (!maxCostMinor || maxCostMinor <= 0) return null;
    return {
      model: resolvedModel, provider, source: configured.source, chat: true,
      maxCostMinor: Math.max(1, maxCostMinor),
      verifiedMinor(usage) {
        const total = usage && Number.isSafeInteger(usage.total) ? usage.total : null;
        if (total === null) return null;
        return roundYuanToMinor((total / 1000) * configured.yuanPer1k);
      },
    };
  }
  const base = String(url || "").replace(/\/chat\/completions$/, "");
  if (resolvedModel === DEEPSEEK_MODEL && (base === DEEPSEEK_BASE || String(url || "").startsWith(DEEPSEEK_BASE + "/chat/completions"))) {
    const input = parsed ? parsed.chars : 0;
    const output = parsed ? parsed.maxTokens : 8192;
    const hold = Math.max(tariffMicros({ input, output, cached: 0 }, true), tariffMicros({ input, output, cached: 0 }, false));
    if (!Number.isSafeInteger(hold)) return null;
    return {
      model: resolvedModel, provider: "tokenhub", source: PRICE_VERSION, chat: true,
      maxCostMinor: microsToMinor(hold),
      verifiedMinor(usage, startedAt, finishedAt) {
        if (!usage) return null;
        if (peakAt(startedAt) !== peakAt(finishedAt)) return null;
        const micros = tariffMicros(usage, peakAt(startedAt));
        return Number.isSafeInteger(micros) ? microsToMinor(micros) : null;
      },
    };
  }
  return null;
}
function priceCatalog(env = process.env) {
  return KNOWN_MODELS.map(item => {
    const sampleUrl = item.provider === "tokenhub"
      ? (item.billing === "token" ? DEEPSEEK_BASE + "/chat/completions" : "https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v3-generation")
      : item.provider === "302" ? "https://api.302.ai/minimaxi/v1/music_generation"
      : item.provider === "volc" ? "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
      : "https://tts.tencentcloudapi.com";
    const body = item.billing === "token" ? JSON.stringify({ model: item.model, messages: [{ content: "x" }], max_tokens: 1 }) : JSON.stringify({ model: item.model });
    const quote = quoteCall({ url: sampleUrl, body, model: item.model, env });
    return {
      model: item.model, provider: item.provider, billing: item.billing,
      operationTypes: item.operationTypes,
      operationTypeSupported: item.operationTypes.every(type => OPERATION_TYPES.has(type)),
      priced: Boolean(quote),
      source: quote ? quote.source : null,
    };
  });
}

function cleanId(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "");
  if (cleaned.length < 8) return null;
  if (cleaned.length <= 80) return cleaned;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}
function operationIdFor(scope, url, model) {
  const prefix = cleanId(scope.stableId) || cleanId(scope.requestId);
  if (!prefix) throw billingError("IDEMPOTENCY_KEY_REQUIRED", "算力请求缺少幂等键，请更新后再试");
  let path = String(url || "");
  try { path = new URL(url).pathname; } catch { /* keep the raw url */ }
  const tag = crypto.createHash("sha256").update(path + "\n" + String(model || "")).digest("hex").slice(0, 12);
  return `${prefix}-${tag}`;
}
function requestHashFor(operationType, model, url, body) {
  return crypto.createHash("sha256").update(JSON.stringify({
    operationType, model: model || "", url: String(url || ""), body: crypto.createHash("sha256").update(String(body ?? "")).digest("hex"),
  })).digest("hex");
}
function holdsOf(scope) {
  return scope.holdStore || moduleHolds;
}
function holdDocId(operationId) {
  return "hold_" + crypto.createHash("sha256").update(operationId).digest("hex").slice(0, 32);
}
async function saveHold(scope, record) {
  holdsOf(scope).set(record.operationId, record);
  if (!scope.db) return;
  try { await scope.db.collection("compute_billing_holds").doc(holdDocId(record.operationId)).set({ data: record }); }
  catch { /* The Drinking Time operation id remains the recoverable key. */ }
}
async function loadHold(scope, operationId) {
  const cached = holdsOf(scope).get(operationId);
  if (cached) return cached;
  if (!scope.db) return null;
  try {
    const data = (await scope.db.collection("compute_billing_holds").doc(holdDocId(operationId)).get()).data;
    if (data && data.operationId === operationId) {
      holdsOf(scope).set(operationId, data);
      return data;
    }
  } catch { /* missing local copy; the bridge reservation still decides */ }
  return null;
}
function poster(scope) {
  return scope.post || postCompute;
}
async function postSettle(scope, operationId, outcome) {
  const result = await poster(scope)(scope.context, "settle", { operationId, outcome });
  return result;
}
function usageOf(payload) {
  const usage = payload && payload.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  const cached = usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens !== undefined
    ? usage.prompt_tokens_details.cached_tokens : 0;
  const total = usage.total_tokens !== undefined ? usage.total_tokens : (Number.isSafeInteger(input) && Number.isSafeInteger(output) ? input + output : null);
  if (![input, output, cached].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000)) return null;
  if (cached > input || !Number.isSafeInteger(total) || total < 0) return null;
  return { input, output, cached, total };
}
async function finishHold(scope, record, outcome) {
  const pending = { ...record, phase: "settle_pending", outcome };
  await saveHold(scope, pending);
  try {
    const result = await postSettle(scope, record.operationId, outcome);
    const phase = outcome.kind === "succeeded" || outcome.kind === "charged_failure" ? "settled"
      : outcome.kind === "not_charged_failure" ? "released" : "frozen";
    await saveHold(scope, { ...pending, phase, bridgeOutcome: result && result.outcome || null });
    return result;
  } catch (error) {
    await saveHold(scope, pending);
    throw error;
  }
}
function replayError() {
  return billingError("COMPUTE_REPLAY", "这次请求已经提交，请勿重复发起");
}

async function prepareCall(scope, { url, body, model }) {
  if (!scope || !scope.context) throw billingError("COMPUTE_CONTEXT_REQUIRED", "算力暂不可用，请稍后重试");
  if (!OPERATION_TYPES.has(scope.operationType)) throw unpricedError();
  const quote = quoteCall({ url, body, model, env: scope.env || process.env });
  if (!quote) throw unpricedError();
  const operationId = operationIdFor(scope, url, quote.model);
  const requestHash = requestHashFor(scope.operationType, quote.model, url, body);
  const existing = await loadHold(scope, operationId);
  if (existing && existing.requestHash !== requestHash) throw billingError("COMPUTE_CONFLICT", "这次请求和已有的算力预占不一致");
  if (existing && existing.phase === "settle_pending" && existing.outcome) {
    try { await finishHold(scope, existing, existing.outcome); } catch { /* still pending; do not call the model */ }
    throw replayError();
  }
  if (existing && ["settled", "released", "frozen"].includes(existing.phase)) throw replayError();
  let reservation;
  try {
    reservation = await poster(scope)(scope.context, "reserve", {
      operationId, operationType: scope.operationType, requestHash, maxCostMinor: quote.maxCostMinor,
    });
  } catch {
    throw billingError("COMPUTE_UNAVAILABLE", "算力暂不可用，请稍后重试");
  }
  if (reservation?.outcome === "insufficient_balance") throw insufficientError();
  if (reservation?.outcome === "conflict") throw billingError("COMPUTE_CONFLICT", "这次请求和已有的算力预占不一致");
  if (reservation?.outcome === "replayed") {
    if (existing?.phase === "settle_pending" && existing.outcome) {
      try { await finishHold(scope, existing, existing.outcome); } catch { /* keep the hold */ }
    } else if (!existing || existing.phase === "reserved") {
      try { await finishHold(scope, { operationId, requestHash, maxCostMinor: quote.maxCostMinor, phase: "reserved" }, { kind: "submission_unknown" }); }
      catch { /* unknown stays reserved at Drinking Time */ }
    }
    throw replayError();
  }
  if (reservation?.outcome !== "reserved") throw billingError("COMPUTE_UNAVAILABLE", "算力暂不可用，请稍后重试");
  const record = {
    operationId, requestHash, maxCostMinor: quote.maxCostMinor, phase: "reserved",
    model: quote.model, operationType: scope.operationType, startedAt: Date.now(),
  };
  await saveHold(scope, record);
  return {
    quote, record,
    settle(outcome) { return finishHold(scope, record, outcome); },
  };
}

function httpOutcome(status) {
  if (status >= 400 && status < 500) return { kind: "not_charged_failure" };
  return { kind: "submission_unknown" };
}
function successOutcome(payload, quote, startedAt) {
  const usage = usageOf(payload);
  const verified = quote.verifiedMinor(usage, startedAt, Date.now());
  if (!Number.isSafeInteger(verified) || verified < 0) return { kind: "submission_unknown" };
  return { kind: "succeeded", verifiedCostMinor: verified };
}

function instrumentFetch(fetchImpl) {
  if (fetchImpl && fetchImpl.computeBilled) return fetchImpl;
  async function wrapped(url, options = {}) {
    if (!billingEnabled(activeEnv())) return fetchImpl(url, options);
    const prepared = await prepareCall(store.getStore(), { url, body: options.body, model: messageShape(options.body)?.model || null });
    let response;
    try { response = await fetchImpl(url, options); }
    catch (error) {
      try { await prepared.settle({ kind: "submission_unknown" }); } catch { /* hold remains */ }
      throw error;
    }
    if (!response || response.ok !== true) {
      try { await prepared.settle(httpOutcome(response && response.status)); } catch { /* hold remains on an ambiguous failure */ }
      return response;
    }
    if (typeof response.json === "function") {
      const original = response.json.bind(response);
      let settled = false;
      response.json = async () => {
        let payload;
        try { payload = await original(); }
        catch (error) {
          if (!settled) {
            settled = true;
            try { await prepared.settle({ kind: "submission_unknown" }); } catch { /* hold remains */ }
          }
          throw error;
        }
        if (!settled) {
          settled = true;
          try { await prepared.settle(successOutcome(payload, prepared.quote, prepared.record.startedAt)); }
          catch { /* the payload is still returned; the saved outcome can be settled again */ }
        }
        return payload;
      };
    }
    return response;
  }
  wrapped.computeBilled = true;
  return wrapped;
}

/**
 * Fetch billing settles non-2xx before returning. A 2xx body is settled when
 * the caller reads json(); until then the hold stays, which matches an unread
 * or crashed response. billCall is for SDKs that return the payload directly.
 */
async function billCall({ model, url, body, call }) {
  if (!billingEnabled(activeEnv())) return call();
  const prepared = await prepareCall(store.getStore(), { url, body, model });
  let value;
  try { value = await call(); }
  catch (error) {
    try { await prepared.settle({ kind: "submission_unknown" }); } catch { /* hold remains */ }
    throw error;
  }
  try { await prepared.settle(successOutcome(value, prepared.quote, prepared.record.startedAt)); }
  catch { /* caller still receives the provider result */ }
  return value;
}

function isMinor(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function statementItem(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return null;
  if (typeof value.label !== "string" || value.label.length < 1 || value.label.length > 80) return null;
  if (/secret|api[_-]?key|bearer|sk-|token/i.test(value.label)) return null;
  if (![value.amountMinor, value.reservedMinor, value.releasedMinor].every(isMinor)) return null;
  if (!STATEMENT_STATUSES.has(value.status) || typeof value.estimated !== "boolean") return null;
  return {
    createdAt: value.createdAt, label: value.label, amountMinor: value.amountMinor,
    reservedMinor: value.reservedMinor, releasedMinor: value.releasedMinor,
    status: value.status, estimated: value.estimated,
  };
}
function parseStatement(value) {
  if (!value || value.available === false) {
    return { version: 1, available: false, reason: value && value.reason || "statement_unavailable" };
  }
  if (value.version !== 1 || value.currency !== "CNY" || !value.balance || typeof value.balance !== "object") return null;
  const lists = ["attentionItems", "historyItems"];
  for (const key of lists) {
    if (!Array.isArray(value[key]) || value[key].length > 100) return null;
  }
  const attentionItems = value.attentionItems.map(statementItem);
  const historyItems = value.historyItems.map(statementItem);
  if (attentionItems.some(item => !item) || historyItems.some(item => !item)) return null;
  if (typeof value.attentionHasMore !== "boolean" || typeof value.historyHasMore !== "boolean") return null;
  if (typeof value.coverageNote !== "string" || value.coverageNote.length > 1000) return null;
  if (/secret|api[_-]?key|bearer|sk-/i.test(value.coverageNote)) return null;
  const balance = value.balance;
  if (!["postedMinor", "reservedMinor", "availableMinor", "lifetimeSpentMinor"].every(key => isMinor(balance[key]))) return null;
  return {
    version: 1, available: true, currency: "CNY",
    balance: {
      postedMinor: balance.postedMinor, reservedMinor: balance.reservedMinor,
      availableMinor: balance.availableMinor, lifetimeSpentMinor: balance.lifetimeSpentMinor,
    },
    attentionItems, attentionHasMore: value.attentionHasMore,
    historyItems, historyHasMore: value.historyHasMore,
    coverageNote: value.coverageNote,
  };
}
async function loadComputeStatement(context, query, env = process.env, get = getComputeStatement) {
  const raw = await get(context, {
    limit: query && query.limit, historyOffset: query && query.historyOffset, attentionOffset: query && query.attentionOffset,
  }, env);
  const parsed = parseStatement(raw);
  if (!parsed) return { version: 1, available: false, reason: "statement_unavailable" };
  return parsed;
}
function resetBillingStateForTests() {
  moduleHolds.clear();
}

module.exports = {
  COMPUTE_UNITS_PER_YUAN, DEEPSEEK_MODEL, KNOWN_MODELS, OPERATION_TYPES, PRICE_VERSION,
  billAs, billCall, billingEnabled, contextForOpenid, createScope, instrumentFetch, loadComputeStatement,
  noteBillingIdentity, parseStatement, priceCatalog, quoteCall, requestHashFor, resetBillingStateForTests,
  runScope, tariffMicros, withStableBillingId,
};
