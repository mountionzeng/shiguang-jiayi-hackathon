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
function statementEnabled(env = process.env) {
  return env.SHIGUANG_COMPUTE_STATEMENT_ENABLED === "true";
}

/**
 * Read-only ledger. DT does not expose this route yet; the call stays behind
 * SHIGUANG_COMPUTE_STATEMENT_ENABLED and any failure becomes "not available".
 * Identity is the signed subject. Caller userId, subject and amounts are ignored.
 */
function getComputeStatement(context, query, env = process.env) {
  if (!statementEnabled(env)) return Promise.resolve({ version: 1, available: false, reason: "statement_not_enabled" });
  const secret = env.DRINKING_TIME_BRIDGE_SECRET || "";
  const base = env.DRINKING_TIME_BRIDGE_BASE_URL || "";
  if (secret.length < 32 || !base.startsWith("https://")) {
    return Promise.resolve({ version: 1, available: false, reason: "statement_not_configured" });
  }
  const path = "/compute/statement";
  let url;
  try { url = new URL(base.replace(/\/+$/, "") + path); }
  catch { return Promise.resolve({ version: 1, available: false, reason: "statement_not_configured" }); }
  if (url.username || url.password || url.search || url.hash) {
    return Promise.resolve({ version: 1, available: false, reason: "statement_not_configured" });
  }
  const body = { ...boundedStatementQuery(query), subject: subjectFor(context) };
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(18).toString("base64url");
  const signature = crypto.createHmac("sha256", secret)
    .update("GET\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + canonicalJson(body)).digest("hex");
  const payload = JSON.stringify(body);
  return new Promise(resolve => {
    let settled = false;
    const finish = result => { if (!settled) { settled = true; resolve(result); } };
    const request = https.request(url, { method: "GET", timeout: 4000, headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(payload),
      "x-shiguang-timestamp": timestamp, "x-shiguang-nonce": nonce, "x-shiguang-signature": signature,
    } }, response => {
      const chunks = []; let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 65536) response.destroy();
        else chunks.push(chunk);
      });
      response.on("error", () => finish({ version: 1, available: false, reason: "statement_unavailable" }));
      response.on("aborted", () => finish({ version: 1, available: false, reason: "statement_unavailable" }));
      response.on("end", () => {
        if (response.statusCode === 404) return finish({ version: 1, available: false, reason: "statement_unavailable" });
        try {
          if (response.statusCode !== 200 || !/^application\/json\b/.test(response.headers["content-type"] || ""))
            return finish({ version: 1, available: false, reason: "statement_unavailable" });
          finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch { finish({ version: 1, available: false, reason: "statement_unavailable" }); }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => finish({ version: 1, available: false, reason: "statement_unavailable" }));
    const deadline = setTimeout(() => { request.destroy(); finish({ version: 1, available: false, reason: "statement_unavailable" }); }, 4500);
    request.on("close", () => clearTimeout(deadline));
    request.end(payload);
  });
}

function boundedStatementQuery(query) {
  const source = query && typeof query === "object" ? query : {};
  const limit = integerIn(source.limit, 1, 20) || 20;
  const historyOffset = integerIn(source.historyOffset, 0, 500) || 0;
  const attentionOffset = integerIn(source.attentionOffset, 0, 500) || 0;
  return { attentionLimit: limit, attentionOffset, historyLimit: limit, historyOffset };
}

function integerIn(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

module.exports = {
  canonicalJson, subjectFor, postCompute, loadComputeBalance, getComputeStatement, statementEnabled,
};
