const { defaultFetch } = require("./httpFetch");

const TOKENHUB_BASE_URL = "https://tokenhub.tencentmaas.com";
const IMAGE_PATH = "/v1/wand/hunyuan-image/v3-generation";
const IMAGE_MODEL = "hy-image-v3";
/** Keep a compact, explicit AI label; the provider controls its typography. */
const AI_FOOTNOTE = "AI生成";
/**
 * TokenHub commonly returns in 20-60 seconds. The deployed WeChat function has
 * a 60-second deadline, so stop the provider call with enough time to record a
 * returned link before a later invocation handles slower storage work.
 */
const IMAGE_GENERATE_TIMEOUT_MS = 52_000;
/** TokenHub allows each side in [512, 2048] and at most 1024×1024 pixels in total. */
const MAX_IMAGE_AREA = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function imageContentType(buffer) {
  if (buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("RESULT_IMAGE_TYPE_UNSUPPORTED");
}

function httpError(status, message) {
  const error = new Error(message);
  error.httpStatus = status;
  return error;
}

/**
 * Hy-Image-3.0 on TokenHub answers synchronously with a temporary picture link.
 * Errors carry httpStatus when TokenHub answered, so callers can tell a refusal
 * from a dropped connection that may already have cost money.
 */
function createTokenHubImageClient({ apiKey, baseUrl, fetchImpl = defaultFetch, timeoutMs = IMAGE_GENERATE_TIMEOUT_MS }) {
  const root = String(baseUrl || TOKENHUB_BASE_URL).replace(/\/$/, "");
  return {
    configured: Boolean(apiKey),
    async generate({ prompt, width, height, seed }) {
      if (width < 512 || height < 512 || width > 2048 || height > 2048 || width * height > MAX_IMAGE_AREA) {
        throw httpError(400, "IMAGE_SIZE_OUT_OF_RANGE");
      }
      if (seed !== undefined && (!Number.isInteger(seed) || seed < 1 || seed > 4294967295)) {
        throw httpError(400, "IMAGE_SEED_OUT_OF_RANGE");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(root + IMAGE_PATH, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: IMAGE_MODEL,
            prompt,
            size: `${width}x${height}`,
            ...(seed !== undefined ? { seed } : {}),
            // Rewriting adds time and may add things the chapter never said.
            revise: false,
            footnote: AI_FOOTNOTE,
          }),
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw httpError(response.status, `TOKENHUB_HTTP_${response.status}`);
      const payload = await response.json();
      const item = payload && Array.isArray(payload.data) ? payload.data[0] : undefined;
      // A success status without a picture may still have been billed; it is not an explicit refusal.
      if (!item || typeof item.url !== "string" || !/^https:\/\//.test(item.url)) throw new Error("TOKENHUB_NO_IMAGE");
      return {
        resultUrl: item.url,
        revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : "",
        providerJobId: String((payload && payload.id) || ""),
        usageTokens: Number((payload && payload.tokenhub_usage && payload.tokenhub_usage.total_tokens) || 0),
      };
    },
  };
}

/** Result links are temporary; a refused download means the picture is gone. */
async function downloadResult(url, { fetchImpl = defaultFetch, timeoutMs = 15_000, maxBytes = 10 * 1024 * 1024 } = {}) {
  if (!/^https:\/\//.test(String(url))) {
    const error = new Error("RESULT_URL_INVALID");
    error.expired = true;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "image/png,image/jpeg" } });
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
  return { buffer, contentType: imageContentType(buffer) };
}

module.exports = {
  AI_FOOTNOTE,
  IMAGE_GENERATE_TIMEOUT_MS,
  IMAGE_MODEL,
  IMAGE_PATH,
  MAX_IMAGE_AREA,
  TOKENHUB_BASE_URL,
  createTokenHubImageClient,
  downloadResult,
};
