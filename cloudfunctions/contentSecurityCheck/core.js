// 纯逻辑，不依赖 wx-server-sdk，方便单测；实际调用微信接口的部分在 index.js。
const MAX_LENGTH = 2500;
// 场景枚举值取自官方文档：1 资料 2 评论 3 论坛 4 社交日志。
// 分享给指定亲友看的个人记忆，最贴近"社交日志"。
const DEFAULT_SCENE = 4;
const VALID_SCENES = new Set([1, 2, 3, 4]);

function normalizeCheckInput(event) {
  const content = String((event && event.content) || "").trim();
  const rawTitle = String((event && event.title) || "").trim();
  const requestedScene = Number(event && event.scene);
  return {
    content: Array.from(content).slice(0, MAX_LENGTH).join(""),
    title: rawTitle ? Array.from(rawTitle).slice(0, 100).join("") : undefined,
    scene: VALID_SCENES.has(requestedScene) ? requestedScene : DEFAULT_SCENE,
  };
}

/** openid 必须是近两小时内访问过小程序的那个用户；这是 v2 接口的硬性要求。 */
function buildCheckRequest({ content, title, scene = DEFAULT_SCENE }, openid) {
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");
  return {
    content,
    version: 2,
    scene,
    openid,
    ...(title ? { title } : {}),
  };
}

/** Only an explicit pass is shareable. Review, risky and malformed replies all fail closed. */
function interpretCheckResponse(response) {
  const result = response && response.result;
  const suggest = result && result.suggest;
  return {
    ok: suggest === "pass",
    suggest: suggest || "review",
    label: result && result.label,
  };
}

// 调用失败（网络、配额用尽、openid 不新鲜等）一律按未通过处理：
// 宁可暂时不让内容分享出去，也不能因为查不到结果就当成"通过"。
function failClosed(error) {
  return {
    ok: false,
    suggest: "review",
    error: String((error && error.errMsg) || (error && error.message) || error || "CHECK_UNAVAILABLE"),
  };
}

module.exports = {
  MAX_LENGTH,
  DEFAULT_SCENE,
  normalizeCheckInput,
  buildCheckRequest,
  interpretCheckResponse,
  failClosed,
};
