const crypto = require("node:crypto");

const DAILY_LIMIT = 10;
const BOOK_LIMIT = 30;
/** Statuses that may have cost money. Failed and blocked jobs are free on Hunyuan. */
const COUNTED_STATUSES = ["submitted", "running", "storing", "stored", "unknown", "expired"];
const ACTIVE_STATUSES = ["submitted", "running", "storing"];
const PURPOSES = ["illustration", "backdrop", "cover"];
/** Stage 1 only draws chapter illustrations; backdrops and covers come later. */
const ENABLED_PURPOSES = ["illustration"];
const MAX_CHAPTER_TEXT = 4000;
const SUBMIT_STALE_MS = 3 * 60 * 1000;
const STORING_STALE_MS = 3 * 60 * 1000;

const DRAWING = "正在画，大约 20–60 秒。可以先离开，回来接着看";
const MESSAGES = {
  submitted: DRAWING,
  running: DRAWING,
  storing: DRAWING,
  stored: "画好了",
  failed: "没画成，没有扣费，可以再试一次",
  blocked: "这段内容没通过平台审核，换一段试试",
  unknown: "不确定有没有画成，可能已经扣费",
  expired: "画好了但没来得及保存",
};

class StoryImageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sanitizeDocumentPart(value) {
  return String(value).replace(/[^0-9A-Za-z_-]/g, "_");
}

function familyIdFor(openid) {
  return `family_${sanitizeDocumentPart(openid)}`;
}

/** Only the room owner can read books today, so only the owner may spend on pictures. */
function requireOwner(openid, familyId) {
  if (!openid) throw new StoryImageError("OPENID_NOT_AVAILABLE", "没有拿到微信身份，请重新进入小程序");
  if (!familyId || familyIdFor(openid) !== familyId) {
    throw new StoryImageError("NOT_FAMILY_OWNER", "只有记忆之家的主人可以生成配图");
  }
}

const ID_PATTERN = /^[0-9A-Za-z_-]{1,80}$/;
const REQUEST_ID_PATTERN = /^req-[0-9a-z-]{8,60}$/;

function normalizeSubmitInput(event) {
  const input = event || {};
  const familyId = String(input.familyId || "").trim();
  const memberId = String(input.memberId || "").trim();
  const chapterId = String(input.chapterId || "").trim();
  const requestId = String(input.requestId || "").trim();
  const purpose = String(input.purpose || "illustration");
  if (!ID_PATTERN.test(memberId)) throw new StoryImageError("INVALID_MEMBER", "档案信息不完整");
  if (!ID_PATTERN.test(chapterId)) throw new StoryImageError("INVALID_CHAPTER", "章节信息不完整");
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new StoryImageError("INVALID_REQUEST", "请求编号无效，请重试");
  if (!PURPOSES.includes(purpose)) throw new StoryImageError("INVALID_PURPOSE", "不支持这种配图");
  if (!ENABLED_PURPOSES.includes(purpose)) throw new StoryImageError("PURPOSE_NOT_YET", "这种配图还没开放");
  return { familyId, memberId, chapterId, requestId, purpose };
}

function normalizeMemberInput(event) {
  const memberId = String((event && event.memberId) || "").trim();
  if (!ID_PATTERN.test(memberId)) throw new StoryImageError("INVALID_MEMBER", "档案信息不完整");
  return memberId;
}

/** Same order as the client's manuscriptHistory: newest savedAt, then id. */
function latestDraftForMember(records, memberId) {
  const list = Array.isArray(records) ? records : [];
  const revisions = list
    .filter(record => record && record.draftType === "manuscript-revision" && record.revision &&
      record.revision.memberId === memberId && record.revision.draft)
    .map(record => record.revision)
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)) || String(b.id).localeCompare(String(a.id)));
  if (revisions.length) return revisions[0].draft;
  const personal = list.find(record => record && record.draftType === "personal" && record.memberId === memberId && record.draft);
  return personal ? personal.draft : undefined;
}

/** The chapter's own words from the saved book. Photos are local references and never read. */
function chapterSource(draft, chapterId) {
  const chapters = draft && Array.isArray(draft.chapters) ? draft.chapters : [];
  const chapter = chapters.find(item => item && item.id === chapterId);
  if (!chapter) throw new StoryImageError("CHAPTER_NOT_FOUND", "没找到这一章，请先保存书稿再配图");
  const text = (Array.isArray(chapter.content) ? chapter.content : [])
    .map(item => (item && typeof item.text === "string" ? item.text : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) throw new StoryImageError("CHAPTER_EMPTY", "这一章还没有文字，先写几句再配图");
  return {
    title: String(chapter.title || "").trim().slice(0, 40),
    text: text.slice(0, MAX_CHAPTER_TEXT),
    textLength: text.length,
  };
}

function textHash(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 32);
}

/** Daily limits reset at midnight Beijing time. */
function chinaDayKey(ms) {
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function quotaDecision({ todayCount, bookCount }) {
  if (todayCount >= DAILY_LIMIT) {
    return { allowed: false, code: "DAILY_LIMIT", message: `今天的 ${DAILY_LIMIT} 张画完了，明天再来` };
  }
  if (bookCount >= BOOK_LIMIT) {
    return { allowed: false, code: "BOOK_LIMIT", message: `这个故事已经有 ${BOOK_LIMIT} 张图了，删掉的不会返还名额` };
  }
  return { allowed: true };
}

// Built from char codes so the source file itself stays free of invisible characters.
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g",
);
const TRAILING_PUNCTUATION = /[。．.!！;；,，、]+$/;

function cleanText(value, maxLength) {
  return String(typeof value === "string" ? value : "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(TRAILING_PUNCTUATION, "")
    .slice(0, maxLength);
}

function cleanList(value, maxItems, maxLength) {
  return (Array.isArray(value) ? value : [])
    .map(item => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseSceneJson(content) {
  const raw = String(content || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const unreadable = new StoryImageError("SCENE_PARSE_FAILED", "没读懂这一章的画面，可以再试一次");
  if (start < 0 || end <= start) throw unreadable;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw unreadable;
  }
  const scene = {
    scene: cleanText(parsed.scene, 120),
    objects: cleanList(parsed.objects, 6, 20),
    light: cleanText(parsed.light, 40),
    mood: cleanText(parsed.mood, 12),
    eraHint: cleanText(parsed.eraHint, 20),
    figures: cleanList(parsed.figures, 3, 30),
  };
  if (!scene.scene) throw unreadable;
  return scene;
}

const STYLES = {
  illustration: {
    lead: "纸本淡彩水彩插画，暖白色宣纸底，笔触轻柔，留白充足，画面安静。",
    width: 1024,
    height: 768,
  },
};

/** Affirmative wording only: image models have no notion of "don't draw". */
function buildImagePrompt(scene, purpose) {
  const style = STYLES[purpose];
  if (!style) throw new StoryImageError("PURPOSE_NOT_YET", "这种配图还没开放");
  const parts = [style.lead, `画面：${scene.scene}。`];
  if (scene.objects.length) parts.push(`画中有${scene.objects.join("、")}。`);
  if (scene.light) parts.push(`时节与光线：${scene.light}。`);
  if (scene.figures.length) parts.push(`人物以远景或局部呈现：${scene.figures.join("、")}。`);
  if (scene.mood) parts.push(`整体氛围${scene.mood}。`);
  if (scene.eraHint) parts.push(`时代感：${scene.eraHint}。`);
  return { prompt: parts.join(""), width: style.width, height: style.height };
}

/**
 * A provider that answered with an error did not start a paid job. A dropped
 * connection might have, so it is reported as uncertain and never retried.
 */
function classifySubmitError(error) {
  const providerCode = error && error.providerCode;
  if (providerCode) {
    return { status: /^OperationDenied/.test(providerCode) ? "blocked" : "failed", errorCode: providerCode };
  }
  const httpStatus = error && error.httpStatus;
  if (httpStatus && httpStatus < 500) return { status: "failed", errorCode: `HTTP_${httpStatus}` };
  return { status: "unknown", errorCode: error && error.name === "AbortError" ? "SUBMIT_TIMEOUT" : "SUBMIT_UNCERTAIN" };
}

function sweepAction(job, nowMs) {
  const age = nowMs - Number(job.updatedAtMs || job.createdAtMs || 0);
  if (job.status === "submitted") return !job.providerJobId && age > SUBMIT_STALE_MS ? "mark-unknown" : "skip";
  if (job.status === "storing") return age > STORING_STALE_MS ? "release" : "skip";
  if (job.status === "running") return "poll";
  return "skip";
}

function publicJob(job) {
  return {
    jobId: job._id,
    status: job.status,
    message: MESSAGES[job.status] || "",
    chapterId: job.chapterId,
    purpose: job.purpose,
    imageId: job.imageId || "",
    createdAtMs: job.createdAtMs,
  };
}

function publicImage(image, url) {
  return {
    imageId: image._id,
    chapterId: image.chapterId || "",
    purpose: image.purpose,
    url: url || "",
    bytes: Number(image.bytes || 0),
    moderation: image.moderation,
    aiGenerated: true,
    createdAtMs: image.createdAtMs,
  };
}

const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

function extensionFor(contentType) {
  return EXTENSIONS[String(contentType || "").toLowerCase()] || "png";
}

module.exports = {
  ACTIVE_STATUSES,
  BOOK_LIMIT,
  COUNTED_STATUSES,
  DAILY_LIMIT,
  ENABLED_PURPOSES,
  MESSAGES,
  StoryImageError,
  buildImagePrompt,
  chapterSource,
  chinaDayKey,
  classifySubmitError,
  extensionFor,
  familyIdFor,
  latestDraftForMember,
  normalizeMemberInput,
  normalizeSubmitInput,
  parseSceneJson,
  publicImage,
  publicJob,
  quotaDecision,
  requireOwner,
  sweepAction,
  textHash,
};
