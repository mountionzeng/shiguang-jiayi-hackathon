const { QUALITY_ISSUE_KEYS, cleanText } = require("./core");

// The old hunyuan-vision entry closed on 2026-06-22; vision models now live on TokenHub.
const DEFAULT_BASE_URL = "https://tokenhub.tencentmaas.com/v1";
const DEFAULT_MODEL = "hy-vision-2.0-instruct";

const QUALITY_PROMPT = [
  "你是图片质检员，请检查这张 AI 生成的插画。",
  "右下角的「图片由AI生成」是规定必须保留的标识，不算问题。",
  "除此之外，检查画面里有没有：能读出来的文字、像文字的乱码笔画、水印、商标或 logo、签名或印章。",
  "只输出一个 JSON 对象，前四个字段必须是 true 或 false：",
  '{"readableText": 布尔, "pseudoText": 布尔, "watermarkOrLogo": 布尔, "signature": 布尔, "note": "一句话说明"}',
].join("\n");

function unchecked(qualityError) {
  return { quality: "unchecked", qualityIssues: [], qualityNote: "", qualityError };
}

/** A missing or non-boolean answer is not a pass; the picture stays unchecked. */
function parseQualityJson(content) {
  const raw = String(content || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || QUALITY_ISSUE_KEYS.some(key => typeof parsed[key] !== "boolean")) return undefined;
  const qualityIssues = QUALITY_ISSUE_KEYS.filter(key => parsed[key] === true);
  return {
    quality: qualityIssues.length ? "flawed" : "pass",
    qualityIssues,
    qualityNote: cleanText(parsed.note, 60),
    qualityError: "",
  };
}

/** Never throws: a check that cannot finish leaves the picture unchecked, never blocked. */
function createQualityChecker({ apiKey, model, baseUrl, fetchImpl = fetch, timeoutMs = 12_000 }) {
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const configured = Boolean(apiKey);
  async function check(imageUrl) {
    if (!configured) return unchecked("VISION_NOT_CONFIGURED");
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
              { type: "text", text: QUALITY_PROMPT },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          }],
        }),
      });
      if (!response.ok) return unchecked(`VISION_HTTP_${response.status}`);
      const payload = await response.json();
      const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
        ? payload.choices[0].message.content
        : "";
      return parseQualityJson(content) || unchecked("VISION_UNREADABLE");
    } catch (error) {
      return unchecked(error && error.name === "AbortError" ? "VISION_TIMEOUT" : "VISION_REQUEST_FAILED");
    } finally {
      clearTimeout(timer);
    }
  }
  return { configured, check };
}

module.exports = { QUALITY_PROMPT, createQualityChecker, parseQualityJson };
