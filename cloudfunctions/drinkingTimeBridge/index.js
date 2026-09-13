const cloud = require("wx-server-sdk");
const https = require("node:https");
const crypto = require("node:crypto");
const { accountIdFor, bridgeUrl, signature, subjectFor } = require("./core");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const paths = { status: "/status", requestOtp: "/link/email/otp/request", link: "/link/email", list: "/stories", read: "/stories/read" };
function post(baseUrl, path, body, secret) {
  const timestamp = String(Date.now()), nonce = crypto.randomBytes(18).toString("base64url");
  // Keep the configured /api/shiguang prefix. URL(path, base) would silently
  // drop it because every signed endpoint path starts with a slash.
  const url = bridgeUrl(baseUrl, path);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: "POST", timeout: 12_000, headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(payload),
      "x-shiguang-timestamp": timestamp, "x-shiguang-nonce": nonce,
      "x-shiguang-signature": signature(secret, path, timestamp, nonce, body),
    } }, response => {
      const chunks = []; let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) response.destroy(new Error("bridge_response_too_large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        let data = {}; try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        if ((response.statusCode || 500) >= 200 && (response.statusCode || 500) < 300) resolve(data);
        else reject(new Error(data.error || "bridge_unavailable"));
      });
    });
    request.on("timeout", () => request.destroy(new Error("bridge_timeout")));
    request.on("error", reject); request.end(payload);
  });
}
async function main(event = {}) {
  const context = cloud.getWXContext(), openid = String(context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");
  const baseUrl = String(process.env.DRINKING_TIME_BRIDGE_BASE_URL || "").trim();
  const secret = String(process.env.DRINKING_TIME_BRIDGE_SECRET || "");
  if (!/^https:\/\//.test(baseUrl) || secret.length < 32) throw new Error("bridge_not_configured");
  const action = String(event.action || ""), path = paths[action];
  if (!path) throw new Error("UNKNOWN_BRIDGE_ACTION");
  const body = { subject: subjectFor(String(context.APPID || "wx6be512f0fe129b62"), openid) };
  if (action === "requestOtp" || action === "link") body.email = String(event.email || "").trim().toLowerCase();
  if (action === "link") body.otp = String(event.otp || "");
  if (action === "read") body.storyId = Number(event.storyId);
  const result = await post(baseUrl, path, body, secret);
  if (action === "link" && result.linked) {
    // This is only a UI annotation. The signed Drinking Time status endpoint is
    // authoritative, so an old/missing account document must not turn a
    // successful identity link into a false failure shown to the user.
    try {
      await cloud.database().collection("user_accounts").doc(accountIdFor(openid)).update({ data: {
        drinkingTimeLinked: true, drinkingTimeEmail: body.email, drinkingTimeLinkedAt: cloud.database().serverDate(), updatedAt: cloud.database().serverDate(),
      } });
    } catch (error) {
      console.warn("Drinking Time 关联状态暂未写回拾光账号", error);
    }
  }
  return result;
}
module.exports = { main };
