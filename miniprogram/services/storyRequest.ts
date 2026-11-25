import { loadCurrentAccount } from './accountService';

/** Shared transport for story read/share/export APIs. Domain validation stays with callers. */
export function createStoryCaller(unavailable: string, failure: string) {
  return async function call<T>(action: string, data: object = {}): Promise<T> {
    if (!wx.cloud) throw new Error(unavailable);
    const request = async () => {
      const response = await wx.cloud.callFunction({ name: 'storyBooks', data: { ...data, action } });
      return response.result as { error?: string; code?: string; message?: string } | undefined;
    };
    let result = await request();
    // A share link can be the first entry into the app, bypassing home login.
    // This code is returned before action dispatch, so retry cannot duplicate a write.
    // Use the existing WeChat account initializer; never link identities from a token.
    if (result?.error && result.code === 'IDENTITY_UNLINKED') {
      await loadCurrentAccount();
      result = await request();
    }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.error) {
      throw Object.assign(new Error(result?.message || failure), { code: result?.code });
    }
    return result as T;
  };
}
