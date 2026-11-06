import test from "node:test";
import assert from "node:assert/strict";
import { formatBeijingTime, parseLedgerView } from "../miniprogram/services/computeStatementService";
import { textComputeHint } from "../miniprogram/services/textComputeUsageService";
import { computeBillingFailure } from "../miniprogram/services/computeBillingPrompt";

test("ledger rows use Beijing time and stay separate from the text estimate", () => {
  assert.equal(formatBeijingTime("2026-01-01T16:30:00.000Z"), "1/2 00:30 北京时间");
  const view = parseLedgerView({
    version: 1, currency: "CNY", available: true,
    attentionItems: [], attentionHasMore: false,
    historyItems: [{ createdAt: "2026-01-01T16:30:00.000Z", label: "文字生成", amountMinor: -250000, reservedMinor: 0, releasedMinor: 0, status: "posted", estimated: true }],
    historyHasMore: false,
  });
  assert.equal(view.hint, "账户流水（北京时间），与下方文字用量预估分开");
  assert.equal(view.rows[0].time, "1/2 00:30 北京时间");
  assert.match(view.rows[0].detail, /已入账 -0\.50 算力/);
  assert.doesNotMatch(JSON.stringify(view), /¥|人民币|尚未扣减/);
  assert.equal(parseLedgerView({ available: false }).hint, "账户流水暂未开通");
  assert.equal(textComputeHint({ enabled: true, rows: [{ id: "a", label: "采访追问", detail: "预估 0.01 算力", time: "1/2 00:30" }] }), "文字用量预估（非账户流水），按 2026-09-23 价格估算，不是扣费记录");
  assert.equal(computeBillingFailure({ errMsg: "cloud.callFunction:fail Error: 算力不足，请先充值" }), "算力不足，请先充值");
  assert.equal(computeBillingFailure(Object.assign(new Error("该模型计费暂未配置"), { code: "PRICE_NOT_CONFIGURED" })), "该模型计费暂未配置");
});
