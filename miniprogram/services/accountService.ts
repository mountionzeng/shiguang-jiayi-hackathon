export interface ShiguangAccount {
  accountId: string;
  primaryFamilyId: string;
  displayName: string;
  avatarText: string;
  profileComplete: boolean;
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
  };
  if (!response.accountLinked || !parsed.accountId || !parsed.primaryFamilyId) {
    throw new Error("微信账号暂未关联，请稍后重试");
  }
  return parsed;
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
