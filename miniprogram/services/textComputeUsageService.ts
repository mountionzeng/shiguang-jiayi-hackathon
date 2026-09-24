const LABELS = { chatInterview: "采访追问", organizeMemory: "整理记忆", generateBiography: "生成正文" };
export interface TextComputeRow { id: string; label: string; detail: string; time: string }
export interface TextComputeView { enabled: boolean; rows: TextComputeRow[] }
function micros(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
export function formatTextCompute(microCompute: number): string {
  if (!micros(microCompute)) throw new Error("算力用量暂不可用");
  const integer = Math.trunc(microCompute / 1_000_000);
  const fraction = String(microCompute % 1_000_000).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${integer}.${fraction} 算力`;
}
export function parseTextComputeView(value: unknown): TextComputeView {
  const data = value as { version?: unknown; unit?: unknown; enabled?: unknown; operations?: unknown };
  if (data?.version !== 1 || data.unit !== "compute" || typeof data.enabled !== "boolean" ||
      !Array.isArray(data.operations) || data.operations.length > 10 || (!data.enabled && data.operations.length))
    throw new Error("算力用量暂不可用");
  const ids = new Set<string>();
  const rows = data.operations.map((item: unknown): TextComputeRow => {
    const r = item as Record<string, unknown>;
    if (!r || typeof r.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(r.id) || ids.has(r.id) ||
        !Object.prototype.hasOwnProperty.call(LABELS, String(r.kind)) ||
        !micros(r.startedAt) || r.startedAt > 8_640_000_000_000_000 ||
        !Number.isInteger(r.attempts) || Number(r.attempts) < 1 || Number(r.attempts) > 2 ||
        !Number.isInteger(r.unknownAttempts) || Number(r.unknownAttempts) < 0 || Number(r.unknownAttempts) > Number(r.attempts) ||
        !micros(r.knownMicros)) throw new Error("算力用量暂不可用");
    const pending = r.status === "pending_reconciliation";
    if (pending ? (r.estimatedMicros !== null || Number(r.unknownAttempts) === 0)
      : (r.status !== "tariff_estimate" || r.unknownAttempts !== 0 || !micros(r.estimatedMicros) || r.estimatedMicros !== r.knownMicros))
      throw new Error("算力用量暂不可用");
    ids.add(r.id);
    const date = new Date(r.startedAt);
    return { id: r.id, label: LABELS[r.kind as keyof typeof LABELS],
      time: `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
      detail: pending
        ? (r.knownMicros > 0 ? `已知部分预估 ${formatTextCompute(r.knownMicros)}，其余待核对` : "用量待核对")
        : `预估 ${formatTextCompute(r.estimatedMicros as number)}`,
    };
  });
  return { enabled: data.enabled, rows };
}
export async function loadTextComputeUsage(): Promise<TextComputeView> {
  if (!wx.cloud) throw new Error("算力用量暂不可用");
  const response = await wx.cloud.callFunction({ name: "getOpenId", data: { action: "textComputeUsage" } });
  return parseTextComputeView(response.result);
}
