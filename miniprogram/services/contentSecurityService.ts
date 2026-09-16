export interface ContentCheckResult {
  ok: boolean;
  suggest?: string;
}

/**
 * 微信要求：一段文字如果会被另一个微信账号看到，存下来之前必须先过内容安全检测。
 * 检测服务暂时不可用、或者当前没有接上微信云（本机演示模式）时，一律按未通过处理——
 * 宁可暂时不让分享生效，也不能让没检测过的内容被别人看到。
 */
export async function checkTextContent(text: string, title?: string): Promise<ContentCheckResult> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, suggest: "pass" };
  if (!wx.cloud) return { ok: false, suggest: "review" };
  try {
    const response = await wx.cloud.callFunction({
      name: "contentSecurityCheck",
      data: { content: trimmed, title },
    });
    const result = response.result as ContentCheckResult | undefined;
    return { ok: Boolean(result && result.ok), suggest: result?.suggest };
  } catch (error) {
    console.warn("内容安全检测调用失败，按未通过处理", error);
    return { ok: false, suggest: "review" };
  }
}
