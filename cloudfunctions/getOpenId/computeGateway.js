const crypto = require("node:crypto");
const https = require("node:https");

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
}
function subjectFor(context) {
  if (!/^wx[0-9A-Za-z_-]{1,80}$/.test(context?.APPID || "") ||
      !/^[0-9A-Za-z_-]{1,128}$/.test(context?.OPENID || "")) throw new Error("AUTH_REQUIRED");
  return "shiguang:" + crypto.createHash("sha256").update(context.APPID + ":" + context.OPENID).digest("hex");
}
function postCompute(context, action, fields = {}, env = process.env) {
  if (!["balance", "reserve", "settle"].includes(action)) throw new Error("INVALID_COMPUTE_ACTION");
  const secret = env.DRINKING_TIME_BRIDGE_SECRET || "";
  const base = env.DRINKING_TIME_BRIDGE_BASE_URL || "";
  if (secret.length < 32 || !base.startsWith("https://")) throw new Error("COMPUTE_NOT_CONFIGURED");
  const path = "/compute/" + action;
  const url = new URL(base.replace(/\/+$/, "") + path);
  if (url.username || url.password || url.search || url.hash) throw new Error("COMPUTE_NOT_CONFIGURED");
  const body = { ...fields, subject: subjectFor(context) };
  const timestamp = String(Date.now()), nonce = crypto.randomBytes(18).toString("base64url");
  const signature = crypto.createHmac("sha256", secret)
    .update("POST\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + canonicalJson(body)).digest("hex");
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: "POST", timeout: 4000, headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(payload),
      "x-shiguang-timestamp": timestamp, "x-shiguang-nonce": nonce, "x-shiguang-signature": signature,
    } }, response => {
      const chunks = []; let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 16384) response.destroy(new Error("COMPUTE_RESPONSE_TOO_LARGE"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("COMPUTE_UNAVAILABLE")));
      response.on("end", () => {
        try {
          if (response.statusCode !== 200 || !/^application\/json\b/.test(response.headers["content-type"] || ""))
            throw new Error("COMPUTE_UNAVAILABLE");
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("COMPUTE_TIMEOUT")));
    request.on("error", reject);
    // getOpenId's cloud deadline is 10s. Bound DNS/connect/body time as well as
    // socket inactivity so an optional wallet sync cannot exhaust that deadline.
    const deadline = setTimeout(() => request.destroy(new Error("COMPUTE_TIMEOUT")), 4500);
    request.on("close", () => clearTimeout(deadline));
    request.end(payload);
  });
}
async function loadComputeBalance(context, post = postCompute) {
  const result = await post(context, "balance");
  if (result?.version !== 1 || result.unit !== "compute" ||
      !["availableMicros", "reservedMicros", "spentMicros"].every(key =>
        Number.isSafeInteger(result[key]) && result[key] >= 0)) throw new Error("INVALID_COMPUTE_BALANCE");
  return result;
}
module.exports = { canonicalJson, subjectFor, postCompute, loadComputeBalance };
