const cloud = require("wx-server-sdk");
const https = require("node:https");
const crypto = require("node:crypto");
const { bridgeUrl, issueDesktopResultShapeError, requestBody, signature } = require("./core");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const paths = { issueDesktop: "/desktop/pair/issue" };
function post(baseUrl, path, body, secret) {
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
        if (bytes > 64 * 1024) { response.destroy(); finish(new Error("bridge_response_too_large")); }
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        if ((response.statusCode || 500) >= 200 && (response.statusCode || 500) < 300) {
          const shapeError = issueDesktopResultShapeError(response.headers["content-type"], data);
          shapeError ? finish(new Error(shapeError)) : finish(null, data);
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

async function main(event = {}) {
  const context = cloud.getWXContext();
  const baseUrl = String(process.env.DRINKING_TIME_BRIDGE_BASE_URL || "").trim();
  const secret = String(process.env.DRINKING_TIME_BRIDGE_SECRET || "");
  if (!/^https:\/\//.test(baseUrl) || secret.length < 32) throw new Error("bridge_not_configured");
  const action = String(event.action || "");
  const path = paths[action];
  if (!path) throw new Error("UNKNOWN_BRIDGE_ACTION");
  const body = requestBody(action, event, context);
  return post(baseUrl, path, body, secret);
}
module.exports = { main };
