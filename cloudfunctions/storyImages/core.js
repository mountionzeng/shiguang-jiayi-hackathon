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
/** Covers use the current saved story revision, with explicit reference selection. */
const ENABLED_PURPOSES = ["illustration", "backdrop", "cover"];
const COVER_CHAPTER_ID = "book-cover";
const MAX_BOOK_TEXT = 120000;
const MAX_MEMORY_ART_TEXT = 60000;
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
const PHOTO_ID_PATTERN = /^photo-(?!ai-)[0-9a-z-]{1,80}$/;
const MAX_ART_DIRECTION = 80;

function normalizeArtDirection(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > MAX_ART_DIRECTION) {
    throw new StoryImageError("INVALID_ART_DIRECTION", "想画成什么样子，请写在 80 字以内");
  }
  const direction = cleanText(value, MAX_ART_DIRECTION);
  if (/(?:不要|禁止|避免|不得|没有)/.test(direction)) {
    throw new StoryImageError("INVALID_ART_DIRECTION", "请直接描述想看到的画面，例如「淡墨与暖黄的纸本插画」");
  }
  return direction;
}

function normalizeReferencePhotoIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new StoryImageError("INVALID_REFERENCE_IMAGE", "参考照片信息无效，请重新选择");
  const ids = value.map(id => String(id || "").trim());
  if (ids.length > 3 || new Set(ids).size !== ids.length || !ids.every(id => PHOTO_ID_PATTERN.test(id))) {
    throw new StoryImageError("INVALID_REFERENCE_IMAGE", "最多选 3 张本章照片作为参考");
  }
  return ids;
}

function normalizeSubmitInput(event) {
  const input = event || {};
  const familyId = String(input.familyId || "").trim();
  const memberId = String(input.memberId || "").trim();
  const storyId = String(input.storyId || "").trim();
  const chapterId = input.purpose === "cover" ? COVER_CHAPTER_ID : String(input.chapterId || "").trim();
  const requestId = String(input.requestId || "").trim();
  const purpose = String(input.purpose || "illustration");
  const referenceImageId = String(input.referenceImageId || "").trim();
  const referencePhotoIds = normalizeReferencePhotoIds(input.referencePhotoIds);
  const artDirection = normalizeArtDirection(input.artDirection);
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
  if (referencePhotoIds.length && !["illustration", "backdrop", "cover"].includes(purpose)) {
    throw new StoryImageError("INVALID_REFERENCE_PURPOSE", "只有章节插图、底图和封面可以参考照片");
  }
  if (referencePhotoIds.length && purpose === "illustration" && referenceImageId) {
    throw new StoryImageError("INVALID_REFERENCE_IMAGE", "本章照片和旧插图一次只能选一种参考");
  }
  if (referencePhotoIds.length && ["illustration", "backdrop"].includes(purpose) && input.photoReferenceConsent !== true) {
    throw new StoryImageError("CONSENT_REQUIRED", "请先确认本次配图使用的照片参考");
  }
  if (purpose === "cover") {
    if (!ID_PATTERN.test(storyId)) throw new StoryImageError("INVALID_STORY", "请先把这份书稿保存为故事书");
    if (input.coverConsent !== true) throw new StoryImageError("CONSENT_REQUIRED", "请先确认本次封面使用的文字和参考图片");
    const referenceImageIds = Array.isArray(input.referenceImageIds) ? input.referenceImageIds : [];
    const ids = [...referenceImageIds, ...referencePhotoIds];
    if (ids.length > 3 || new Set(ids).size !== ids.length ||
      !referenceImageIds.every(id => typeof id === "string" && STORY_IMAGE_ID_PATTERN.test(id)) ||
      !referencePhotoIds.every(id => typeof id === "string" && /^photo-[0-9a-z-]{1,80}$/.test(id))) {
      throw new StoryImageError("INVALID_REFERENCE_IMAGE", "最多选 3 张本书的图片作为参考");
    }
    return { familyId, memberId: "", storyId, chapterId, requestId, purpose, referenceImageId: "", referenceImageIds, referencePhotoIds, artDirection };
  }
  return { familyId, memberId, storyId, chapterId, requestId, purpose, referenceImageId, referencePhotoIds, artDirection };
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

function memoryIdOf(memory) {
  const id = typeof memory?.id === "string" ? memory.id : "";
  if (id) return id;
  const raw = String(memory?._id || "");
  const match = raw.match(/_(memory-[0-9A-Za-z_-]{1,120})$/);
  return match ? match[1] : raw;
}

function memoryTextForArt(memory) {
  if (!memory || memory.deletedAt || memory.sourcePolicyRequired || memory.sourceIds) return "";
  return cleanText(memory.text, MAX_MEMORY_ART_TEXT);
}

function combinedArtText(primaryText, memories) {
  const parts = [String(primaryText || "").trim()].filter(Boolean);
  const existing = parts.join("\n");
  let length = existing.length;
  const seen = new Set(parts.map(item => item.replace(/\s+/g, " ").trim()).filter(Boolean));
  for (const memory of Array.isArray(memories) ? memories : []) {
    const text = memoryTextForArt(memory);
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized) || existing.includes(normalized)) continue;
    if (length + normalized.length > MAX_MEMORY_ART_TEXT) break;
    parts.push(normalized);
    seen.add(normalized);
    length += normalized.length;
  }
  return parts.join("\n\n").slice(0, MAX_MEMORY_ART_TEXT);
}

function chapterMemories(chapter, memories) {
  const ids = new Set(Array.isArray(chapter?.memoryIds) ? chapter.memoryIds : []);
  return (Array.isArray(memories) ? memories : []).filter(memory => ids.has(memoryIdOf(memory)));
}

function chapterPhotoIds(chapter) {
  const ids = (Array.isArray(chapter?.content) ? chapter.content : [])
    .map(item => typeof item?.photoId === "string" ? item.photoId : "")
    .filter(id => PHOTO_ID_PATTERN.test(id));
  return [...new Set(ids)].slice(0, 3);
}

/** The chapter's own words from the saved book. User photos stay opaque until a separate AI-reference consent is granted. */
function chapterSource(draft, chapterId, memories = []) {
  const chapters = draft && Array.isArray(draft.chapters) ? draft.chapters : [];
  const chapter = chapters.find(item => item && item.id === chapterId);
  if (!chapter) throw new StoryImageError("CHAPTER_NOT_FOUND", "没找到这一章，请先保存书稿再配图");
  const text = (Array.isArray(chapter.content) ? chapter.content : [])
    .map(item => (item && typeof item.text === "string" ? item.text : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) throw new StoryImageError("CHAPTER_EMPTY", "这一章还没有文字，先写几句再配图");
  const artText = combinedArtText(text, chapterMemories(chapter, memories));
  const photoIds = chapterPhotoIds(chapter);
  return {
    title: String(chapter.title || "").trim().slice(0, 40),
    text: text.slice(0, MAX_CHAPTER_TEXT),
    textLength: text.length,
    artText,
    artTextLength: artText.length,
    fullTextHash: textHash(artText),
    photoIds,
    photoHash: textHash(photoIds.join("\n")),
    characterContext: bookCharacterContext(draft, chapterId),
    bookLifeCategory: bookLifeCategory(draft),
  };
}

/** Every saved chapter is sent in order; never silently truncate a book. */
function bookSource(draft, memories = []) {
  const chapters = Array.isArray(draft?.chapters) ? draft.chapters : [];
  const sections = chapters.map((chapter, index) => {
    const body = (chapter.content || []).map(item => typeof item?.text === "string" ? item.text : "").join("").trim();
    return body ? `第${index + 1}章 ${String(chapter.title || "")}\n${body}` : "";
  }).filter(Boolean);
  if (!sections.length) throw new StoryImageError("BOOK_EMPTY", "先写下并保存一些正文，再来生成封面");
  const text = sections.join("\n\n");
  if (text.length > MAX_BOOK_TEXT) throw new StoryImageError("BOOK_TOO_LONG", "这本书超过了单次封面阅读长度，暂时无法完整处理");
  const artText = combinedArtText(text, memories);
  return { title: String(draft.title || "").slice(0, 80), text, textLength: text.length,
    artText, artTextLength: artText.length, fullTextHash: textHash(artText),
    characterContext: "", scope: "book", chapterCount: chapters.length, bookLifeCategory: bookLifeCategory(draft) };
}

const LIFE_CUES = {
  family: /家里|家人|妈妈|母亲|爸爸|父亲|爷爷|奶奶|外婆|外公|儿女|孩子/,
  local: /村|乡|县|集市|田|院子|灶台|巷/,
  urban: /街道|楼房|地铁|公交|车站|城市/,
  nature: /山林|山坡|河流|海边|森林|树林|树下|树木|草地|花朵|鲜花|草木/,
};

function lifeCategory(text) {
  return Object.keys(LIFE_CUES).find(key => LIFE_CUES[key].test(text)) || "";
}

/** A book-wide cue is distilled locally; other chapters are not sent to scene extraction for a chapter. */
function bookLifeCategory(draft) {
  const counts = Object.fromEntries(Object.keys(LIFE_CUES).map(key => [key, 0]));
  for (const chapter of Array.isArray(draft?.chapters) ? draft.chapters : []) {
    const text = (Array.isArray(chapter?.content) ? chapter.content : []).map(item => typeof item?.text === "string" ? item.text : "").join("");
    for (const [key, cue] of Object.entries(LIFE_CUES)) if (cue.test(text)) counts[key] += 1;
  }
  if (!Object.values(counts).some(Boolean)) return "";
  return Object.keys(counts).sort((left, right) => counts[right] - counts[left])[0];
}

/** Keep only one explicitly written period; a book spanning periods has no single era style. */
function explicitEraHint(text) {
  const matches = String(text || "").match(/(?:18|19|20)\d{2}\s?年(?:代)?|[一二三四五六七八九〇零]{4}年|(?:十八|十九|二十|二十一|18|19|20|21)世纪(?:[一二三四五六七八九十〇零\d]{1,3}年代)?|上世纪[三四五六七八九十\d]{1,3}年代|清末|民国(?:时期)?|改革开放初期|文革时期|文化大革命时期/g) || [];
  const periods = [...new Set(matches.map(item => item.replace(/\s+/g, "")))];
  return periods.length === 1 ? periods[0] : "";
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
function alignVisualReference(reference, source, scene, options = {}) {
  if (!reference) return undefined;
  let figures = alignSceneFigures({ figures: reference.figures || [] }, source).figures;
  if (genderEvidence(source && source.text) === "mixed") {
    figures = figures.map(figure => figure.replace(FEMALE_WORDS, "人物").replace(MALE_WORDS, "人物"));
  }
  const currentText = String((source && source.text) || "");
  const sceneObjects = new Set(Array.isArray(scene && scene.objects) ? scene.objects : []);
  const objects = options.trustedChapterPhoto ? (reference.objects || []).slice(0, 4) : (reference.objects || []).filter(referenceObject =>
    referenceObject.length >= 2 && sceneObjects.has(referenceObject) && currentText.includes(referenceObject));
  return { ...reference, figures, objects, ...((reference.photoReference === true || options.photoReference === true) ? { photoReference: true } : {}) };
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

/** Stable for one paid request; a deliberate new drawing receives a different seed. */
function imageSeed(familyId, requestId) {
  return Number.parseInt(textHash(`${familyId}:${requestId}`).slice(0, 8), 16) || 1;
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
  cover: {
    lead: "竖版文学书籍封面画，以暖白纸面和有层次的手绘媒介作画。纸纤维承接深浅不同的色层，轮廓经过概括，局部擦洗留下制作痕迹。围绕整本书共同的主题组织一个简洁意象，画面完整铺满封面，上方三分之一保留干净浅色区域供书名排版，画面由纯粹的图像元素组成。",
    width: 768, height: 1024, maxObjects: 4, withScene: true, withFigures: true,
  },
  illustration: {
    lead: "纸本手绘插画，暖白纸面的纤维清晰可见。笔触有轻重，颜色一层层叠上去，边缘保留纸面阻力；形体经过概括取舍，留白承载画面的呼吸。",
    width: 1024,
    height: 768,
    maxObjects: 6,
    withScene: true,
    withFigures: true,
  },
  // A backdrop sits under the chapter text: scenery only, pale, with an empty top half.
  backdrop: {
    lead: "安静的纸本淡彩底图，暖白宣纸有细微纤维与稀薄的水彩渗色。上方大面积是接近纯白的宣纸留白，景物只占画面下方三分之一和两侧边角。颜色轻薄，墨色浓淡分出远近，边缘随纸吸水轻柔晕开；线条简洁，纹样稀少，画面由景物与器物构成。",
    width: 1248,
    height: 832,
    maxObjects: 3,
    withScene: false,
    withFigures: false,
  },
};

const EMOTION_PAINT = [
  { words: /怀旧|思念|回忆|惦念/, paint: "颜色像被时间轻轻洗过，局部叠笔与擦洗留下记忆的层次。" },
  { words: /孤独|寂寞|孤单/, paint: "主体在环境中占较小尺度，周围的大块空白承接独处的重量。" },
  { words: /温暖|温馨|亲切|安稳/, paint: "光从场景中可辨认的方向落在物件上，暖色薄涂使物件有温度。" },
  { words: /欢喜|喜悦|开心|快乐/, paint: "色块在疏朗的节奏中轻轻跳动，局部明亮而纸面仍然透气。" },
  { words: /难过|悲伤|失落/, paint: "颜色在边缘轻轻沉下去，稀疏笔触和空白保留情绪的余韵。" },
];
const NEGATED_EMOTION_PREFIX = /(?:不要|并非|不是|不想|不再|并不|没有|避免|拒绝|禁止|不|without|not|no)\s*[^，。！？\n]{0,18}$/i;

function hasAffirmedEmotion(words, sourceText) {
  const mentions = [...String(sourceText || "").matchAll(new RegExp(words.source, "g"))];
  return mentions.some(match => !NEGATED_EMOTION_PREFIX.test(String(sourceText).slice(Math.max(0, match.index - 24), match.index)));
}

function emotionPaint(mood, sourceText) {
  const text = String(sourceText || "");
  const matching = EMOTION_PAINT.find(item => item.words.test(mood || ""));
  if (matching) {
    const mentions = [...text.matchAll(new RegExp(matching.words.source, "g"))];
    if (mentions.length && mentions.every(match => NEGATED_EMOTION_PREFIX.test(text.slice(Math.max(0, match.index - 24), match.index)))) return "";
    return matching.paint;
  }
  const inferred = EMOTION_PAINT.find(item => hasAffirmedEmotion(item.words, text));
  return inferred ? inferred.paint : "";
}

const LIFE_PAINT = {
  family: { medium: "柔软彩铅颗粒与薄水彩在纸上相叠，保留铅笔底稿的细线。", texture: "家庭内部的生活质地由物件之间的距离和细微叠色承载。" },
  local: { medium: "淡墨皴擦与薄水彩在粗纸上交汇，器物边缘带一点干笔。", texture: "地方生活的日常质地落在器物的手感与纸面颗粒里。" },
  urban: { medium: "细笔描线配合浅色手工套印，色块边缘有轻微错位。", texture: "城市日常的节奏由直线与疏密错落的色块组织。" },
  nature: { medium: "淡墨渗色与水彩湿画相接，纸面吸水的边缘形成空气感。", texture: "自然景物以疏密不同的笔触和纸面留白组织空间。" },
};

/** Affirmative wording only: image models have no notion of "don't draw". */
function buildImagePrompt(scene, purpose, visualReference, source, artDirection = "") {
  const style = STYLES[purpose];
  if (!style) throw new StoryImageError("PURPOSE_NOT_YET", "这种配图还没开放");
  const parts = [style.lead];
  if (style.withScene) parts.push(`画面：${scene.scene}。`);
  else if (scene.setting) parts.push(`景物：${scene.setting}。`);
  const objects = scene.objects.slice(0, style.maxObjects);
  if (objects.length) parts.push(`画中有${objects.join("、")}。`);
  if (scene.light) parts.push(`时节与光线：${scene.light}。`);
  if (style.withFigures && scene.figures.length) parts.push(`人物以远景或局部呈现：${scene.figures.join("、")}。`);
  const text = String(source?.artText || source?.text || "");
  const category = purpose === "cover" ? source?.bookLifeCategory || lifeCategory(text) : lifeCategory(text) || source?.bookLifeCategory;
  const selectedPaint = LIFE_PAINT[category];
  if (selectedPaint) parts.push(purpose === "backdrop" ? `媒介细节：${selectedPaint.medium}` : `媒介与材料：${selectedPaint.medium}`);
  if (purpose !== "backdrop") {
    const paint = emotionPaint(scene.mood, text);
    if (paint) parts.push(`情绪的画法：${paint}`);
    parts.push(selectedPaint?.texture || "让纸面材料与物件之间的空间关系承担叙事。");
    if (/(?:^|[^你他她它])我(?:们|自己)?/.test(text)) parts.push("视点贴近讲述者的主观经验，以亲近的物件尺度安排空间。");
    else parts.push("视点从动作与关系观察，人物与环境保留自然的距离。");
  }
  const eraHint = explicitEraHint(text);
  if (eraHint) parts.push(`${purpose === "backdrop" ? "景物与器物" : "服装与器物"}的年代质地依据正文明确写出的${eraHint}。`);
  if (purpose === "illustration") parts.push("主体略偏于画面一侧，大块暖白留白与有来源的自然光组成安静的构图。局部保留叠笔、纸面阻力与轻微未覆盖的底色。");
  if (purpose === "cover") parts.push("主体与留白构成可读的封面骨架，光线来自画面内的时节与环境。局部保留叠笔、擦洗与未覆盖的纸色。");
  if (purpose === "backdrop") parts.push("淡淡的渗色与纸纤维只在景物附近显现，正文所在的留白保持清朗。");
  if (artDirection) parts.push(`用户的美术偏好：${artDirection}。优先体现在色彩、材料与笔触中，画面事实仍以正文为准。`);
  if (visualReference) {
    if (visualReference.photoReference) parts.push(purpose === "backdrop" ? "本章照片参考：参考照片里的主体外观、毛色、花纹、姿态、配色和可见物件是底图下方和两侧边角的视觉依据；正文留白仍保持清朗，但主体轮廓、配色或关键物件需要能看出来自原图。" : "本章照片参考：参考照片里的主体外观、毛色、花纹、姿态、配色和可见物件是本章视觉依据，转换为纸本手绘插画。");
    const continuity = [];
    if (visualReference.style) continuity.push(`画风与材质延续${visualReference.style}`);
    if (visualReference.palette.length) continuity.push(`主要配色延续${visualReference.palette.join("、")}`);
    if ((style.withFigures || purpose === "backdrop") && visualReference.figures.length) continuity.push(`主体可见外观延续${visualReference.figures.join("、")}`);
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
    ...(Array.isArray(job.referencePhotoIds) && job.referencePhotoIds.length ? { referenceApplied: true, referencePhotoIds: job.referencePhotoIds } : {}),
    ...(job.purpose === "cover" ? { referenceApplied: true, referenceImageIds: job.referenceImageIds || [], referencePhotoIds: job.referencePhotoIds || [] } : {}),
    ...(job.artDirectionHash ? { ideaApplied: true } : {}),
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
  bookSource,
  chapterPhotoIds,
  COVER_CHAPTER_ID,
  MAX_BOOK_TEXT,
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
  imageSeed,
};
