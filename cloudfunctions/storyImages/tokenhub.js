const { defaultFetch } = require("./httpFetch");

const TOKENHUB_BASE_URL = "https://tokenhub.tencentmaas.com";
/**
 * Hy-Image-3.5-preview is synchronous. TokenHub finishes its internal SSE
 * stream and returns one JSON frame; callers do not poll or read an event
 * stream. Guide (updated 2026-10-12):
 * https://cloud.tencent.com/document/product/1823/135745
 * Rollback is a config change: set both TOKENHUB_IMAGE_MODEL and
 * TOKENHUB_IMAGE_PATH back to the Hy-Image-3.0 values. The request body
 * follows the model id.
 */
const DEFAULT_IMAGE_PATH = "/v1/wand/hunyuan-image/v35-generation";
const DEFAULT_IMAGE_MODEL = "hy-image-v3.5-preview";
const LEGACY_IMAGE_MODEL = "hy-image-v3";
/** Keep a compact, explicit AI label; the provider controls its typography. */
const AI_FOOTNOTE = "AI生成";
/**
 * TokenHub commonly returns in 20-60 seconds. The deployed WeChat function has
 * a 60-second deadline, so stop the provider call with enough time to record a
 * returned link before a later invocation handles slower storage work.
 */
const IMAGE_GENERATE_TIMEOUT_MS = 52_000;
/**
 * Story images stay inside the Hy-Image-3.0 frame: each side in [512, 2048]
 * and at most 1024×1024 pixels. Hy-Image-3.5-preview accepts up to 4096×4096,
 * but these sizes already satisfy it and match the flat per-image price.
 */
const MAX_IMAGE_AREA = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function configuredText(env, key, fallback) {
  const value = env && env[key];
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function resolveImageTarget(env = process.env) {
  const model = configuredText(env, "TOKENHUB_IMAGE_MODEL", DEFAULT_IMAGE_MODEL);
  const rawPath = configuredText(env, "TOKENHUB_IMAGE_PATH", DEFAULT_IMAGE_PATH);
  return { model, path: rawPath.startsWith("/") ? rawPath : `/${rawPath}` };
}

const { model: IMAGE_MODEL, path: IMAGE_PATH } = resolveImageTarget();

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
 * Hy-Image-3.5-preview answers synchronously with one JSON frame. A non-2xx
 * response carries httpStatus so callers can tell a refusal from a dropped
 * connection that may already have cost money. A 2xx body without an https
 * picture is TOKENHUB_NO_IMAGE: the guide says to judge success by the URL,
 * and that body may still have been billed.
 */
function cleanReferenceImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images) || images.length > 3) throw httpError(400, "IMAGE_REFERENCES_OUT_OF_RANGE");
  const urls = images.map(url => String(url || "").trim()).filter(Boolean);
  if (urls.length !== images.length || !urls.every(url => /^https:\/\//.test(url))) throw httpError(400, "IMAGE_REFERENCE_INVALID");
  return urls;
}

function httpsUrl(value) {
  return typeof value === "string" && /^https:\/\//.test(value) ? value : "";
}

/**
 * Prefer choices[0].delta.image.url. Fall back to the Hy-Image-3.0 data[0].url
 * field so a rolled-back response, or a gateway that still emits it, still parses.
 * v3.5 has no revised_prompt; only the legacy field is copied through.
 */
function parseImagePayload(payload) {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  const delta = choice && choice.delta && typeof choice.delta === "object" ? choice.delta : undefined;
  const nextUrl = httpsUrl(delta && delta.image && delta.image.url);
  const legacy = payload && Array.isArray(payload.data) ? payload.data[0] : undefined;
  const legacyUrl = httpsUrl(legacy && legacy.url);
  const gatewayTokens = payload && payload.tokenhub_usage && payload.tokenhub_usage.total_tokens;
  const vendorTokens = payload && payload.usage && payload.usage.total_tokens;
  return {
    resultUrl: nextUrl || legacyUrl,
    revisedPrompt: legacy && typeof legacy.revised_prompt === "string" ? legacy.revised_prompt : "",
    providerJobId: String((payload && (payload.id || payload.request_id)) || ""),
    usageTokens: Number(gatewayTokens || vendorTokens || 0),
  };
}

/**
 * v3.5 has no revise switch and no top-level prompt/images fields. size, seed
 * and footnote still apply. Reference URLs move into the user message as
 * image_url parts. The legacy model keeps prompt, images and revise:false.
 */
function buildImageRequest({ model, prompt, width, height, seed, images }) {
  const size = `${width}x${height}`;
  if (model === LEGACY_IMAGE_MODEL) {
    return {
      model,
      prompt,
      size,
      ...(images.length ? { images } : {}),
      ...(seed !== undefined ? { seed } : {}),
      revise: false,
      footnote: AI_FOOTNOTE,
    };
  }
  const content = [{ type: "text", text: prompt }];
  for (const url of images) content.push({ type: "image_url", image_url: { url } });
  return {
    model,
    messages: [{ role: "user", content }],
    size,
    ...(seed !== undefined ? { seed } : {}),
    footnote: AI_FOOTNOTE,
  };
}

function createTokenHubImageClient({ apiKey, baseUrl, fetchImpl = defaultFetch, timeoutMs = IMAGE_GENERATE_TIMEOUT_MS, env } = {}) {
  const root = String(baseUrl || TOKENHUB_BASE_URL).replace(/\/$/, "");
  const target = resolveImageTarget(env || process.env);
  return {
    configured: Boolean(apiKey),
    model: target.model,
    path: target.path,
    async generate({ prompt, width, height, seed, referenceImages }) {
      if (width < 512 || height < 512 || width > 2048 || height > 2048 || width * height > MAX_IMAGE_AREA) {
        throw httpError(400, "IMAGE_SIZE_OUT_OF_RANGE");
      }
      if (seed !== undefined && (!Number.isInteger(seed) || seed < 1 || seed > 4294967295)) {
        throw httpError(400, "IMAGE_SEED_OUT_OF_RANGE");
      }
      const images = cleanReferenceImages(referenceImages);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await require("./computeBilling").instrumentFetch(fetchImpl)(root + target.path, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify(buildImageRequest({ model: target.model, prompt, width, height, seed, images })),
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw httpError(response.status, `TOKENHUB_HTTP_${response.status}`);
      const parsed = parseImagePayload(await response.json());
      if (!parsed.resultUrl) throw new Error("TOKENHUB_NO_IMAGE");
      return parsed;
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
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_PATH,
  IMAGE_GENERATE_TIMEOUT_MS,
  IMAGE_MODEL,
  IMAGE_PATH,
  LEGACY_IMAGE_MODEL,
  MAX_IMAGE_AREA,
  TOKENHUB_BASE_URL,
  createTokenHubImageClient,
  downloadResult,
};
