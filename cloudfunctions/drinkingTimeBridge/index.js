const { recordDeliveryActivity } = require('./activity');
const cloud = require("wx-server-sdk");
const https = require("node:https");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { bridgeUrl, chapterDeliveryActionForPath, chapterDeliveryPathForAction, chapterDeliveryBody, chapterDeliveryResultShapeError,
  issueDesktopResultShapeError, signature, webLoginBody, webLoginResultShapeError } = require("./core");
const { prepareDesktopBody } = require("./egress");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db=cloud.database();
function reader(target){
  return {async get(table,id){
    try{return (await target.collection(table).doc(id).get()).data;}
    catch(error){if(/does not exist|not found|cannot find document/i.test(String(error?.message||error?.errMsg||error)))return undefined;throw error;}
  },async set(table,id,value){await target.collection(table).doc(id).set({data:value});}};
}
const repo={transaction:fn=>db.runTransaction(tx=>fn(reader(tx)))};

const paths = { issueDesktop: "/desktop/pair/issue", confirmWebLogin: "/web-login/confirm" };
function post(baseUrl, path, body, secret, shapeError = issueDesktopResultShapeError, maxResponseBytes = 64 * 1024) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(18).toString("base64url");
  const url = bridgeUrl(baseUrl, path);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve(value);
    };
    const request = https.request(url, { method: "POST", timeout: 12_000, headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(payload),
      "x-shiguang-timestamp": timestamp, "x-shiguang-nonce": nonce,
      "x-shiguang-signature": signature(secret, path, timestamp, nonce, body),
    } }, response => {
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) { response.destroy(); finish(new Error("bridge_response_too_large")); }
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        if ((response.statusCode || 500) >= 200 && (response.statusCode || 500) < 300) {
          const badShape = shapeError(response.headers["content-type"], data);
          badShape ? finish(new Error(badShape)) : finish(null, data);
        } else finish(new Error(data.error || "bridge_unavailable"));
      });
      response.on("error", error => finish(error));
      response.on("aborted", () => finish(new Error("bridge_response_aborted")));
    });
    request.on("timeout", () => request.destroy(new Error("bridge_timeout")));
    request.on("error", error => finish(error));
    request.end(payload);
  });
}

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function identityNamespace(context, secret) {
  if (!context?.APPID || !context?.OPENID || secret.length < 32) throw new Error("bridge_not_configured");
  return crypto.createHmac("sha256", secret).update(`${context.APPID}:${context.OPENID}`).digest("hex");
}
function filePath(fileID) { return String(fileID || "").replace(/^cloud:\/\/[^/]+\//, ""); }
function imageInfo(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return "";
}
function requestBuffer(url, options = {}) {
  return new Promise((resolve, reject) => {
    if (!(url instanceof URL) || url.protocol !== "https:" || url.username || url.password) return reject(new Error("invalid_media_url"));
    const request = https.request(url, { method: options.method || "GET", timeout: 12_000, headers: options.headers || {} }, response => {
      const status = response.statusCode || 500;
      if (status >= 300 && status < 400) { response.resume(); return reject(new Error("media_redirect_rejected")); }
      if (status < 200 || status >= 300) { response.resume(); return reject(new Error("media_request_failed")); }
      const chunks = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > (options.maxBytes || 2 * 1024 * 1024)) { response.destroy(); reject(new Error("media_too_large")); } else chunks.push(chunk); });
      response.on("end", () => resolve({ bytes: Buffer.concat(chunks), headers: response.headers }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("media_timeout")));
    request.on("error", reject);
    request.on("close", () => {});
    if (options.body) request.write(options.body);
    request.end();
  });
}
function validateManifest(pkg, assetMap) {
  const assets = Array.isArray(pkg?.assets) ? pkg.assets : [];
  const ids = assets.map(asset => asset.assetId);
  if (!/^cp_[A-Za-z0-9-]{8,64}$/.test(String(pkg?.packageId || "")) || ids.length > 12 ||
    ids.some(id => !/^asset-[a-f0-9]{32}$/.test(String(id || ""))) ||
    Object.keys(assetMap || {}).length !== ids.length || ids.some(id => !id || typeof assetMap[id] !== "string") ||
    Object.keys(assetMap || {}).some(id => !ids.includes(id))) throw new Error("asset_manifest_mismatch");
  return assets;
}
async function accountPhotoAllowed(openid, familyId, photoId, allowSource = false) {
  if (!/^family_[0-9A-Za-z_-]{1,120}$/.test(String(familyId || "")) || !/^photo-[0-9a-z-]{1,80}$/.test(String(photoId || ""))) return false;
  const photo = await db.collection("photos").doc(`${familyId}__${photoId}`).get().then(result => result.data).catch(() => null);
  return Boolean(photo && photo._openid === openid && photo.familyId === familyId && !photo.deletedAt &&
    (allowSource || (!photo.sourcePolicyRequired && photo.sourceIds === undefined)) && photo.moderation?.suggest !== "risky");
}
async function stageChapterAssets(event, context, secret) {
  if (!(["send", "return"].includes(event.purpose))) throw new Error("invalid_input");
  const pkg = event.package;
  const assetPhotos = event.assetPhotos || {};
  const assets = validateManifest(pkg, assetPhotos);
  const openid = String(context.OPENID || "");
  const account = await db.collection("user_accounts").doc(`account_${hash(openid).slice(0, 24)}`).get().then(result => result.data).catch(() => null);
  const familyId = account?.primaryFamilyId;
  if (!familyId) throw new Error("family_not_found");
  for (const asset of assets) if (!await accountPhotoAllowed(openid, familyId, assetPhotos[asset.assetId], event.purpose === "return")) throw new Error("photo_access_denied");
  const namespace = identityNamespace(context, secret);
  return { uploads: Object.fromEntries(assets.map(asset => [asset.assetId,
    `chapter-delivery-staging/${namespace}/${pkg.packageId}/${asset.assetId}/${crypto.randomUUID()}.bin`])) };
}
async function uploadOutgoingAssets(event, context, baseUrl, secret, result) {
  const pkg = event.package;
  const fileIDs = event.assetFileIDs || {};
  const assetPhotos = event.assetPhotos || {};
  const assets = validateManifest(pkg, fileIDs);
  const photoAssets = validateManifest(pkg, assetPhotos);
  const namespace = identityNamespace(context, secret);
  const account = await db.collection("user_accounts").doc(`account_${hash(context.OPENID).slice(0, 24)}`).get().then(row => row.data).catch(() => null);
  if (!account?.primaryFamilyId) throw new Error("family_not_found");
  const allowSource = event.action === "returnChapter";
  for (const asset of assets) if (!await accountPhotoAllowed(context.OPENID, account.primaryFamilyId, assetPhotos[asset.assetId], allowSource)) throw new Error("photo_access_denied");
  const root = `chapter-delivery-staging/${namespace}/${pkg.packageId}/`;
  const tickets = result.uploadTickets || [];
  if (tickets.length > assets.length || new Set(tickets.map(ticket => ticket.assetId)).size !== tickets.length ||
    tickets.some(ticket => !assets.some(asset => asset.assetId === ticket.assetId))) throw new Error("upload_ticket_mismatch");
  const origin = new URL(baseUrl).origin;
  for (const ticket of tickets) {
    const asset = assets.find(item => item.assetId === ticket.assetId);
    if (!asset || filePath(fileIDs[ticket.assetId]).indexOf(root + asset.assetId + "/") !== 0) throw new Error("asset_source_forbidden");
    const downloaded = await cloud.downloadFile({ fileID: fileIDs[ticket.assetId] });
    const bytes = Buffer.from(downloaded.fileContent || []);
    if (bytes.length !== asset.bytes || imageInfo(bytes) !== asset.mime || hash(bytes) !== asset.sha256) throw new Error("asset_mismatch");
    const target = new URL(ticket.path, origin);
    if (target.origin !== origin || target.pathname !== ticket.path || !/^\/api\/chapter-delivery\/media\/[^/]+\/[^/]+$/.test(target.pathname) ||
      Date.parse(ticket.expiresAt) <= Date.now() || Date.parse(ticket.expiresAt) > Date.now() + 15 * 60 * 1000) throw new Error("upload_ticket_invalid");
    const uploaded = await requestBuffer(target, { method: "PUT", body: bytes, maxBytes: 16 * 1024, headers: {
      origin, authorization: `Bearer ${ticket.token}`, "content-type": asset.mime, "content-length": String(bytes.length),
    } });
    let response; try { response = JSON.parse(uploaded.bytes.toString("utf8")); } catch {}
    if (!response?.ok) throw new Error("asset_upload_failed");
  }
}
async function cacheDeliveryAssets(event, context, baseUrl, secret) {
  const pkg = event.package;
  const assets = Array.isArray(pkg?.assets) ? pkg.assets : [];
  const imageUrls = event.imageUrls || {};
  const deliveryId = String(event.deliveryId || "");
  if (!/^[0-9a-f-]{36}$/i.test(deliveryId) || Object.keys(imageUrls).length !== assets.length ||
    assets.some(asset => typeof imageUrls[asset.assetId] !== "string") ||
    Object.keys(imageUrls).some(id => !assets.some(asset => asset.assetId === id))) throw new Error("asset_manifest_mismatch");
  const origin = new URL(baseUrl).origin, namespace = identityNamespace(context, secret), fileIDs = {};
  for (const asset of assets) {
    const source = new URL(imageUrls[asset.assetId], origin);
    if (source.origin !== origin || !source.pathname.startsWith(`/api/chapter-delivery/media/download/${deliveryId}/`) || source.pathname.includes("..")) throw new Error("media_source_forbidden");
    const downloaded = await requestBuffer(source, { maxBytes: 2 * 1024 * 1024 });
    const bytes = downloaded.bytes;
    if (bytes.length !== asset.bytes || imageInfo(bytes) !== asset.mime || hash(bytes) !== asset.sha256) throw new Error("asset_mismatch");
    const uploaded = await cloud.uploadFile({ cloudPath: `chapter-delivery-inbox/${namespace}/${deliveryId}/${asset.assetId}-${crypto.randomUUID()}.${asset.mime.slice(6)}`, fileContent: bytes });
    if (!uploaded.fileID) throw new Error("inbox_asset_store_failed");
    fileIDs[asset.assetId] = uploaded.fileID;
  }
  // Files created by a cloud function are not owned by the receiving client.
  // Mint bounded read URLs here after verifying the delivery capabilities.
  const temporary = assets.length ? await cloud.getTempFileURL({ fileList: Object.values(fileIDs) }) : { fileList: [] };
  const assetUrls = {};
  for (const asset of assets) {
    const entry = temporary.fileList.find(item => item.fileID === fileIDs[asset.assetId]);
    if (!entry?.tempFileURL || !entry.tempFileURL.startsWith("https://")) throw new Error("inbox_asset_url_unavailable");
    assetUrls[asset.assetId] = entry.tempFileURL;
  }
  return { assetFileIDs: fileIDs, assetUrls };
}

async function main(event = {}) {
  const action = String(event.action || "");
  if (action === "chapterDeliveryEnabled") return { enabled: process.env.CHAPTER_PACKAGE_ENABLED === "true" && process.env.CHAPTER_DELIVERY_ENABLED === "true" };
  const deliveryAction = Boolean(chapterDeliveryPathForAction(action));
  if (action === "stageChapterAssets" || deliveryAction) {
    if (process.env.CHAPTER_PACKAGE_ENABLED !== "true") throw new Error("chapter_package_disabled");
    if (process.env.CHAPTER_DELIVERY_ENABLED !== "true") throw new Error("chapter_delivery_disabled");
  }
  if (action === "cacheChapterDeliveryAssets") {
    if (process.env.CHAPTER_PACKAGE_ENABLED !== "true") throw new Error("chapter_package_disabled");
    if (process.env.CHAPTER_DELIVERY_ENABLED !== "true") throw new Error("chapter_delivery_disabled");
  }
  // 关闭态先返回，不依赖尚未配置的桥接服务，也不读取微信身份。
  if (process.env.WEB_LOGIN_CONFIRM_ENABLED !== "true") {
    if (action === "webLoginEnabled") return { enabled: false };
    if (action === "confirmWebLogin") throw new Error("web_login_disabled");
  }
  const baseUrl = String(process.env.DRINKING_TIME_BRIDGE_BASE_URL || "").trim();
  const secret = String(process.env.DRINKING_TIME_BRIDGE_SECRET || "");
  if (!/^https:\/\//.test(baseUrl) || secret.length < 32) throw new Error("bridge_not_configured");
  // 只告诉小程序入口要不要显示，不碰网络、不泄露任何配置值。
  if (action === "webLoginEnabled") return { enabled: true };
  const path = paths[action];
  if (!path && !deliveryAction && !["stageChapterAssets", "cacheChapterDeliveryAssets"].includes(action))
    throw new Error("UNKNOWN_BRIDGE_ACTION");
  const context = cloud.getWXContext();
  if (action === "stageChapterAssets") return stageChapterAssets(event, context, secret);
  if (action === "cacheChapterDeliveryAssets") return cacheDeliveryAssets(event, context, baseUrl, secret);
  if (deliveryAction) {
    const { path, body } = chapterDeliveryBody(action, event, context, { appIdFallback: process.env.WECHAT_APP_ID });
    const result = await post(baseUrl, path, body, secret,
      (contentType, data) => chapterDeliveryResultShapeError(contentType, data, action), 256 * 1024);
    if (["sendChapter", "createChapterClaimLink", "returnChapter"].includes(action)) {
      await uploadOutgoingAssets(event, context, baseUrl, secret, result);
      await recordDeliveryActivity(db,context,result,"sent",event.package);
      if (action === "createChapterClaimLink" && result.claimUrl) {
        const origin = new URL(baseUrl).origin;
        const claim = new URL(result.claimUrl, origin);
        if (claim.origin !== origin || !/^\/chapter\/claim\/[A-Za-z0-9_-]{43}$/.test(claim.pathname)) throw new Error("claim_url_invalid");
        result.claimUrl = claim.toString();
      }
      return result;
    }
    if (action === "readChapterPackage") await recordDeliveryActivity(db,context,result,"received");
    return result;
  }
  if (action === "confirmWebLogin") {
    const loginBody = webLoginBody(event, context, { appIdFallback: process.env.WECHAT_APP_ID });
    return post(baseUrl, path, loginBody, secret, webLoginResultShapeError);
  }
  const body = await prepareDesktopBody(repo, event, context, {
    bootstrapAppId: process.env.STORY_IDENTITY_BOOTSTRAP_APP_ID || process.env.WECHAT_APP_ID,
    authorityEnabled:process.env.STORY_DESKTOP_AUTHORITY_ENABLED==='true',
  });
  return post(baseUrl, path, body, secret);
}
module.exports = { main };
