const crypto = require("node:crypto");

const DAILY_LIMIT = 10;
const BOOK_LIMIT = 30;
/**
 * submitted → queued → generating → generated → storing → stored.
 * Statuses that may have cost money count toward the limits; refusals do not.
 */
const COUNTED_STATUSES = ["submitted", "queued", "generating", "generated", "storing", "stored", "unknown", "expired"];
const ACTIVE_STATUSES = ["submitted", "queued", "generating", "generated", "storing"];
const PURPOSES = ["illustration", "backdrop", "cover"];
/** Chapter illustrations and backdrops are open; covers wait for stable story records. */
const ENABLED_PURPOSES = ["illustration", "backdrop"];
const QUALITY_ISSUE_KEYS = ["readableText", "pseudoText", "watermarkOrLogo", "signature"];
const QUALITY_ISSUE_LABELS = {
  readableText: "有文字",
  pseudoText: "有乱码字",
  watermarkOrLogo: "有水印或 logo",
  signature: "有签名或印章",
};
const MAX_CHAPTER_TEXT = 4000;
const MAX_CHARACTER_CONTEXT = 1200;
const MAX_CHARACTER_SENTENCES = 10;
const SUBMIT_STALE_MS = 3 * 60 * 1000;
const QUEUED_PICKUP_MS = 60 * 1000;
const GENERATING_STALE_MS = 3 * 60 * 1000;
const STORING_STALE_MS = 3 * 60 * 1000;

const DRAWING = "正在画，大约 20–60 秒。可以先离开，回来接着看";
const MESSAGES = {
  submitted: DRAWING,
  queued: DRAWING,
  generating: DRAWING,
  generated: DRAWING,
  storing: DRAWING,
  stored: "画好了",
  failed: "没画成，这次不占名额，可以再试一次",
  blocked: "这段内容没通过平台审核，换一段试试",
  unknown: "不确定有没有画成，可能已经扣费",
  expired: "画好了但没来得及保存",
};

const SCENE_FAILURE_MESSAGES = {
  SCENE_TIMEOUT: "读取章节超时，还没有开始画图，请稍后重试",
  SCENE_REQUEST_FAILED: "暂时无法读取章节画面，还没有开始画图，请稍后重试",
  SCENE_PARSE_FAILED: "没能提炼出这一章的画面，还没有开始画图，请稍后重试",
};

class StoryImageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/*
 * familyId 由 openid 推导。原先用 replace 把非法字符悄悄换成下划线，
 * 这意味着两个不同的 openid 可能被洗成同一个 familyId——两个用户共用一个房间，
 * 故事互相串门。微信 openid 实际就是 [0-9A-Za-z_-]{28}，永远不触发替换，
 * 所以这是一个没有守卫的假设，正是用户变多以后才会咬人的那种。
 * 改为校验：不合规就报错，把一次静默的房间合并换成一声响亮的失败。
 * 与 drinkingTimeBridge/egress.js 已有的做法保持一致。
 */
function assertOpenid(openid) {
  if (typeof openid !== "string" || !/^[0-9A-Za-z_-]{1,128}$/.test(openid)) throw new Error("INVALID_OPENID");
  return openid;
}

function familyIdFor(openid) {
  return `family_${assertOpenid(openid)}`;
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
const STORY_IMAGE_ID_PATTERN = /^family_[0-9A-Za-z_-]{1,120}_img_req-[0-9a-z-]{8,60}$/;

function normalizeSubmitInput(event) {
  const input = event || {};
  const familyId = String(input.familyId || "").trim();
  const memberId = String(input.memberId || "").trim();
  const storyId = String(input.storyId || "").trim();
  const chapterId = String(input.chapterId || "").trim();
  const requestId = String(input.requestId || "").trim();
  const purpose = String(input.purpose || "illustration");
  const referenceImageId = String(input.referenceImageId || "").trim();
  if (!ID_PATTERN.test(storyId) && !ID_PATTERN.test(memberId)) throw new StoryImageError("INVALID_STORY", "故事信息不完整");
  if (!ID_PATTERN.test(chapterId)) throw new StoryImageError("INVALID_CHAPTER", "章节信息不完整");
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new StoryImageError("INVALID_REQUEST", "请求编号无效，请重试");
  if (!PURPOSES.includes(purpose)) throw new StoryImageError("INVALID_PURPOSE", "不支持这种配图");
  if (!ENABLED_PURPOSES.includes(purpose)) throw new StoryImageError("PURPOSE_NOT_YET", "这种配图还没开放");
  if (referenceImageId && !STORY_IMAGE_ID_PATTERN.test(referenceImageId)) {
    throw new StoryImageError("INVALID_REFERENCE_IMAGE", "参考图信息无效，请重新选择");
  }
  if (referenceImageId && purpose !== "illustration") {
    throw new StoryImageError("INVALID_REFERENCE_PURPOSE", "只有章节插图可以参考旧图再画");
  }
  return { familyId, memberId, storyId, chapterId, requestId, purpose, referenceImageId };
}

function normalizeMemberInput(event) {
  const memberId = String((event && event.memberId) || "").trim();
  if (!ID_PATTERN.test(memberId)) throw new StoryImageError("INVALID_MEMBER", "档案信息不完整");
  return memberId;
}

function normalizeStoryInput(event) {
  const storyId = String((event && event.storyId) || "").trim();
  if (!ID_PATTERN.test(storyId)) throw new StoryImageError("INVALID_STORY", "故事信息不完整");
  return storyId;
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

function latestDraftForStory(records, storyId) {
  const list = Array.isArray(records) ? records : [];
  const revisions = list
    .filter(record => record && record.draftType === "story-revision" && record.storyId === storyId &&
      record.revision && record.revision.storyId === storyId && record.revision.draft)
    .map(record => record.revision)
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)) || String(b.id).localeCompare(String(a.id)));
  return revisions[0] && revisions[0].draft;
}

function assertUnrestrictedStory(story,draft) {
  const marked=item=>item&&typeof item==='object'&&
    (item.sourcePolicyRequired||['sourceIds','blockId','provenanceVersion'].some(key=>Object.prototype.hasOwnProperty.call(item,key)));
  if(marked(story)||marked(draft)||(draft?.content||[]).some(marked)||
    (draft?.chapters||[]).some(chapter=>marked(chapter)||(chapter.content||[]).some(marked)))
    throw new StoryImageError("STORY_PROTOCOL_REQUIRED","这份故事包含来源限制，暂不支持生成配图");
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
    characterContext: bookCharacterContext(draft, chapterId),
  };
}

/**
 * Other chapters are used only to disambiguate recurring people. Keep a small,
 * bounded set of identity words instead of sending the surrounding sentences
 * (and their unrelated private events) to the model.
 */
function bookCharacterContext(draft, chapterId) {
  const chapters = draft && Array.isArray(draft.chapters) ? draft.chapters : [];
  const activeIndex = chapters.findIndex(item => item && item.id === chapterId);
  if (activeIndex < 0) return "";
  const cue = /女孩|男孩|女人|男人|姑娘|小伙|女性|男性|少女|少年|女儿|儿子|妻子|丈夫|母亲|父亲|妈妈|爸爸|奶奶|爷爷|外婆|外公|姐姐|哥哥|妹妹|弟弟|阿姨|叔叔|女士|先生|老人|孩子|儿童/g;
  const ordered = chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(item => item.index !== activeIndex)
    .sort((left, right) => Math.abs(left.index - activeIndex) - Math.abs(right.index - activeIndex) || left.index - right.index);
  const snippets = [];
  const seen = new Set();
  let length = 0;
  for (const { chapter } of ordered) {
    const text = (Array.isArray(chapter && chapter.content) ? chapter.content : [])
      .map(item => (item && typeof item.text === "string" ? item.text : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    const sentences = text.match(/[^。！？!?]+[。！？!?]?/g) || [];
    for (const raw of sentences) {
      const sentence = raw.trim().slice(0, 180);
      const clues = Array.from(new Set(sentence.match(cue) || []));
      const named = sentence.match(/(?:我叫|名叫|叫作|叫做)([\u3400-\u9fff·]{2,12})/);
      if (named && !clues.includes(named[1])) clues.unshift(named[1]);
      if (!clues.length) continue;
      const snippet = `其他章节人物线索：${clues.join("、")}`;
      if (seen.has(snippet)) continue;
      if (length + snippet.length > MAX_CHARACTER_CONTEXT || snippets.length >= MAX_CHARACTER_SENTENCES) return snippets.join("\n");
      snippets.push(snippet);
      seen.add(snippet);
      length += snippet.length;
    }
  }
  return snippets.join("\n");
}

const FEMALE_CUE = /女孩|女人|姑娘|女性|少女|女儿|妻子|母亲|妈妈|奶奶|外婆|姐姐|妹妹|阿姨|女士|女子/;
const MALE_CUE = /男孩|男人|小伙|男性|少年|儿子|丈夫|父亲|爸爸|爷爷|外公|哥哥|弟弟|叔叔|先生|男子/;
const FEMALE_WORDS = /女孩|女人|姑娘|女性|少女|女儿|妻子|母亲|妈妈|奶奶|外婆|姐姐|妹妹|阿姨|女士|女子/g;
const MALE_WORDS = /男孩|男人|小伙|男性|少年|儿子|丈夫|父亲|爸爸|爷爷|外公|哥哥|弟弟|叔叔|先生|男子/g;

function genderEvidence(text) {
  const female = FEMALE_CUE.test(String(text || ""));
  const male = MALE_CUE.test(String(text || ""));
  return female === male ? (female ? "mixed" : "unknown") : (female ? "female" : "male");
}

/** Current-chapter facts win; absent reliable evidence, keep figures gender-neutral. */
function alignSceneFigures(scene, source) {
  const current = genderEvidence(source && source.text);
  const context = genderEvidence(source && source.characterContext);
  const evidence = current === "unknown" ? (context === "mixed" ? "unknown" : context) : current;
  const figures = (scene.figures || []).map(figure => {
    if (evidence === "female") return figure.replace(/男孩/g, "女孩").replace(/男人|男子/g, "女人").replace(/男性/g, "女性").replace(/少年/g, "少女").replace(/先生/g, "女士").replace(/儿子|丈夫|父亲|爸爸|爷爷|外公|哥哥|弟弟|叔叔/g, "人物");
    if (evidence === "male") return figure.replace(/女孩/g, "男孩").replace(/女人|女子/g, "男人").replace(/女性/g, "男性").replace(/少女/g, "少年").replace(/女士/g, "先生").replace(/女儿|妻子|母亲|妈妈|奶奶|外婆|姐姐|妹妹|阿姨/g, "人物");
    if (evidence === "unknown") return figure.replace(FEMALE_WORDS, "人物").replace(MALE_WORDS, "人物");
    return figure;
  });
  return { ...scene, figures };
}

/** The chosen picture may itself be wrong; current text still controls people and props. */
function alignVisualReference(reference, source, scene) {
  if (!reference) return undefined;
  let figures = alignSceneFigures({ figures: reference.figures || [] }, source).figures;
  if (genderEvidence(source && source.text) === "mixed") {
    figures = figures.map(figure => figure.replace(FEMALE_WORDS, "人物").replace(MALE_WORDS, "人物"));
  }
  const currentText = String((source && source.text) || "");
  const sceneObjects = new Set(Array.isArray(scene && scene.objects) ? scene.objects : []);
  const objects = (reference.objects || []).filter(referenceObject =>
    referenceObject.length >= 2 && sceneObjects.has(referenceObject) && currentText.includes(referenceObject));
  return { ...reference, figures, objects };
}

function draftReferencesStoryImage(draft, imageId) {
  const match = String(imageId || "").match(/_img_(req-[0-9a-z-]{8,60})$/);
  const referenceId = match ? `photo-ai-${match[1]}` : "";
  const chapters = draft && Array.isArray(draft.chapters) ? draft.chapters : [];
  return chapters.some(chapter => chapter && (chapter.backdropImageId === imageId ||
    (Array.isArray(chapter.content) && chapter.content.some(item => item &&
      (item.storyImageId === imageId || (referenceId && item.photoId === referenceId))))));
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
    setting: cleanText(parsed.setting, 40),
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
    maxObjects: 6,
    withScene: true,
    withFigures: true,
  },
  // A backdrop sits under the chapter text: scenery only, pale, with an empty top half.
  backdrop: {
    lead: "安静的纸本淡彩底图，暖白色宣纸底。上方大面积是接近纯白的宣纸留白，景物只占画面下方三分之一和两侧边角。色彩稀薄，对比柔和，线条简洁，纹样稀少，画面由景物与器物构成。",
    width: 1248,
    height: 832,
    maxObjects: 3,
    withScene: false,
    withFigures: false,
  },
};

/** Affirmative wording only: image models have no notion of "don't draw". */
function buildImagePrompt(scene, purpose, visualReference) {
  const style = STYLES[purpose];
  if (!style) throw new StoryImageError("PURPOSE_NOT_YET", "这种配图还没开放");
  const parts = [style.lead];
  if (style.withScene) parts.push(`画面：${scene.scene}。`);
  else if (scene.setting) parts.push(`景物：${scene.setting}。`);
  const objects = scene.objects.slice(0, style.maxObjects);
  if (objects.length) parts.push(`画中有${objects.join("、")}。`);
  if (scene.light) parts.push(`时节与光线：${scene.light}。`);
  if (style.withFigures && scene.figures.length) parts.push(`人物以远景或局部呈现：${scene.figures.join("、")}。`);
  if (scene.mood) parts.push(`整体氛围${scene.mood}。`);
  if (scene.eraHint) parts.push(`时代感：${scene.eraHint}。`);
  if (visualReference) {
    const continuity = [];
    if (visualReference.style) continuity.push(`画风与材质延续${visualReference.style}`);
    if (visualReference.palette.length) continuity.push(`主要配色延续${visualReference.palette.join("、")}`);
    if (style.withFigures && visualReference.figures.length) continuity.push(`人物可见外观延续${visualReference.figures.join("、")}`);
    if (visualReference.objects.length) continuity.push(`相符的辨识物件延续${visualReference.objects.join("、")}`);
    if (continuity.length) parts.push(`参考图的视觉连续性：${continuity.join("；")}。`);
  }
  return { prompt: parts.join(""), width: style.width, height: style.height };
}

/**
 * TokenHub answers refusals with HTTP status codes: 422 is a content check,
 * other 4xx mean the picture was never started. A timeout, a server error or a
 * success without a picture may already have cost money, so it stays uncertain.
 */
function classifyGenerateError(error) {
  const httpStatus = error && error.httpStatus;
  if (httpStatus === 422) return { status: "blocked", errorCode: "CONTENT_BLOCKED" };
  if (httpStatus >= 400 && httpStatus < 500) return { status: "failed", errorCode: `HTTP_${httpStatus}` };
  if (httpStatus) return { status: "unknown", errorCode: `HTTP_${httpStatus}` };
  if (error && error.name === "AbortError") return { status: "unknown", errorCode: "GENERATE_TIMEOUT" };
  return { status: "unknown", errorCode: "GENERATE_UNCERTAIN" };
}

function sweepAction(job, nowMs) {
  const age = nowMs - Number(job.updatedAtMs || job.createdAtMs || 0);
  switch (job.status) {
    case "submitted": return age > SUBMIT_STALE_MS ? "mark-failed" : "skip";
    case "queued": return age > QUEUED_PICKUP_MS ? "generate" : "skip";
    case "generating": return age > GENERATING_STALE_MS ? "mark-unknown" : "skip";
    case "generated": return "store";
    case "storing": return age > STORING_STALE_MS ? "release" : "skip";
    default: return "skip";
  }
}

function publicJob(job) {
  return {
    jobId: job._id,
    status: job.status,
    message: (job.status === "failed" && SCENE_FAILURE_MESSAGES[job.errorCode]) || MESSAGES[job.status] || "",
    chapterId: job.chapterId,
    purpose: job.purpose,
    imageId: job.imageId || "",
    ...(job.referenceImageId ? { referenceApplied: true, referenceImageId: job.referenceImageId } : {}),
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
    quality: image.quality || "unchecked",
    qualityIssues: (Array.isArray(image.qualityIssues) ? image.qualityIssues : [])
      .map(key => QUALITY_ISSUE_LABELS[key])
      .filter(Boolean),
    aiGenerated: true,
    createdAtMs: image.createdAtMs,
  };
}

const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

function extensionFor(contentType) {
  return EXTENSIONS[String(contentType || "").toLowerCase()] || "png";
}

module.exports = {
  assertUnrestrictedStory,
  ACTIVE_STATUSES,
  BOOK_LIMIT,
  COUNTED_STATUSES,
  DAILY_LIMIT,
  ENABLED_PURPOSES,
  MESSAGES,
  QUALITY_ISSUE_KEYS,
  QUALITY_ISSUE_LABELS,
  STYLES,
  StoryImageError,
  buildImagePrompt,
  bookCharacterContext,
  alignSceneFigures,
  alignVisualReference,
  chapterSource,
  chinaDayKey,
  classifyGenerateError,
  cleanText,
  extensionFor,
  draftReferencesStoryImage,
  familyIdFor,
  latestDraftForMember,
  latestDraftForStory,
  normalizeMemberInput,
  normalizeStoryInput,
  normalizeSubmitInput,
  parseSceneJson,
  publicImage,
  publicJob,
  quotaDecision,
  requireOwner,
  sweepAction,
  textHash,
};
