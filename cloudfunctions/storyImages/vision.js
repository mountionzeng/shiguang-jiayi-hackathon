const { defaultFetch } = require("./httpFetch");

// The old hunyuan-vision entry closed on 2026-06-22; vision models now live on TokenHub.
const DEFAULT_BASE_URL = "https://tokenhub.tencentmaas.com/v1";
const DEFAULT_MODEL = "hy-vision-2.0-instruct";

/**
 * One request to a TokenHub vision model: a text instruction plus images given as
 * links or data: URLs. Never throws; a request that cannot finish comes back as
 * { ok: false, errorCode } so callers decide what "not checked" means for them.
 */
function createVisionClient({ apiKey, model, baseUrl, fetchImpl = defaultFetch }) {
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const configured = Boolean(apiKey);

  async function ask({ text, images, timeoutMs = 12_000 }) {
    if (!configured) return { ok: false, errorCode: "VISION_NOT_CONFIGURED" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${root}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          temperature: 0,
          messages: [{
            role: "user",
            content: [
              { type: "text", text },
              ...(Array.isArray(images) ? images : []).map(url => ({ type: "image_url", image_url: { url } })),
            ],
          }],
        }),
      });
      if (!response.ok) return { ok: false, errorCode: `VISION_HTTP_${response.status}`, httpStatus: response.status };
      const payload = await response.json();
      const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
        ? payload.choices[0].message.content
        : "";
      return { ok: true, content: String(content || "") };
    } catch (error) {
      return { ok: false, errorCode: error && error.name === "AbortError" ? "VISION_TIMEOUT" : "VISION_REQUEST_FAILED" };
    } finally {
      clearTimeout(timer);
    }
  }

  return { configured, ask };
}

module.exports = { DEFAULT_BASE_URL, DEFAULT_MODEL, createVisionClient };
