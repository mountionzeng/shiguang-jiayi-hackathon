const FAMILY_ID_PATTERN = /^family_[0-9A-Za-z_-]{1,120}$/;
const PHOTO_ID_PATTERN = /^photo-[0-9a-z-]{1,80}$/;
const PURPOSES = new Set(["view", "ai-caption", "ai-reference"]);
const VARIANTS = new Set(["small", "display"]);
const SOURCES = new Set(["book", "import", "backfill"]);

class PhotoAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requiredId(value, pattern, code, message) {
  const id = String(value || "").trim();
  if (!pattern.test(id)) throw new PhotoAccessError(code, message);
  return id;
}

function normalizeReadInput(event) {
  const familyId = requiredId(event && event.familyId, FAMILY_ID_PATTERN, "INVALID_FAMILY", "记忆之家信息不完整");
  const purpose = String(event && event.purpose || "");
  const variant = String(event && event.variant || "");
  if (!PURPOSES.has(purpose)) throw new PhotoAccessError("INVALID_PURPOSE", "读取照片的用途无效");
  if (!VARIANTS.has(variant)) throw new PhotoAccessError("INVALID_VARIANT", "照片规格无效");
  const photoIds = Array.isArray(event && event.photoIds) ? event.photoIds.map(value => String(value || "").trim()) : [];
  const limit = purpose === "view" ? 9 : 3;
  if (!photoIds.length || photoIds.length > limit || new Set(photoIds).size !== photoIds.length || !photoIds.every(id => PHOTO_ID_PATTERN.test(id))) {
    throw new PhotoAccessError("INVALID_PHOTOS", `一次最多读取 ${limit} 张有效照片`);
  }
  return { familyId, purpose, variant, photoIds };
}

function normalizeRegisterInput(event) {
  const familyId = requiredId(event && event.familyId, FAMILY_ID_PATTERN, "INVALID_FAMILY", "记忆之家信息不完整");
  const photoId = requiredId(event && event.photoId, PHOTO_ID_PATTERN, "INVALID_PHOTO", "照片编号无效");
  const source = String(event && event.source || "");
  if (!SOURCES.has(source)) throw new PhotoAccessError("INVALID_SOURCE", "照片来源无效");
  const displayFileID = String(event && event.displayFileID || "").trim();
  const smallFileID = String(event && event.smallFileID || "").trim();
  const expectedBase = `/user-photos/${familyId}/${photoId}/`;
  if (!displayFileID.endsWith(`${expectedBase}display.jpg`) || !smallFileID.endsWith(`${expectedBase}small.jpg`)) {
    throw new PhotoAccessError("INVALID_FILES", "照片文件位置不正确");
  }
  const dimensions = ["width", "height", "displayBytes", "smallBytes"].map(key => Number(event && event[key]));
  if (dimensions.some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new PhotoAccessError("INVALID_METADATA", "照片尺寸信息不完整");
  }
  const [width, height, displayBytes, smallBytes] = dimensions;
  return { familyId, photoId, source, displayFileID, smallFileID, width, height, displayBytes, smallBytes };
}

function isInternalContext(context) {
  const source = String(context && context.SOURCE || "");
  return source !== "wx_client" && source !== "wx_devtools";
}

function requesterOpenid(context, event, expectedToken) {
  const direct = String(context && context.OPENID || "").trim();
  if (!isInternalContext(context)) {
    if (!direct) throw new PhotoAccessError("OPENID_NOT_AVAILABLE", "没有拿到微信身份，请重新进入小程序");
    return direct;
  }
  const supplied = String(event && event.internalToken || "");
  if (!expectedToken || supplied !== expectedToken) throw new PhotoAccessError("FORBIDDEN", "内部调用验证失败");
  const onBehalfOf = String(event && event.onBehalfOfOpenid || "").trim();
  if (!onBehalfOf) throw new PhotoAccessError("OPENID_NOT_AVAILABLE", "没有要代读的微信身份");
  return onBehalfOf;
}

function moderationState(photo) {
  const moderation = photo && photo.moderation || {};
  if (moderation.suggest === "risky") return "risky";
  if (moderation.ok === true && moderation.suggest === "pass") return "pass";
  return "pending";
}

function memoryReferencesPhoto(memory, photoId) {
  return Array.isArray(memory && memory.photoIds) && memory.photoIds.includes(photoId);
}

function canViewSharedPhoto(photo, visibleMemories) {
  return moderationState(photo) === "pass" && visibleMemories.some(memory => memoryReferencesPhoto(memory, photo.photoId));
}

function publicPhoto(photo, input, requester, visibleMemories) {
  if (!photo || photo.familyId !== input.familyId) return { photoId: input.photoId, status: "not_found" };
  if (photo.deletedAt) return { photoId: input.photoId, status: "deleted" };
  const owner = photo._openid === requester;
  if (input.purpose !== "view" && !owner) return { photoId: input.photoId, status: "not_found" };
  if (input.purpose === "view" && !owner && !canViewSharedPhoto(photo, visibleMemories)) {
    return { photoId: input.photoId, status: "forbidden" };
  }
  if (input.purpose !== "view" && moderationState(photo) === "risky") {
    return { photoId: input.photoId, status: "risky" };
  }
  const fileID = input.variant === "small" ? photo.smallFileID : photo.displayFileID;
  if (!fileID) return { photoId: input.photoId, status: "not_uploaded" };
  return {
    photoId: input.photoId,
    status: "ok",
    fileID,
    contentType: "image/jpeg",
    width: photo.width,
    height: photo.height,
    bytes: input.variant === "small" ? photo.smallBytes : photo.displayBytes,
  };
}

module.exports = {
  PhotoAccessError,
  canViewSharedPhoto,
  isInternalContext,
  moderationState,
  normalizeReadInput,
  normalizeRegisterInput,
  publicPhoto,
  requesterOpenid,
};
