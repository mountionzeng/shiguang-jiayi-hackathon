/** Shared transport for story read/share/export APIs. Domain validation stays with callers. */
export function createStoryCaller(unavailable: string, failure: string) {
  return async function call<T>(action: string, data: object = {}): Promise<T> {
    if (!wx.cloud) throw new Error(unavailable);
    const response = await wx.cloud.callFunction({ name: 'storyBooks', data: { ...data, action } });
    const result = response.result as { error?: string; code?: string; message?: string } | undefined;
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.error) {
      throw Object.assign(new Error(result?.message || failure), { code: result?.code });
    }
    return result as T;
  };
}
