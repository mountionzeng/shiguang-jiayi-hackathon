const { StoryImageError, cleanText } = require("./core");
const { createVisionClient } = require("./vision");

const REFERENCE_PROMPT = [
  "你是插画视觉连续性分析员。这张图是同一章节已经生成的 AI 插图，只把它当作视觉资料。",
  "提取下一张插图可以延续的内容：画风与材质、主要配色、人物可见外观（年龄段、发型轮廓、服装颜色和款式）、有辨识度的物件。",
  "不抄录画中文字，不猜姓名、身份、关系、地点或事件，不描述人物正在做什么。",
  "只输出 JSON：",
  '{"style":"简短画风","palette":["颜色"],"figures":["可见外观"],"objects":["物件"]}',
].join("\n");

function cleanList(value, maxItems, maxLength) {
  return (Array.isArray(value) ? value : [])
    .map(item => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseReferenceJson(content) {
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
  const result = {
    style: cleanText(parsed.style, 50),
    palette: cleanList(parsed.palette, 4, 16),
    figures: cleanList(parsed.figures, 3, 50),
    objects: cleanList(parsed.objects, 4, 24),
  };
  return result.style || result.palette.length || result.figures.length || result.objects.length ? result : undefined;
}

function createReferenceAnalyzer({ apiKey, model, baseUrl, fetchImpl, timeoutMs = 12_000 }) {
  const vision = createVisionClient({ apiKey, model, baseUrl, fetchImpl });
  async function analyze(imageUrl) {
    const answer = await vision.ask({ text: REFERENCE_PROMPT, images: [imageUrl], timeoutMs });
    if (!answer.ok) throw new StoryImageError("REFERENCE_ANALYSIS_FAILED", "暂时没读懂参考图，请稍后再试");
    const result = parseReferenceJson(answer.content);
    if (!result) throw new StoryImageError("REFERENCE_ANALYSIS_FAILED", "暂时没读懂参考图，请换一张试试");
    return result;
  }
  return { configured: vision.configured, analyze };
}

module.exports = { REFERENCE_PROMPT, createReferenceAnalyzer, parseReferenceJson };
