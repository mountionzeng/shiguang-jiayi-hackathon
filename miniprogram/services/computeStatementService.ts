const KINDS = ["reserve", "settle", "release"] as const;
const STATUSES = ["reserved", "processing", "reconciliation", "settled", "released", "exception"] as const;
type LedgerKind = typeof KINDS[number];
type LedgerStatus = typeof STATUSES[number];
const KIND_LABEL: Record<LedgerKind, string> = { reserve: "预占", settle: "结算", release: "释放" };
const STATUS_LABEL: Record<LedgerStatus, string> = {
  reserved: "预占中",
  processing: "处理中",
  reconciliation: "待对账",
  settled: "已结算",
  released: "已释放",
  exception: "异常待核",
};
const TYPE_LABEL: Record<string, string> = {
  "shiguang.chatInterview": "采访追问",
  "shiguang.organizeMemory": "整理记忆",
  "shiguang.generateBiography": "生成正文",
  "shiguang.storyImages": "配图",
  "shiguang.storyAudio": "声音",
  other: "AI 生成",
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
  nextCursor: string | null;
  hint: string;
}

function formatMicros(micros: number): string {
  const negative = micros < 0;
  const absolute = Math.abs(micros);
  const integer = Math.trunc(absolute / 1_000_000);
  const fraction = String(absolute % 1_000_000).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${integer}.${fraction} 算力`;
}
/** Beijing time. occurredAt is UTC and is not shown as a raw timestamp. */
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
  if (!row || typeof row.occurredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.occurredAt)
    || typeof row.kind !== "string" || !KINDS.includes(row.kind as LedgerKind)
    || typeof row.type !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(row.type)
    || typeof row.status !== "string" || !STATUSES.includes(row.status as LedgerStatus)
    || !Number.isSafeInteger(row.amountMicros)) throw new Error("算力流水暂不可用");
  const kind = row.kind as LedgerKind;
  if (kind === "settle" ? Number(row.amountMicros) > 0 : Number(row.amountMicros) < 0) throw new Error("算力流水暂不可用");
  const status = row.status as LedgerStatus;
  return {
    id: `${row.occurredAt}-${index}-${kind}`,
    label: TYPE_LABEL[row.type] || "AI 生成",
    time: formatBeijingTime(row.occurredAt),
    status: STATUS_LABEL[status],
    detail: `${KIND_LABEL[kind]} ${formatMicros(Number(row.amountMicros))}`,
  };
}
export function parseLedgerView(value: unknown): LedgerView {
  const data = value as { available?: unknown; version?: unknown; unit?: unknown; items?: unknown; nextCursor?: unknown };
  if (!data || data.available === false) return { available: false, rows: [], hasMore: false, nextCursor: null, hint: "账户流水暂未开通" };
  const nextCursor = data.nextCursor === null ? null : data.nextCursor;
  if (data.version !== 1 || data.unit !== "compute" || !Array.isArray(data.items) || data.items.length > 50
    || (nextCursor !== null && (typeof nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(nextCursor)))) {
    throw new Error("算力流水暂不可用");
  }
  const rows = data.items.map(item);
  return {
    available: true,
    rows,
    hasMore: nextCursor !== null,
    nextCursor,
    hint: rows.length ? "账户流水（北京时间）。预占、结算和释放分开显示，不能相加当作余额" : "暂无算力流水",
  };
}
export async function loadComputeStatement(cursor?: string | null): Promise<LedgerView> {
  if (!wx.cloud) throw new Error("算力流水暂不可用");
  const data: { action: "computeStatement"; limit: number; cursor?: string } = { action: "computeStatement", limit: 20 };
  if (typeof cursor === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(cursor)) data.cursor = cursor;
  const response = await wx.cloud.callFunction({ name: "getOpenId", data });
  return parseLedgerView(response.result);
}
