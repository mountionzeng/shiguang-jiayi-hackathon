const { QUALITY_ISSUE_KEYS, cleanText } = require("./core");
const { createVisionClient } = require("./vision");

const QUALITY_PROMPT = [
  "你是图片质检员，请检查这张 AI 生成的插画。",
  "右下角的「AI生成」或旧版「图片由AI生成」是保留的 AI 标识，不算问题。",
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
function createQualityChecker({ apiKey, model, baseUrl, fetchImpl, timeoutMs = 12_000 }) {
  const vision = createVisionClient({ apiKey, model, baseUrl, fetchImpl });
  async function check(imageUrl) {
    const answer = await vision.ask({ text: QUALITY_PROMPT, images: [imageUrl], timeoutMs });
    if (!answer.ok) return unchecked(answer.errorCode);
    return parseQualityJson(answer.content) || unchecked("VISION_UNREADABLE");
  }
  return { configured: vision.configured, check };
}

module.exports = { QUALITY_PROMPT, createQualityChecker, parseQualityJson };
