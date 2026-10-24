const crypto = require("node:crypto");

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(",")}]`;
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

const DELIVERY_ACTIONS = {
  listChapterContacts: { path: "/chapter-delivery/contacts", fields: [] },
  sendChapter: { path: "/chapter-delivery/send", fields: ["package", "recipientContactId", "requestId"] },
  createChapterClaimLink: { path: "/chapter-delivery/create-claim-link", fields: ["package", "requestId"] },
  claimChapterPackage: { path: "/chapter-delivery/claim", fields: ["token"] },
  listChapterInbox: { path: "/chapter-delivery/inbox", fields: [] },
  readChapterPackage: { path: "/chapter-delivery/read", fields: ["deliveryId"] },
  resolveChapterDelivery: { path: "/chapter-delivery/resolve", fields: ["deliveryId", "status"] },
  returnChapter: { path: "/chapter-delivery/return", fields: ["package", "requestId"] },
};
function chapterDeliveryBody(action, event, context, options = {}) {
  const contract = DELIVERY_ACTIONS[action];
  if (!contract || !event || typeof event !== "object" || Array.isArray(event)) throw new Error("invalid_input");
  const openid = String(context && context.OPENID || "").trim();
  const appid = String(context && context.APPID || options.appIdFallback || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");
  if (!appid) throw new Error("APPID_NOT_AVAILABLE");
  if (Object.keys(event).some(key => !["action", ...contract.fields, "assetFileIDs", "assetPhotos"].includes(key))) throw new Error("invalid_input");
  const body = { subject: subjectFor(appid, openid) };
  for (const key of contract.fields) {
    if (!(key in event)) throw new Error("invalid_input");
    body[key] = event[key];
  }
  if (action === "sendChapter") {
    if (typeof body.recipientContactId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.recipientContactId) || !validRequestId(body.requestId)) throw new Error("invalid_input");
  }
  if (["createChapterClaimLink", "returnChapter"].includes(action) && !validRequestId(body.requestId)) throw new Error("invalid_input");
  if (["readChapterPackage", "resolveChapterDelivery"].includes(action) && !/^[0-9a-f-]{36}$/i.test(String(body.deliveryId))) throw new Error("invalid_input");
  if (action === "claimChapterPackage" && !/^[A-Za-z0-9_-]{43}$/.test(String(body.token))) throw new Error("invalid_input");
  if (action === "resolveChapterDelivery" && !["kept", "appended", "adopted", "declined"].includes(body.status)) throw new Error("invalid_input");
  return { path: contract.path, body };
}
function validRequestId(value) { return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value); }
function chapterDeliveryResultShapeError(contentType, data, action) {
  if (!/^application\/json\b/i.test(String(contentType || "")) || !data || typeof data !== "object" || Array.isArray(data)) return "bridge_unavailable";
  const valid = {
    listChapterContacts: value => Array.isArray(value.contacts) && value.contacts.every(item => item && typeof item.contactId === "string" && typeof item.displayName === "string"),
    sendChapter: value => typeof value.deliveryId === "string" && Array.isArray(value.uploadTickets) && typeof value.repeated === "boolean",
    createChapterClaimLink: value => typeof value.deliveryId === "string" && (value.claimUrl === null || typeof value.claimUrl === "string") && Array.isArray(value.uploadTickets) && typeof value.repeated === "boolean",
    claimChapterPackage: value => typeof value.deliveryId === "string",
    listChapterInbox: value => Array.isArray(value.items),
    readChapterPackage: value => Boolean(value.delivery && ["send", "return"].includes(value.delivery.kind) && value.package &&
      value.imageUrls && typeof value.imageUrls === "object" && !Array.isArray(value.imageUrls)),
    resolveChapterDelivery: value => ["kept", "appended", "adopted", "declined"].includes(value.status),
    returnChapter: value => typeof value.deliveryId === "string" && Array.isArray(value.uploadTickets) && typeof value.repeated === "boolean",
  }[action];
  if (!valid || !valid(data)) return "bridge_unavailable";
  if (Array.isArray(data.uploadTickets) && data.uploadTickets.some(ticket => !ticket || typeof ticket.assetId !== "string" ||
    typeof ticket.path !== "string" || !ticket.path.startsWith("/api/chapter-delivery/media/") ||
    typeof ticket.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket.token) ||
    !["image/jpeg", "image/png", "image/webp"].includes(ticket.mime) || !Number.isSafeInteger(ticket.bytes) ||
    typeof ticket.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ticket.sha256) || !Number.isFinite(Date.parse(ticket.expiresAt)))) return "bridge_unavailable";
  return null;
}
function chapterDeliveryActionForPath(path) {
  return Object.keys(DELIVERY_ACTIONS).find(action => DELIVERY_ACTIONS[action].path === path);
}
function chapterDeliveryPathForAction(action) { return DELIVERY_ACTIONS[action]?.path; }
module.exports = { webLoginBody, webLoginResultShapeError, bridgeUrl, canonicalJson, chapterDeliveryActionForPath, chapterDeliveryBody,
  chapterDeliveryPathForAction, chapterDeliveryResultShapeError, issueDesktopResultShapeError, requestBody, signature, subjectFor };
