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
function requestBody(action, event, context) {
  const openid = String(context && context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");
  if (action !== "issueDesktop" || !event || !event.story || typeof event.story !== "object" || Array.isArray(event.story)) {
    throw new Error("invalid_input");
  }
  return {
    subject: subjectFor(String(context.APPID || "wx6be512f0fe129b62"), openid),
    story: event.story,
  };
}
module.exports = { bridgeUrl, canonicalJson, requestBody, signature, subjectFor };
