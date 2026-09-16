const crypto = require("node:crypto");
const cloud = require("wx-server-sdk");
const {
  PhotoAccessError,
  isInternalContext,
  normalizeReadInput,
  normalizeRegisterInput,
  publicPhoto,
  requesterOpenid,
} = require("./core");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const PHOTOS = "photos";

function errorMessage(error) {
  return String(error && error.errMsg ? error.errMsg : error);
}

function isExisting(error) {
  return /already exists|ResourceExist|COLLECTION_(ALREADY_)?EXIST|Table exist/i.test(errorMessage(error));
}

function isMissing(error) {
  return /does not exist|not found|cannot find document|Table not exist/i.test(errorMessage(error));
}

async function ensureCollection() {
  try {
    await db.createCollection(PHOTOS);
  } catch (error) {
    if (!isExisting(error)) throw error;
  }
}

async function getDoc(collectionName, id) {
  try {
    return (await db.collection(collectionName).doc(id).get()).data;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function loadAll(collectionName, where) {
  const rows = [];
  for (let offset = 0; ; offset += 20) {
    const response = await db.collection(collectionName).where(where).orderBy("_id", "asc").skip(offset).limit(20).get();
    rows.push(...response.data);
    if (response.data.length < 20) return rows;
  }
}

function accountIdFor(openid) {
  return `account_${crypto.createHash("sha256").update(openid).digest("hex").slice(0, 24)}`;
}

async function familyAccess(familyId, openid) {
  const accountId = accountIdFor(openid);
  const account = await getDoc("user_accounts", accountId);
  if (account && account.primaryFamilyId === familyId) {
    const members = await loadAll("family_members", { familyId });
    const owner = members.find(member => member.accountId === accountId) || members.find(member => member.memberId === "owner") || members.find(member => member.role === "owner");
    return owner ? { role: "owner", memberId: owner.memberId } : undefined;
  }
  const access = await getDoc("family_access", `${familyId}_${accountId}`);
  if (!access || access.status !== "active") return undefined;
  const member = await getDoc("family_members", `${familyId}_${access.memberId}`);
  return member && member.accountId === accountId ? access : undefined;
}

// Keep this rule in sync with familyInvite/core.js visibleMemoriesForAccess.
function visibleMemoriesForAccess(memories, access) {
  if (access && access.role === "owner") return memories;
  const memberId = String(access && access.memberId || "");
  if (!memberId) return [];
  return memories.filter(memory => memory.authorMemberId === memberId || (
    memory.scope === "personal" && Array.isArray(memory.sharedWithMemberIds) && memory.sharedWithMemberIds.includes(memberId)
  ));
}

async function tempUrls(fileIDs) {
  if (!fileIDs.length) return {};
  const response = await cloud.getTempFileURL({
    fileList: fileIDs.map(fileID => ({ fileID, maxAge: 2 * 60 * 60 })),
  });
  return Object.fromEntries((response.fileList || []).filter(item => item.tempFileURL).map(item => [item.fileID, item.tempFileURL]));
}

async function submitModeration(photo, openid) {
  const urls = await tempUrls([photo.displayFileID]);
  const mediaUrl = urls[photo.displayFileID];
  if (!mediaUrl) throw new Error("TEMP_URL_UNAVAILABLE");
  const response = await cloud.openapi.security.mediaCheckAsync({
    mediaUrl,
    mediaType: 2,
    version: 2,
    scene: 4,
    openid,
  });
  const traceId = String(response && (response.traceId || response.trace_id) || "");
  if (!traceId) throw new Error("MEDIA_CHECK_NO_TRACE_ID");
  await db.collection(PHOTOS).doc(photo._id).update({
    data: { moderation: { ok: false, suggest: "review", traceId, submittedAtMs: Date.now() } },
  });
}

async function register(event, context) {
  if (isInternalContext(context)) throw new PhotoAccessError("FORBIDDEN", "只能在小程序里登记照片");
  const openid = requesterOpenid(context, event, process.env.PHOTO_ACCESS_INTERNAL_TOKEN);
  const input = normalizeRegisterInput(event);
  if (!await familyAccess(input.familyId, openid)) throw new PhotoAccessError("FORBIDDEN", "你不能向这个记忆之家上传照片");
  const urls = await tempUrls([input.displayFileID, input.smallFileID]);
  if (!urls[input.displayFileID] || !urls[input.smallFileID]) throw new PhotoAccessError("FILES_NOT_FOUND", "照片还没有上传完整");
  const id = `${input.familyId}__${input.photoId}`;
  const nowMs = Date.now();
  const existing = await getDoc(PHOTOS, id);
  if (existing && existing._openid !== openid) throw new PhotoAccessError("FORBIDDEN", "这个照片编号已经被使用");
  const record = {
    ...input,
    _openid: openid,
    createdAt: existing && existing.createdAt ? existing.createdAt : db.serverDate(),
    uploadedAt: db.serverDate(),
    moderation: { ok: false, suggest: "review", submittedAtMs: nowMs },
  };
  await db.collection(PHOTOS).doc(id).set({ data: record });
  try {
    await submitModeration({ ...record, _id: id }, openid);
  } catch (error) {
    console.warn("照片内容检测提交失败，家人暂时看不到", error);
  }
  return { ok: true, photoId: input.photoId };
}

async function read(event, context) {
  const input = normalizeReadInput(event);
  const requester = requesterOpenid(context, event, process.env.PHOTO_ACCESS_INTERNAL_TOKEN);
  const records = await Promise.all(input.photoIds.map(photoId => getDoc(PHOTOS, `${input.familyId}__${photoId}`)));
  const needsSharedAccess = input.purpose === "view" && records.some(photo => photo && photo._openid !== requester);
  let access;
  let visibleMemories = [];
  if (needsSharedAccess) {
    access = await familyAccess(input.familyId, requester);
    if (access) visibleMemories = visibleMemoriesForAccess(await loadAll("memories", { familyId: input.familyId }), access);
  }
  const results = records.map((photo, index) => {
    const hidden = input.purpose === "view" && photo && photo._openid !== requester && !access;
    return publicPhoto(hidden ? undefined : photo, { ...input, photoId: input.photoIds[index] }, requester, visibleMemories);
  });
  const urls = await tempUrls(results.filter(result => result.status === "ok").map(result => result.fileID));
  return {
    photos: results.map(result => {
      if (result.status !== "ok") return result;
      const { fileID, ...safe } = result;
      const url = urls[fileID];
      return url ? { ...safe, url } : { photoId: result.photoId, status: "not_uploaded" };
    }),
  };
}

async function moderationResult(event, context) {
  if (!isInternalContext(context) || !process.env.PHOTO_ACCESS_INTERNAL_TOKEN || event.internalToken !== process.env.PHOTO_ACCESS_INTERNAL_TOKEN) {
    throw new PhotoAccessError("FORBIDDEN", "内部调用验证失败");
  }
  const traceId = String(event.traceId || "").trim();
  if (!traceId) throw new PhotoAccessError("INVALID_TRACE", "检测编号无效");
  const response = await db.collection(PHOTOS).where({ "moderation.traceId": traceId }).limit(1).get();
  const photo = response.data[0];
  if (!photo) return { ok: false };
  const suggest = ["pass", "review", "risky"].includes(event.suggest) ? event.suggest : "review";
  await db.collection(PHOTOS).doc(photo._id).update({ data: {
    moderation: { ok: suggest === "pass", suggest, label: event.label, traceId, checkedAtMs: Date.now() },
  } });
  return { ok: true };
}

async function retryModeration() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  const response = await db.collection(PHOTOS).where({
    deletedAt: _.exists(false),
    "moderation.ok": false,
  }).limit(10).get();
  let submitted = 0;
  for (const photo of response.data) {
    if (photo.moderation && photo.moderation.submittedAtMs > cutoff) continue;
    try {
      await submitModeration(photo, photo._openid);
      submitted += 1;
    } catch (error) {
      console.warn("照片内容检测重试失败", error);
    }
  }
  return { submitted };
}

async function main(event = {}) {
  await ensureCollection();
  const context = cloud.getWXContext();
  if (event.Type === "Timer" || context.SOURCE === "wx_trigger") return retryModeration();
  try {
    if (event.action === "register") return await register(event, context);
    if (event.action === "read") return await read(event, context);
    if (event.action === "moderationResult") return await moderationResult(event, context);
    throw new PhotoAccessError("UNKNOWN_ACTION", "不支持的照片操作");
  } catch (error) {
    if (error instanceof PhotoAccessError) return { error: { code: error.code, message: error.message } };
    throw error;
  }
}

module.exports = { main };
