export interface ShiguangAccount {
  accountId: string;
  primaryFamilyId: string;
  displayName: string;
  avatarText: string;
  profileComplete: boolean;
  computeBalanceMicros: number;
  computeRate: string;
}

interface AccountResponse {
  accountLinked?: unknown;
  account?: Partial<ShiguangAccount>;
}

function parseAccount(result: unknown): ShiguangAccount {
  const response = (result ?? {}) as AccountResponse;
  const account = response.account ?? {};
  const parsed: ShiguangAccount = {
    accountId: String(account.accountId ?? ""),
    primaryFamilyId: String(account.primaryFamilyId ?? ""),
    displayName: String(account.displayName ?? "").trim(),
    avatarText: String(account.avatarText ?? "").trim(),
    profileComplete: Boolean(account.profileComplete),
    computeBalanceMicros: Number.isSafeInteger(account.computeBalanceMicros)
      ? Math.max(0, Number(account.computeBalanceMicros))
      : 0,
    computeRate: "¥1 = 2 算力",
  };
  if (!response.accountLinked || !parsed.accountId || !parsed.primaryFamilyId) {
    throw new Error("微信账号暂未关联，请稍后重试");
  }
  return parsed;
}

export function formatComputeBalance(computeMicros: number): string {
  const safe = Number.isSafeInteger(computeMicros) ? Math.max(0, computeMicros) : 0;
  return `${(Math.floor(safe / 10_000) / 100).toFixed(2)} 算力`;
}

async function callAccount(action: "get" | "updateProfile", displayName = ""): Promise<ShiguangAccount> {
  if (!wx.cloud) throw new Error("当前微信版本暂不支持账号关联");
  const response = await wx.cloud.callFunction({
    name: "getOpenId",
    data: action === "updateProfile" ? { action, displayName } : { action },
  });
  return parseAccount(response.result);
}

export function loadCurrentAccount(): Promise<ShiguangAccount> {
  return callAccount("get");
}

export function saveCurrentAccountName(displayName: string): Promise<ShiguangAccount> {
  return callAccount("updateProfile", displayName);
}

export const accountServiceTest = { parseAccount };
