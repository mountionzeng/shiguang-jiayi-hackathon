const cloud = require("wx-server-sdk");
const { StoryImageError } = require("./core");
const { createCaptionHandler } = require("./caption");
const { createDiagnostics } = require("./diagnostics");
const { createStoryImageHandlers } = require("./flow");
const { createQualityChecker } = require("./quality");
const { createPhotoReader } = require("./photoReader");
const { createReferenceAnalyzer } = require("./reference");
const { createSceneExtractor } = require("./scene");
const { createTextChecker } = require("./textCheck");
const { createTokenHubImageClient, downloadResult, IMAGE_MODEL } = require("./tokenhub");
const { createVisionClient } = require("./vision");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const JOBS = "image_jobs";
const IMAGES = "story_images";
const CAPTION_LOGS = "photo_caption_logs";
const DRAFTS = "biography_drafts";
const ACTIVE_STATUSES = ["submitted", "queued", "generating", "generated", "storing"];

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
  for (const name of [JOBS, IMAGES, CAPTION_LOGS]) {
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
  getCaptionLog: id => getDoc(CAPTION_LOGS, id),
  createCaptionLog: (id, data) => db.collection(CAPTION_LOGS).doc(id).set({ data }),
  updateCaptionLog: (id, patch) => db.collection(CAPTION_LOGS).doc(id).update({ data: patch }),
  async countCaptionLogs({ requesterOpenId, dayKey, statuses }) {
    const response = await db.collection(CAPTION_LOGS).where({ requesterOpenId, dayKey, status: _.in(statuses) }).count();
    return response.total;
  },
  async listImagesPendingQuality(limit) {
    const response = await db.collection(IMAGES).where({ quality: "pending", deletedAtMs: _.exists(false) })
      .orderBy("createdAtMs", "asc").limit(limit).get();
    return response.data;
  },
};

const storage = {
  async upload(cloudPath, buffer) {
    const response = await cloud.uploadFile({ cloudPath, fileContent: buffer });
    return response.fileID;
  },
  async tempUrls(fileIDs, maxAge = 2 * 60 * 60) {
    const urls = {};
    for (let index = 0; index < fileIDs.length; index += 50) {
      const response = await cloud.getTempFileURL({
        fileList: fileIDs.slice(index, index + 50).map(fileID => ({ fileID, maxAge })),
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

const tokenHubKey = process.env.TOKENHUB_API_KEY;
const imageClient = createTokenHubImageClient({ apiKey: tokenHubKey, baseUrl: process.env.TOKENHUB_BASE_URL });
const provider = {
  name: "tokenhub",
  model: IMAGE_MODEL,
  configured: imageClient.configured,
  generate: input => imageClient.generate(input),
};
const extractScene = createSceneExtractor({
  apiKey: process.env.AI_API_KEY,
  model: process.env.AI_MODEL,
  baseUrl: process.env.AI_BASE_URL,
});
const sceneConfigured = Boolean(process.env.AI_API_KEY && process.env.AI_MODEL);
// The same TokenHub key serves the vision model unless a separate one is set.
const qualityChecker = createQualityChecker({
  apiKey: process.env.VISION_API_KEY || tokenHubKey,
  model: process.env.VISION_MODEL,
  baseUrl: process.env.VISION_BASE_URL,
});
const referenceAnalyzer = createReferenceAnalyzer({
  apiKey: process.env.VISION_API_KEY || tokenHubKey,
  model: process.env.VISION_MODEL,
  baseUrl: process.env.VISION_BASE_URL,
});
const downloadImage = url => downloadResult(url);

const handlers = createStoryImageHandlers({
  repo, provider, extractScene, sceneConfigured, storage, moderation, downloadImage, qualityChecker, referenceAnalyzer,
  async forwardPhotoModeration({ traceId, suggest, label }) {
    const response = await cloud.callFunction({
      name: "photoAccess",
      data: {
        action: "moderationResult",
        traceId,
        suggest,
        label,
        internalToken: process.env.PHOTO_ACCESS_INTERNAL_TOKEN,
      },
    });
    const result = response && response.result;
    if (!result || typeof result !== "object" || result.error || result.ok !== true) {
      throw new Error(String((result && result.error && (result.error.code || result.error.message)) || "PHOTO_MODERATION_FORWARD_FAILED"));
    }
  },
});
// Photos are read only through photoAccess, which owns the permission check (problem nine).
const photoReader = createPhotoReader({
  callFunction: options => cloud.callFunction(options),
  internalToken: process.env.PHOTO_ACCESS_INTERNAL_TOKEN,
});
const captionVision = createVisionClient({
  apiKey: process.env.VISION_API_KEY || tokenHubKey,
  model: process.env.VISION_MODEL,
  baseUrl: process.env.VISION_BASE_URL,
});
// Text checks go through problem three's shared contentSecurityCheck function.
const textChecker = createTextChecker({ callFunction: options => cloud.callFunction(options) });
const captions = createCaptionHandler({
  repo,
  vision: { ...captionVision, model: process.env.VISION_MODEL || "hy-vision-2.0-instruct" },
  readPhotos: input => photoReader.read(input),
  checkText: input => textChecker.check(input),
});
const diagnostics = createDiagnostics({
  repo, provider, extractScene, sceneConfigured, storage, moderation, downloadImage, qualityChecker,
  expectedToken: process.env.STORY_IMAGES_DIAGNOSE_TOKEN,
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
      case "capabilities": return { apiVersion: 2, referenceIllustration: referenceAnalyzer.configured };
      case "submit": return await handlers.submit(ctx, event);
      case "status": return await handlers.status(ctx, event);
      case "list": return await handlers.list(ctx, event);
      case "remove": return await handlers.remove(ctx, event);
      // 看图写一句话: the client asks for the separate photo-to-AI consent before calling.
      case "caption": return await captions.caption(ctx, event);
      // Guarded by STORY_IMAGES_DIAGNOSE_TOKEN; meant for the developer tools' cloud test.
      case "diagnose": return await diagnostics.run(ctx, event);
      default: throw new StoryImageError("UNKNOWN_ACTION", "不支持的操作");
    }
  } catch (error) {
    if (error instanceof StoryImageError) return { error: { code: error.code, message: error.message } };
    throw error;
  }
}

module.exports = { main };
