const crypto = require("node:crypto");

const HOST = "aiart.tencentcloudapi.com";
const SERVICE = "aiart";
const VERSION = "2022-12-29";
const CONTENT_TYPE = "application/json; charset=utf-8";

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function utcDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

/** Tencent Cloud API signature v3 (TC3-HMAC-SHA256), POST with a JSON body. */
function canonicalRequest({ host, action, payload, contentType = CONTENT_TYPE }) {
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  return {
    text: ["POST", "/", "", canonicalHeaders, signedHeaders, sha256Hex(payload)].join("\n"),
    signedHeaders,
  };
}

function stringToSign({ timestamp, service, canonical }) {
  const scope = `${utcDate(timestamp)}/${service}/tc3_request`;
  return {
    text: ["TC3-HMAC-SHA256", String(timestamp), scope, sha256Hex(canonical)].join("\n"),
    scope,
  };
}

function signRequest({ secretId, secretKey, host = HOST, service = SERVICE, action, version = VERSION, region, timestamp, payload }) {
  const canonical = canonicalRequest({ host, action, payload });
  const toSign = stringToSign({ timestamp, service, canonical: canonical.text });
  const secretDate = hmac(`TC3${secretKey}`, utcDate(timestamp));
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = crypto.createHmac("sha256", secretSigning).update(toSign.text, "utf8").digest("hex");
  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${toSign.scope}, SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`,
    "Content-Type": CONTENT_TYPE,
    Host: host,
    "X-TC-Action": action,
    "X-TC-Timestamp": String(timestamp),
    "X-TC-Version": version,
    "X-TC-Region": region,
  };
}

function firstString(value) {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}

/** QueryTextToImageJob: 1 waiting, 2 running, 4 failed, 5 done. */
function mapQueryResponse(response) {
  const code = String((response && response.JobStatusCode) || "");
  if (code === "5") {
    const imageUrl = firstString(response.ResultImage);
    if (!imageUrl) return { state: "failed", errorCode: "EMPTY_RESULT" };
    return { state: "done", imageUrl, revisedPrompt: firstString(response.RevisedPrompt) };
  }
  if (code === "4") {
    const errorCode = String(response.JobErrorCode || "JOB_FAILED");
    return { state: /^OperationDenied/.test(errorCode) ? "blocked" : "failed", errorCode };
  }
  return { state: "running" };
}

function createHunyuanClient({ secretId, secretKey, region = "ap-guangzhou", fetchImpl = fetch, now = () => Date.now(), timeoutMs = 10_000 }) {
  async function call(action, body) {
    const payload = JSON.stringify(body);
    const headers = signRequest({ secretId, secretKey, action, region, timestamp: Math.floor(now() / 1000), payload });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`https://${HOST}`, { method: "POST", headers, body: payload, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const error = new Error(`HUNYUAN_HTTP_${response.status}`);
      error.httpStatus = response.status;
      throw error;
    }
    const json = await response.json();
    const result = json && json.Response;
    if (!result) throw new Error("HUNYUAN_MALFORMED_RESPONSE");
    if (result.Error) {
      const error = new Error(`${result.Error.Code}: ${result.Error.Message}`);
      error.providerCode = String(result.Error.Code);
      throw error;
    }
    return result;
  }

  return {
    async submit({ prompt, width, height }) {
      // Revise off: rewriting adds ~20s and may add things the chapter never said.
      // LogoAdd on: the visible "图片由AI生成" label is required by law.
      const result = await call("SubmitTextToImageJob", {
        Prompt: prompt,
        Resolution: `${width}:${height}`,
        Revise: 0,
        LogoAdd: 1,
      });
      if (!result.JobId) throw new Error("HUNYUAN_NO_JOB_ID");
      return { providerJobId: String(result.JobId) };
    },
    async query(providerJobId) {
      return mapQueryResponse(await call("QueryTextToImageJob", { JobId: providerJobId }));
    },
  };
}

/** Result links live for one hour; a refused download means the picture is gone. */
async function downloadResult(url, { fetchImpl = fetch, timeoutMs = 15_000, maxBytes = 10 * 1024 * 1024 } = {}) {
  if (!/^https:\/\//.test(String(url))) {
    const error = new Error("RESULT_URL_INVALID");
    error.expired = true;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if ([403, 404, 410].includes(response.status)) {
    const error = new Error(`RESULT_GONE_${response.status}`);
    error.expired = true;
    throw error;
  }
  if (!response.ok) throw new Error(`RESULT_HTTP_${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > maxBytes) throw new Error("RESULT_SIZE_INVALID");
  const contentType = String((response.headers && response.headers.get("content-type")) || "image/png").split(";")[0].trim();
  return { buffer, contentType };
}

module.exports = {
  HOST,
  SERVICE,
  VERSION,
  canonicalRequest,
  createHunyuanClient,
  downloadResult,
  mapQueryResponse,
  signRequest,
  stringToSign,
};
