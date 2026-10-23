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
// 契约 1.6.0：网页登录确认。subject 只由 context 的 APPID/OPENID 计算，
// event 里传入的 subject、userId 等一概忽略；只取 code 和 decision。
const WEB_LOGIN_DECISIONS = ["preview", "confirm", "deny"];
function webLoginBody(event, context, options = {}) {
  const openid = String(context && context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");
  const appid = String(context && context.APPID || options.appIdFallback || "").trim();
  if (!appid) throw new Error("APPID_NOT_AVAILABLE");
  const code = String(event && event.code || "").trim().toUpperCase().replace(/[\s-]/g, "");
  const decision = String(event && event.decision || "");
  if (!/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(code) || !WEB_LOGIN_DECISIONS.includes(decision)) throw new Error("invalid_input");
  return { subject: subjectFor(appid, openid), code, decision };
}
function webLoginResultShapeError(contentType, data) {
  if (!/^application\/json\b/i.test(String(contentType || ""))) return "bridge_unavailable";
  if (!data || typeof data !== "object" || Array.isArray(data)) return "bridge_unavailable";
  if (data.outcome === "preview") {
    if (typeof data.clientHint !== "string" || data.clientHint.length > 40 || !["login", "bind"].includes(data.mode)) return "bridge_unavailable";
    return null;
  }
  return ["confirmed", "denied", "merge_required"].includes(data.outcome) ? null : "bridge_unavailable";
}
module.exports = { webLoginBody, webLoginResultShapeError, bridgeUrl, canonicalJson, issueDesktopResultShapeError, requestBody, signature, subjectFor };
