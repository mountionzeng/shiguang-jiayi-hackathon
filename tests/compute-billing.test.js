const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const billing = require("../cloudfunctions/getOpenId/computeBilling");
const gateway = require("../cloudfunctions/getOpenId/computeGateway");

const URL = "https://tokenhub.tencentmaas.com/v1/chat/completions";
const CONTEXT = { APPID: "wx1234", OPENID: "trusted_openid" };

function bodyFor(text, maxTokens = 32) {
  return JSON.stringify({
    model: billing.DEEPSEEK_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: text }],
  });
}
function usagePayload(input, output, cached = 0) {
  return { usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: cached } }, choices: [{ message: { content: "ok" } }] };
}
function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, headers: { get() { return null; } }, json: async () => payload };
}

function bridge(options = {}) {
  const posts = [];
  const reserved = new Map();
  let balance = options.balance ?? 1_000_000_000;
  return {
    posts,
    async post(context, action, fields) {
      posts.push({ context, action, fields: { ...fields, ...(fields.outcome ? { outcome: { ...fields.outcome } } : {}) } });
      assert.equal(fields.userId, undefined);
      assert.equal(fields.subject, undefined);
      if (action === "reserve") {
        const key = `${context.OPENID}:${fields.operationId}`;
        const previous = reserved.get(key);
        if (previous && previous.requestHash !== fields.requestHash) return { outcome: "conflict" };
        if (previous) return { outcome: "replayed", status: previous.phase };
        if (balance < fields.maxCostMinor) return { outcome: "insufficient_balance", requiredMinor: fields.maxCostMinor };
        balance -= fields.maxCostMinor;
        reserved.set(key, { requestHash: fields.requestHash, phase: "reserved", maxCostMinor: fields.maxCostMinor });
        return { outcome: "reserved" };
      }
      if (action === "settle") {
        if (options.failSettle) { options.failSettle = false; throw new Error("COMPUTE_TIMEOUT"); }
        const key = `${context.OPENID}:${fields.operationId}`;
        const previous = reserved.get(key);
        assert.ok(previous, "settle without reserve");
        previous.phase = fields.outcome.kind === "not_charged_failure" ? "released" : fields.outcome.kind === "submission_unknown" ? "frozen" : "settled";
        previous.outcome = fields.outcome;
        return { outcome: previous.phase === "settled" ? "settled" : previous.phase };
      }
      throw new Error("unexpected " + action);
    },
  };
}

function scope(post, holdStore, extra = {}) {
  return billing.createScope({
    operationType: "chatInterview",
    requestId: "request-1234",
    context: CONTEXT,
    post, holdStore, env: { SHIGUANG_COMPUTE_ENABLED: "true", WECHAT_APP_ID: "wx1234" },
    ...extra,
  });
}

async function run(box, fetchImpl, requestBody) {
  let calls = 0;
  const fetcher = billing.instrumentFetch(async () => {
    calls += 1;
    return fetchImpl();
  });
  return { result: billing.runScope(box, () => fetcher(URL, { method: "POST", body: requestBody })), calls: () => calls };
}

test("billing copies stay byte-identical across cloud functions", () => {
  const dirs = ["getOpenId", "chatInterview", "organizeMemory", "generateBiography", "personalMemory", "storyImages", "storyAudio"];
  for (const name of ["computeBilling.js", "computeGateway.js"]) {
    const hashes = dirs.map(dir => fs.readFileSync(path.join("cloudfunctions", dir, name)));
    assert.ok(hashes.every(buf => buf.equals(hashes[0])));
  }
});

test("low balance does not call the model and ignores caller identity or amounts", async () => {
  billing.resetBillingStateForTests();
  const wallet = bridge({ balance: 1 });
  const box = scope(wallet.post, new Map());
  box.clientUserId = 7;
  box.clientMaxCostMinor = 1;
  const seen = await run(box, () => { throw new Error("model called"); }, bodyFor("hello"));
  await assert.rejects(seen.result, /算力不足，请先充值/);
  assert.equal(seen.calls(), 0);
  assert.equal(wallet.posts.length, 1);
  assert.deepEqual(Object.keys(wallet.posts[0].fields).sort(), ["maxCostMinor", "operationId", "operationType", "requestHash"]);
  assert.equal(wallet.posts[0].context.OPENID, "trusted_openid");
  assert.ok(wallet.posts[0].fields.maxCostMinor > 1);
});

test("token price reuses the published deepseek tariff and a missing model is refused", async () => {
  const text = "甲".repeat(1000);
  const requestBody = bodyFor(text, 1000);
  const quote = billing.quoteCall({ url: URL, body: requestBody, env: {} });
  const hold = Math.max(
    billing.tariffMicros({ input: 1000, output: 1000, cached: 0 }, true),
    billing.tariffMicros({ input: 1000, output: 1000, cached: 0 }, false),
  );
  assert.equal(quote.source, billing.PRICE_VERSION);
  assert.equal(quote.maxCostMinor, Math.max(1, Math.ceil(hold / billing.COMPUTE_UNITS_PER_YUAN)));
  assert.notEqual(quote.maxCostMinor, Math.ceil((2000 / 1000) * 0.01 * 1_000_000));
  const missing = priceCatalogMissing();
  assert.ok(missing.includes("deepseek/deepseek-flash"));
  assert.ok(missing.includes("volc.bigasr.auc_turbo"));
  assert.equal(missing.includes("hy-image-v3"), false);
  const wallet = bridge();
  const calls = [];
  await assert.rejects(billing.runScope(scope(wallet.post, new Map()), () => billing.instrumentFetch(async () => { calls.push(1); return response(200, {}); })(
    URL, { body: JSON.stringify({ model: "unknown-model", messages: [{ content: "x" }] }) },
  )), /该模型计费暂未配置/);
  assert.equal(calls.length, 0);
  assert.equal(wallet.posts.length, 0);
});

function priceCatalogMissing() {
  return billing.priceCatalog({}).filter(item => !item.priced || !item.operationTypeSupported).map(item => item.model);
}

test("success settles once, an explicit refusal releases, and a timeout keeps the hold", async () => {
  billing.resetBillingStateForTests();
  for (const [status, kind] of [[200, "succeeded"], [422, "not_charged_failure"]]) {
    const wallet = bridge();
    const store = new Map();
    const box = scope(wallet.post, store, { requestId: "request-" + status });
    const payload = usagePayload(20, 10, 4);
    const executed = await run(box, () => response(status, payload), bodyFor("settle-" + status));
    const http = await executed.result;
    if (status === 200) {
      await http.json();
      const settle = wallet.posts.find(item => item.action === "settle");
      assert.equal(settle.fields.outcome.kind, "succeeded");
      const usage = { input: 20, output: 10, cached: 4 };
      const candidates = [true, false].map(peak => Math.max(1, Math.ceil(billing.tariffMicros(usage, peak) / billing.COMPUTE_UNITS_PER_YUAN)));
      assert.ok(candidates.includes(settle.fields.outcome.verifiedCostMinor));
      assert.ok(settle.fields.outcome.verifiedCostMinor <= wallet.posts[0].fields.maxCostMinor);
    } else {
      assert.equal(wallet.posts.at(-1).fields.outcome.kind, kind);
      assert.equal(wallet.posts.at(-1).fields.outcome.verifiedCostMinor, undefined);
    }
    assert.equal(executed.calls(), 1);
  }
  const wallet = bridge();
  const box = scope(wallet.post, new Map(), { requestId: "request-timeout" });
  const executed = await run(box, () => { const error = new Error("The operation was aborted"); error.name = "AbortError"; throw error; }, bodyFor("timeout"));
  await assert.rejects(executed.result, /aborted/);
  assert.equal(executed.calls(), 1);
  assert.equal(wallet.posts.at(-1).action, "settle");
  assert.equal(wallet.posts.at(-1).fields.outcome.kind, "submission_unknown");
  assert.equal(wallet.posts.filter(item => item.fields.outcome?.kind === "not_charged_failure").length, 0);
});

test("retries, conflicts and a second user do not double-charge or share a result", async () => {
  billing.resetBillingStateForTests();
  const wallet = bridge();
  const store = new Map();
  const requestBody = bodyFor("same");
  const first = await run(scope(wallet.post, store), () => response(200, usagePayload(8, 2)), requestBody);
  await (await first.result).json();
  const secondCalls = [];
  await assert.rejects(billing.runScope(scope(wallet.post, store), () => billing.instrumentFetch(async () => { secondCalls.push(1); return response(200, usagePayload(8, 2)); })(URL, { body: requestBody })), /已经提交/);
  assert.equal(secondCalls.length, 0);
  assert.equal(wallet.posts.filter(item => item.action === "reserve").length, 1);
  assert.equal(wallet.posts.filter(item => item.action === "settle" && item.fields.outcome.kind === "succeeded").length, 1);
  store.clear();
  await assert.rejects(billing.runScope(scope(wallet.post, store), () => billing.instrumentFetch(async () => { secondCalls.push(1); return response(200, usagePayload(8, 2)); })(URL, { body: requestBody })), /已经提交/);
  assert.equal(secondCalls.length, 0);
  assert.equal(wallet.posts.filter(item => item.action === "reserve" && item.fields && wallet.posts.filter(item2 => item2.action === "reserve").length >= 2).length, 2);
  const conflictCalls = [];
  await assert.rejects(billing.runScope(scope(wallet.post, store), () => billing.instrumentFetch(async () => { conflictCalls.push(1); return response(200, {}); })(URL, { body: bodyFor("different") })), /不一致/);
  assert.equal(conflictCalls.length, 0);
  const other = { APPID: "wx1234", OPENID: "other_user" };
  const otherWallet = bridge();
  const otherScope = scope(otherWallet.post, new Map());
  otherScope.context = other;
  const otherRun = await run(otherScope, () => response(200, usagePayload(3, 1)), requestBody);
  await (await otherRun.result).json();
  assert.equal(otherRun.calls(), 1);
  assert.equal(otherWallet.posts[0].context.OPENID, "other_user");
  assert.equal(otherWallet.posts[0].fields.operationId, wallet.posts.find(item => item.action === "reserve").fields.operationId);
});

test("a successful model call whose settlement times out can be settled again without another model call", async () => {
  billing.resetBillingStateForTests();
  const wallet = bridge({ failSettle: true });
  const store = new Map();
  const requestBody = bodyFor("recover");
  const first = await run(scope(wallet.post, store, { requestId: "request-recover" }), () => response(200, usagePayload(11, 7)), requestBody);
  const payload = await (await first.result).json();
  assert.equal(payload.choices[0].message.content, "ok");
  assert.equal(first.calls(), 1);
  assert.equal([...store.values()][0].phase, "settle_pending");
  const again = [];
  await assert.rejects(billing.runScope(scope(wallet.post, store, { requestId: "request-recover" }), () => billing.instrumentFetch(async () => { again.push(1); return response(200, usagePayload(11, 7)); })(URL, { body: requestBody })), /已经提交/);
  assert.equal(again.length, 0);
  assert.equal([...store.values()][0].phase, "settled");
  assert.equal(wallet.posts.filter(item => item.action === "settle" && item.fields.outcome.kind === "succeeded").length, 2);
});

test("statement is a signed POST with limit and an optional opaque cursor", async () => {
  assert.deepEqual(await gateway.getComputeStatement(CONTEXT, { userId: 9, subject: "forged", limit: 1000 }), {
    version: 1, available: false, reason: "statement_not_enabled",
  });
  assert.deepEqual(gateway.statementRequestFields({ limit: 1000, userId: 4, subject: "forged", historyOffset: 40 }), { limit: 20 });
  assert.deepEqual(gateway.statementRequestFields({ limit: 50, cursor: "opaque_Cursor-1" }), { limit: 50, cursor: "opaque_Cursor-1" });
  assert.deepEqual(gateway.statementRequestFields({ cursor: "bad cursor" }), { limit: 20 });
  const queries = [];
  const view = await billing.loadComputeStatement(CONTEXT, { limit: 30, cursor: "page-two", userId: 5, subject: "forged" }, process.env, (context, query) => {
    queries.push({ context, query });
    return { version: 1, available: false, reason: "statement_unavailable" };
  });
  assert.equal(queries[0].context, CONTEXT);
  assert.deepEqual(queries[0].query, { limit: 30, cursor: "page-two" });
  assert.equal(view.available, false);
  const row = { occurredAt: "2026-11-06T02:00:00.000Z", kind: "settle", type: "shiguang.chatInterview", status: "settled", amountMicros: -500000 };
  const parsed = billing.parseStatement({ version: 1, unit: "compute", items: [row], nextCursor: "next_page" });
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.nextCursor, "next_page");
  assert.equal(parsed.items[0].amountMicros, -500000);
  assert.equal(billing.parseStatement({ version: 1, unit: "compute", items: [{ ...row, amountMicros: 1 }], nextCursor: null }), null);
  assert.equal(billing.parseStatement({ version: 1, unit: "compute", items: [{ ...row, type: "prompt text" }], nextCursor: null }), null);
  assert.equal(billing.parseStatement({ version: 1, unit: "CNY", items: [row], nextCursor: null }), null);
  assert.equal(billing.parseStatement({ version: 1, unit: "compute", items: new Array(51).fill(row), nextCursor: null }), null);
});

test("media quotes use confirmed compute-unit prices and the existing yuan ratio", () => {
  const { IMAGE_MODEL } = require("../cloudfunctions/storyImages/tokenhub");
  assert.equal(IMAGE_MODEL, "hy-image-v3");
  const image = billing.quoteCall({ url: "https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v3-generation", model: "hy-image-v3", env: {} });
  assert.equal(image.source, billing.MEDIA_PRICE_SOURCE);
  assert.equal(image.maxCostMinor, 200_000);
  assert.equal(image.verifiedMinor(), 200_000);
  const overridden = billing.quoteCall({ url: "https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v3-generation", model: "hy-image-v3", env: { COMPUTE_PRICE_HY_IMAGE_V3_PER_IMAGE_UNITS: "0.8" } });
  assert.equal(overridden.maxCostMinor, 400_000);
  assert.equal(billing.quoteCall({ url: "https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v3-generation", model: "hy-image-v3", env: { COMPUTE_PRICE_HY_IMAGE_V3_PER_IMAGE_UNITS: "0" } }), null);
  const preview = billing.quoteCall({ model: "hy-image-v3.5-preview", env: {} });
  assert.equal(billing.HY_IMAGE_V3_5_PREVIEW_PER_IMAGE_UNITS, 0.3);
  assert.equal(preview.maxCostMinor, 150_000);
  const vision = billing.quoteCall({ url: "https://tokenhub.tencentmaas.com/v1/chat/completions", body: JSON.stringify({ model: "hy-vision-2.0-instruct", messages: [{ content: "x" }] }), env: {} });
  assert.equal(vision.maxCostMinor, 50_000);
  assert.equal(vision.verifiedMinor({ input: 1000, output: 200 }), 11_000);
  assert.equal(vision.verifiedMinor(null), null);
  const music = billing.quoteCall({ url: "https://api.302.ai/minimaxi/v1/music_generation", model: "music-2.5", env: {} });
  assert.equal(music.maxCostMinor, 1_000_000);
  assert.equal(music.verifiedMinor(), 1_000_000);
  const minute = billing.quoteCall({ url: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit", model: "volc.seedasr.auc", body: JSON.stringify({ durationMs: 60_000 }), env: {} });
  assert.equal(minute.maxCostMinor, 13_500);
  assert.equal(minute.verifiedMinor(), 13_500);
  const unknownAudio = billing.quoteCall({ url: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit", headers: { "X-Api-Resource-Id": "volc.seedasr.auc" }, env: {} });
  assert.equal(unknownAudio.maxCostMinor, 135_000);
  assert.equal(unknownAudio.verifiedMinor(), null);
  assert.equal(billing.quoteCall({ url: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query", model: "volc.seedasr.auc", env: {} }).passthrough, true);
  assert.equal(billing.quoteCall({ url: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash", model: "volc.bigasr.auc_turbo", env: {} }), null);
  const speech = billing.quoteCall({ url: "https://tts.tencentcloudapi.com", model: "tencent-tts", body: JSON.stringify({ chars: 100, VoiceType: 101001 }), env: {} });
  assert.equal(speech.maxCostMinor, 3_000);
  assert.equal(speech.verifiedMinor(), 3_000);
  assert.equal(billing.quoteCall({ url: "https://tts.tencentcloudapi.com", model: "tencent-tts", body: JSON.stringify({ chars: 100, VoiceType: 200000000, FastVoiceType: "fast-1" }), env: {} }), null);
});
