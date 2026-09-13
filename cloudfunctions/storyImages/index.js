const cloud = require("wx-server-sdk");
const { StoryImageError } = require("./core");
const { createStoryImageHandlers } = require("./flow");
const { createHunyuanClient, downloadResult } = require("./hunyuan");
const { createQualityChecker } = require("./quality");
const { createSceneExtractor } = require("./scene");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const JOBS = "image_jobs";
const IMAGES = "story_images";
const DRAFTS = "biography_drafts";
const ACTIVE_STATUSES = ["submitted", "running", "storing"];

function errorMessage(error) {
  return String(error && error.errMsg ? error.errMsg : error);
}

function isExisting(error) {
  return /already exists|ResourceExist|COLLECTION_(ALREADY_)?EXIST|Table exist/i.test(errorMessage(error));
}

function isMissing(error) {
  return /does not exist|not found|cannot find document|Table not exist/i.test(errorMessage(error));
}

let collectionsReady = false;
async function ensureCollections() {
  if (collectionsReady) return;
  for (const name of [JOBS, IMAGES]) {
    try {
      await db.createCollection(name);
    } catch (error) {
      if (!isExisting(error)) throw error;
    }
  }
  collectionsReady = true;
}

async function getDoc(collectionName, id) {
  try {
    const response = await db.collection(collectionName).doc(id).get();
    return response.data;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function loadAll(collectionName, where) {
  const rows = [];
  for (let offset = 0; ; offset += 20) {
    const response = await db.collection(collectionName).where(where)
      .orderBy("_id", "asc").skip(offset).limit(20).get();
    rows.push(...response.data);
    if (response.data.length < 20) return rows;
  }
}

function withoutId(data) {
  const { _id, ...rest } = data;
  return rest;
}

const repo = {
  getJob: id => getDoc(JOBS, id),
  createJob: (id, data) => db.collection(JOBS).doc(id).set({ data: withoutId(data) }),
  updateJob: (id, patch) => db.collection(JOBS).doc(id).update({ data: patch }),
  async claimJob(id, fromStatuses, patch) {
    const response = await db.collection(JOBS).where({ _id: id, status: _.in(fromStatuses) }).update({ data: patch });
    return Boolean(response && response.stats && response.stats.updated === 1);
  },
  async countJobs({ familyId, memberId, dayKey, statuses }) {
    const where = { familyId, status: _.in(statuses) };
    if (memberId) where.memberId = memberId;
    if (dayKey) where.dayKey = dayKey;
    const response = await db.collection(JOBS).where(where).count();
    return response.total;
  },
  listDraftRecords: (familyId, memberId) => loadAll(DRAFTS, { familyId, memberId }),
  createImage: (id, data) => db.collection(IMAGES).doc(id).set({ data }),
  getImage: id => getDoc(IMAGES, id),
  updateImage: (id, patch) => db.collection(IMAGES).doc(id).update({ data: patch }),
  listImages: (familyId, memberId) => loadAll(IMAGES, { familyId, memberId, deletedAtMs: _.exists(false) }),
  listRecentJobs: (familyId, memberId, sinceMs) => loadAll(JOBS, { familyId, memberId, createdAtMs: _.gte(sinceMs) }),
  async findImageByTrace(traceId) {
    const response = await db.collection(IMAGES).where({ moderationTraceId: traceId }).limit(1).get();
    return response.data[0];
  },
  async listActiveJobs(limit) {
    const response = await db.collection(JOBS).where({ status: _.in(ACTIVE_STATUSES) })
      .orderBy("updatedAtMs", "asc").limit(limit).get();
    return response.data;
  },
};

const storage = {
  async upload(cloudPath, buffer) {
    const response = await cloud.uploadFile({ cloudPath, fileContent: buffer });
    return response.fileID;
  },
  async tempUrls(fileIDs) {
    const urls = {};
    for (let index = 0; index < fileIDs.length; index += 50) {
      const response = await cloud.getTempFileURL({
        fileList: fileIDs.slice(index, index + 50).map(fileID => ({ fileID, maxAge: 2 * 60 * 60 })),
      });
      for (const item of response.fileList || []) {
        if (item.tempFileURL) urls[item.fileID] = item.tempFileURL;
      }
    }
    return urls;
  },
  async remove(fileIDs) {
    if (fileIDs.length) await cloud.deleteFile({ fileList: fileIDs });
  },
};

const moderation = {
  async check({ fileID, openid }) {
    const url = (await storage.tempUrls([fileID]))[fileID];
    if (!url) throw new Error("TEMP_URL_UNAVAILABLE");
    const response = await cloud.openapi.security.mediaCheckAsync({
      mediaUrl: url,
      mediaType: 2,
      version: 2,
      scene: 1,
      openid,
    });
    const traceId = String((response && (response.traceId || response.trace_id)) || "");
    if (!traceId) throw new Error("MEDIA_CHECK_NO_TRACE_ID");
    return traceId;
  },
};

const hunyuan = process.env.HUNYUAN_SECRET_ID && process.env.HUNYUAN_SECRET_KEY
  ? createHunyuanClient({
    secretId: process.env.HUNYUAN_SECRET_ID,
    secretKey: process.env.HUNYUAN_SECRET_KEY,
    region: process.env.HUNYUAN_REGION || "ap-guangzhou",
  })
  : undefined;

const handlers = createStoryImageHandlers({
  repo,
  provider: {
    name: "hunyuan",
    model: "hunyuan-image-3.0",
    configured: Boolean(hunyuan),
    submit: input => hunyuan.submit(input),
    query: providerJobId => hunyuan.query(providerJobId),
  },
  extractScene: createSceneExtractor({
    apiKey: process.env.AI_API_KEY,
    model: process.env.AI_MODEL,
    baseUrl: process.env.AI_BASE_URL,
  }),
  sceneConfigured: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL),
  storage,
  moderation,
  downloadImage: url => downloadResult(url),
  qualityChecker: createQualityChecker({
    apiKey: process.env.VISION_API_KEY,
    model: process.env.VISION_MODEL,
    baseUrl: process.env.VISION_BASE_URL,
  }),
});

async function main(event = {}) {
  const context = cloud.getWXContext();
  if (event.Type === "Timer" || context.SOURCE === "wx_trigger") {
    await ensureCollections();
    return handlers.sweep();
  }
  if (event.MsgType === "event" && event.Event === "wxa_media_check") {
    // Only WeChat's message push may report a check result; a client call must not.
    if (context.SOURCE === "wx_client" || context.SOURCE === "wx_devtools") throw new Error("FORBIDDEN");
    return handlers.moderationResult(event);
  }

  await ensureCollections();
  const ctx = { openid: String(context.OPENID || "").trim() };
  try {
    switch (event.action) {
      case "submit": return await handlers.submit(ctx, event);
      case "status": return await handlers.status(ctx, event);
      case "list": return await handlers.list(ctx, event);
      case "remove": return await handlers.remove(ctx, event);
      default: throw new StoryImageError("UNKNOWN_ACTION", "不支持的操作");
    }
  } catch (error) {
    if (error instanceof StoryImageError) return { error: { code: error.code, message: error.message } };
    throw error;
  }
}

module.exports = { main };
