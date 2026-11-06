const COMPUTE_UNITS_PER_YUAN = 2;
const STATUSES = ["posted", "reserved", "processing", "reconciliation", "released", "exception"] as const;
type LedgerStatus = typeof STATUSES[number];
const STATUS_LABEL: Record<LedgerStatus, string> = {
  posted: "已入账",
  reserved: "预占中",
  processing: "处理中",
  reconciliation: "待对账",
  released: "已释放",
  exception: "异常待核",
};

export interface LedgerRow {
  id: string;
  label: string;
  time: string;
  detail: string;
  status: string;
}
export interface LedgerView {
  available: boolean;
  rows: LedgerRow[];
  hasMore: boolean;
  hint: string;
}

function minor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function formatMinor(value: number): string {
  const negative = value < 0;
  const micros = Math.abs(value) * COMPUTE_UNITS_PER_YUAN;
  const integer = Math.trunc(micros / 1_000_000);
  const fraction = String(micros % 1_000_000).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${integer}.${fraction} 算力`;
}
/** Beijing time, not the device zone and not the raw UTC string. */
export function formatBeijingTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error("算力流水暂不可用");
  const shifted = new Date(ms + 8 * 3600_000);
  const hour = String(shifted.getUTCHours()).padStart(2, "0");
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${shifted.getUTCMonth() + 1}/${shifted.getUTCDate()} ${hour}:${minute} 北京时间`;
}
function item(value: unknown, index: number): LedgerRow {
  const row = value as Record<string, unknown>;
  if (!row || typeof row.createdAt !== "string" || typeof row.label !== "string" || row.label.length < 1 || row.label.length > 80
    || !minor(row.amountMinor) || !minor(row.reservedMinor) || !minor(row.releasedMinor)
    || typeof row.status !== "string" || !STATUSES.includes(row.status as LedgerStatus) || typeof row.estimated !== "boolean") {
    throw new Error("算力流水暂不可用");
  }
  const status = row.status as LedgerStatus;
  const amount = row.amountMinor !== 0 ? formatMinor(row.amountMinor)
    : row.reservedMinor !== 0 ? `预占 ${formatMinor(row.reservedMinor)}`
    : row.releasedMinor !== 0 ? `释放 ${formatMinor(row.releasedMinor)}`
    : formatMinor(0);
  return {
    id: `${row.createdAt}-${index}-${status}`,
    label: row.label,
    time: formatBeijingTime(row.createdAt),
    status: STATUS_LABEL[status],
    detail: `${STATUS_LABEL[status]} ${amount}${row.estimated ? "（账本估算）" : ""}`,
  };
}
export function parseLedgerView(value: unknown): LedgerView {
  const data = value as { available?: unknown; version?: unknown; currency?: unknown; attentionItems?: unknown; historyItems?: unknown; historyHasMore?: unknown; attentionHasMore?: unknown };
  if (!data || data.available === false) return { available: false, rows: [], hasMore: false, hint: "账户流水暂未开通" };
  if (data.version !== 1 || data.currency !== "CNY" || !Array.isArray(data.attentionItems) || !Array.isArray(data.historyItems)
    || data.attentionItems.length > 20 || data.historyItems.length > 20 || typeof data.historyHasMore !== "boolean" || typeof data.attentionHasMore !== "boolean") {
    throw new Error("算力流水暂不可用");
  }
  const rows = [...data.attentionItems, ...data.historyItems].map(item);
  return {
    available: true,
    rows,
    hasMore: data.historyHasMore || data.attentionHasMore,
    hint: rows.length ? "账户流水（北京时间），与下方文字用量预估分开" : "暂无算力流水",
  };
}
export async function loadComputeStatement(offset = 0): Promise<LedgerView> {
  if (!wx.cloud) throw new Error("算力流水暂不可用");
  const historyOffset = Number.isSafeInteger(offset) && offset >= 0 && offset <= 500 ? offset : 0;
  const response = await wx.cloud.callFunction({
    name: "getOpenId",
    data: { action: "computeStatement", limit: 20, historyOffset, attentionOffset: 0 },
  });
  return parseLedgerView(response.result);
}
