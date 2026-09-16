/**
 * 页面加载失败时，界面只给一句友好提示；真实原因记在这里，
 * 开发者工具控制台和「小程序管理后台 → 运维中心 → 实时日志」都能看到。
 */
export function logLoadError(where: string, error: unknown): void {
  const detail = {
    where,
    errCode: (error as { errCode?: unknown } | undefined)?.errCode,
    errMsg: (error as { errMsg?: unknown } | undefined)?.errMsg,
    message: error instanceof Error ? error.message : String(error),
  };
  console.error(`[加载失败] ${where}`, detail, error);
  try {
    if (typeof wx !== "undefined" && typeof wx.getRealtimeLogManager === "function") {
      wx.getRealtimeLogManager().error(`[加载失败] ${where}`, detail);
    }
  } catch {
    // 日志本身出错不能再影响页面。
  }
}
