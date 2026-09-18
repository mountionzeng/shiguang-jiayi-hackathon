const crypto = require("node:crypto");

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
function subjectFor(appid, openid) {
  return `shiguang:${crypto.createHash("sha256").update(`${appid}:${openid}`).digest("hex")}`;
}
function signature(secret, path, timestamp, nonce, body) {
  return crypto.createHmac("sha256", secret)
    .update(`POST\n${path}\n${timestamp}\n${nonce}\n${canonicalJson(body)}`).digest("hex");
}
function bridgeUrl(baseUrl, path) {
  if (!/^\/[0-9A-Za-z/_-]+$/.test(path)) throw new Error("invalid_bridge_path");
  return new URL(`${String(baseUrl).replace(/\/+$/, "")}${path}`);
}
function requestBody(action, event, context, options = {}) {
  const openid = String(context && context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");
  const appid = String(context && context.APPID || options.appIdFallback || "").trim();
  if (!appid) throw new Error("APPID_NOT_AVAILABLE");
  const story=event?.story,storyAccess=event?.storyAccess;
  if (action !== "issueDesktop" || Boolean(story)===Boolean(storyAccess) ||
    (story && (typeof story!=="object"||Array.isArray(story))) || (storyAccess&&(typeof storyAccess!=="object"||Array.isArray(storyAccess)))) {
    throw new Error("invalid_input");
  }
  return {
    subject: subjectFor(appid, openid),
    ...(story?{story}:{storyAccess}),
  };
}
// 接口约定 1.1.0 第 3.5 节：接收方必须校验两种互斥的成功响应形状，不满足就当作
// bridge_unavailable，不得显示为成功（漏挂载点时服务端会返回 200 + 网页 HTML）。
function issueDesktopResultShapeError(contentType, data) {
  if (!/^application\/json\b/i.test(String(contentType || ""))) return "bridge_unavailable";
  if (!data || typeof data !== "object" || Array.isArray(data)) return "bridge_unavailable";
  if (typeof data.code !== "string" || !/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(data.code)) return "bridge_unavailable";
  if (typeof data.expiresAt !== "string" || !Number.isFinite(Date.parse(data.expiresAt))) return "bridge_unavailable";
  const snapshot=Number.isSafeInteger(data.storyId)&&data.storyId>0&&typeof data.imported==="boolean";
  const authority=Number.isSafeInteger(data.storyAccessId)&&data.storyAccessId>0&&data.bound===true;
  if(snapshot===authority)return "bridge_unavailable";
  return null;
}
module.exports = { bridgeUrl, canonicalJson, issueDesktopResultShapeError, requestBody, signature, subjectFor };
