import test from "node:test";
import assert from "node:assert/strict";
import { formatBeijingTime, parseLedgerView } from "../miniprogram/services/computeStatementService";
import { textComputeHint } from "../miniprogram/services/textComputeUsageService";
import { computeBillingFailure } from "../miniprogram/services/computeBillingPrompt";

test("ledger rows use Beijing time and stay separate from the text estimate", () => {
  assert.equal(formatBeijingTime("2026-01-01T16:30:00.000Z"), "1/2 00:30 北京时间");
  const view = parseLedgerView({
    version: 1, unit: "compute",
    items: [{ occurredAt: "2026-01-01T16:30:00.000Z", kind: "settle", type: "shiguang.chatInterview", status: "settled", amountMicros: -500000 }],
    nextCursor: "next_page",
  });
  assert.match(view.hint, /不能相加当作余额/);
  assert.equal(view.rows[0].time, "1/2 00:30 北京时间");
  assert.equal(view.rows[0].label, "采访追问");
  assert.equal(view.rows[0].detail, "结算 -0.50 算力");
  assert.equal(view.hasMore, true);
  assert.equal(view.nextCursor, "next_page");
  assert.doesNotMatch(`${view.rows[0].time} ${view.rows[0].detail} ${view.hint}`, /¥|人民币|2026-01-01T/);
  assert.equal(parseLedgerView({ available: false }).hint, "账户流水暂未开通");
  const hold = parseLedgerView({
    version: 1, unit: "compute",
    items: [{ occurredAt: "2026-01-01T16:30:00.000Z", kind: "reserve", type: "shiguang.storyImages", status: "reserved", amountMicros: 2000000 }],
    nextCursor: null,
  });
  assert.equal(hold.rows[0].detail, "预占 2.00 算力");
  assert.equal(hold.hasMore, false);
  assert.equal(textComputeHint({ enabled: true, rows: [{ id: "a", label: "采访追问", detail: "预估 0.01 算力", time: "1/2 00:30" }] }), "文字用量预估（非账户流水），按 2026-09-23 价格估算，不是扣费记录");
  assert.equal(computeBillingFailure({ errMsg: "cloud.callFunction:fail Error: 算力不足，请先充值" }), "算力不足，请先充值");
  assert.equal(computeBillingFailure(Object.assign(new Error("该模型计费暂未配置"), { code: "PRICE_NOT_CONFIGURED" })), "该模型计费暂未配置");
});
