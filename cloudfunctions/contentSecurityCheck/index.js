const cloud = require("wx-server-sdk");
const {
  normalizeCheckInput,
  buildCheckRequest,
  interpretCheckResponse,
  failClosed,
} = require("./core.js");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 文本内容安全检测：任何一段可能被另一个微信账号看到的文字，存下来 / 分享出去之前
 * 都要先过这一关（微信小程序内容安全规范要求）。
 *
 * 调用方（本项目内）：
 * - miniprogram/services/contentSecurityService.ts：客户端直接调用，检测「自己写、
 *   可能会分享给指定亲友」的个人记忆。
 * - cloudfunctions/familyInvite/index.js 的 submitContribution：亲友提交进主人待
 *   确认列表前调用（云函数之间调用会透传原始用户的 OPENID，不需要额外传递）。
 *
 * 没有内容、检测通过 → { ok: true }；检测认为有问题、或者接口调用失败（网络、配额、
 * openid 不是近两小时内活跃的用户等）→ { ok: false }，绝不把"查不到结果"当成"通过"。
 */
async function main(event) {
  const context = cloud.getWXContext();
  // 客户端直调时只信微信上下文里的 OPENID；云函数之间调用时，部分 DevTools/云端
  // 路径不会把原始用户 OPENID 带到被调函数，此时由上游云函数传入它刚从微信上下文
  // 取得的 openid，仍然由服务端发起最终内容安全检测。
  const openid = String(context.OPENID || event?.openid || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");

  const input = normalizeCheckInput(event);
  if (!input.content) return { ok: true, suggest: "pass" };

  try {
    const request = buildCheckRequest(input, openid);
    const response = await cloud.openapi.security.msgSecCheck(request);
    return interpretCheckResponse(response);
  } catch (error) {
    console.warn("文本内容安全检测调用失败，按未通过处理", error);
    return failClosed(error);
  }
}

module.exports = { main };
