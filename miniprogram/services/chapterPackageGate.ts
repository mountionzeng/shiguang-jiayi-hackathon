export { CHAPTER_PACKAGE_ENABLED } from "../config/runtime";
/** 只在开发版显示的测试入口。 */
export function envIsDevelop(): boolean {
  try { return wx.getAccountInfoSync().miniProgram.envVersion === "develop"; } catch { return false; }
}
