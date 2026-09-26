const cloud = require("wx-server-sdk");
const { createAigcMetadataWriter } = require("./aigcMetadata");
const { StoryImageError, assertUnrestrictedStory, chapterSource, bookSource, draftReferencesStoryImage, textHash } = require("./core");
const { createCoverServices, coverSelectionPatch } = require("./cover");
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
const STORIES = "stories";
const MEMORIES = "memories";
const IMAGE_LINKS = "story_image_links";
const JOB_LINKS = "story_image_job_links";
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
  for (const name of [JOBS, IMAGES, CAPTION_LOGS, IMAGE_LINKS, JOB_LINKS]) {
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

async function loadLinked(collectionName,links,key) {
  const rows=await Promise.all(links.map(link=>getDoc(collectionName,link[key])));
  return rows.filter(Boolean);
}

function uniqueById(rows) {
  return [...new Map(rows.map(row=>[row._id,row])).values()];
}

function withoutId(data) {
  const { _id, ...rest } = data;
  return rest;
}

async function getTransactionDoc(transaction,collectionName,id) {
  try { return (await transaction.collection(collectionName).doc(id).get()).data; }
  catch(error) { if(isMissing(error))return undefined; throw error; }
}

const repo = {
  async listStoryMemories(familyId, story) {
    const ids = [...new Set(Array.isArray(story?.memoryIds) ? story.memoryIds : [])]
      .filter(id => typeof id === "string" && id.length <= 120);
    const rows = await Promise.all(ids.map(id => getDoc(MEMORIES, `${familyId}_${id}`)));
    return rows.filter(memory => memory?.familyId === familyId && !memory.deletedAt &&
      !memory.sourcePolicyRequired && !memory.sourceIds);
  },
  async listStoryPhotoIds(familyId, storyId, current) {
    const ids = new Set((current.draft.chapters || []).flatMap(chapter => (chapter.content || []).map(item => item.photoId)));
    for (const id of current.story.memoryIds || []) {
      const memory = await getDoc("memories", `${familyId}_${id}`);
      if (memory?.familyId === familyId && !memory.deletedAt && !memory.sourcePolicyRequired && !memory.sourceIds) {
        for (const photoId of memory.photoIds || []) ids.add(photoId);
      }
    }
    return [...ids].filter(id => typeof id === "string" && /^photo-[0-9a-z-]{1,80}$/.test(id) && !id.startsWith("photo-ai-"));
  },
  async setStoryCover({familyId, storyId, imageId, expectedVersion}) {
    return db.runTransaction(async transaction => {
      const key = `${familyId}_${storyId}`;
      const story = await getTransactionDoc(transaction, STORIES, key);
      const image = imageId ? await getTransactionDoc(transaction, IMAGES, imageId) : undefined;
      const patch = coverSelectionPatch(story, image, {familyId, storyId, imageId, expectedVersion});
      if (patch) await transaction.collection(STORIES).doc(key).update({data:patch});
      return {ok:true, coverImageId:imageId};
    });
  },
  getJob: id => getDoc(JOBS, id),
  createJob: (id, data) => db.collection(JOBS).doc(id).set({ data: withoutId(data) }),
  async createJobForActiveStory(id,data) {
    return db.runTransaction(async transaction=>{
      const existing=await getTransactionDoc(transaction,JOBS,id);
      if(existing)return existing;
      const story=await getTransactionDoc(transaction,STORIES,`${data.familyId}_${data.storyId}`);
      if(!story || story.familyId!==data.familyId || story.deletedAt)throw new StoryImageError("STORY_NOT_FOUND","这本故事书已不可用，请返回书架");
      if(story.currentRevisionId!==data.sourceRevisionId)throw new StoryImageError("REVISION_CHANGED","书稿版本已经变化，请重新配图");
      const record=await getTransactionDoc(transaction,DRAFTS,`${data.familyId}_${data.sourceRevisionId}`);
      if(record?.familyId!==data.familyId||record.storyId!==data.storyId||record.revision?.id!==data.sourceRevisionId||record.revision.storyId!==data.storyId)
        throw new StoryImageError("STORY_NOT_FOUND","这本故事书已不可用，请返回书架");
      assertUnrestrictedStory(story,record.revision.draft);
      await transaction.collection(JOBS).doc(id).set({data:withoutId(data)});
      return undefined;
    });
  },
  async getActiveStoryDraft(familyId,storyId) {
    const story=await getDoc(STORIES,`${familyId}_${storyId}`);
    if(!story||story.familyId!==familyId||story.deletedAt||typeof story.currentRevisionId!=='string')return undefined;
    const record=await getDoc(DRAFTS,`${familyId}_${story.currentRevisionId}`);
    if(record?.familyId!==familyId||record.storyId!==storyId||record.revision?.id!==story.currentRevisionId||record.revision.storyId!==storyId)return undefined;
    return {story,revision:record.revision,draft:record.revision.draft};
  },
  async assertStoryImageSource(job) {
    return db.runTransaction(async transaction=>{
      const story=await getTransactionDoc(transaction,STORIES,`${job.familyId}_${job.storyId}`);
      if(!story||story.familyId!==job.familyId||story.deletedAt)throw new StoryImageError("STORY_NOT_FOUND","这本故事书已不可用，请返回书架");
      if(story.currentRevisionId!==job.sourceRevisionId)throw new StoryImageError("REVISION_CHANGED","书稿版本已经变化，请重新配图");
      const record=await getTransactionDoc(transaction,DRAFTS,`${job.familyId}_${job.sourceRevisionId}`);
      if(record?.familyId!==job.familyId||record.storyId!==job.storyId||record.revision?.id!==job.sourceRevisionId||record.revision.storyId!==job.storyId)
        throw new StoryImageError("STORY_NOT_FOUND","这本故事书已不可用，请返回书架");
      assertUnrestrictedStory(story,record.revision.draft);
      const memories = await repo.listStoryMemories(job.familyId, story);
      const source=job.purpose === "cover" ? bookSource(record.revision.draft, memories) : chapterSource(record.revision.draft,job.chapterId, memories);
      if((source.fullTextHash || textHash(source.text))!==job.source?.textHash)throw new StoryImageError("REVISION_CHANGED","章节内容已经变化，请重新配图");
      if(job.source?.photoHash && source.photoHash!==job.source.photoHash)throw new StoryImageError("REVISION_CHANGED","章节照片已经变化，请重新配图");
      if(job.source?.storyImageReferenceHash && source.storyImageReferenceHash!==job.source.storyImageReferenceHash)throw new StoryImageError("REVISION_CHANGED","章节插图已经变化，请重新配图");
    });
  },
  async isActiveStory(familyId,storyId) {
    const story=await getDoc(STORIES,`${familyId}_${storyId}`);
    return Boolean(story && story.familyId===familyId && !story.deletedAt);
  },
  async isImageLinkedToStory(familyId,storyId,imageId) {
    const rows=await loadAll(IMAGE_LINKS,{familyId,storyId,imageId});return rows.length>0;
  },
  async isJobLinkedToStory(familyId,storyId,jobId) {
    const rows=await loadAll(JOB_LINKS,{familyId,storyId,jobId});return rows.length>0;
  },
  async listImageStoryIds(familyId,imageId) {
    return [...new Set((await loadAll(IMAGE_LINKS,{familyId,imageId})).map(link=>link.storyId).filter(Boolean))];
  },
  updateJob: (id, patch) => db.collection(JOBS).doc(id).update({ data: patch }),
  async claimJob(id, fromStatuses, patch) {
    const response = await db.collection(JOBS).where({ _id: id, status: _.in(fromStatuses) }).update({ data: patch });
    return Boolean(response && response.stats && response.stats.updated === 1);
  },
  async countJobs({ familyId, memberId, storyId, dayKey, statuses }) {
    const where = { familyId, status: _.in(statuses) };
    if (memberId) where.memberId = memberId;
    if (storyId) where.storyId = storyId;
    if (dayKey) where.dayKey = dayKey;
    const response = await db.collection(JOBS).where(where).count();
    return response.total;
  },
  listDraftRecords: (familyId, memberId) => loadAll(DRAFTS, { familyId, memberId }),
  listStoryDraftRecords: (familyId, storyId) => loadAll(DRAFTS, { familyId, storyId, draftType: "story-revision" }),
  createImage: (id, data) => db.collection(IMAGES).doc(id).set({ data }),
  getImage: id => getDoc(IMAGES, id),
  updateImage: (id, patch) => db.collection(IMAGES).doc(id).update({ data: patch }),
  async softDeleteImage(id,{familyId,storyIds,nowMs}) {
    return db.runTransaction(async transaction=>{
      const image=await getTransactionDoc(transaction,IMAGES,id);
      if(!image || image.familyId!==familyId || image.deletedAtMs!==undefined)return "missing";
      for(const storyId of storyIds || []) {
        const story=await getTransactionDoc(transaction,STORIES,`${familyId}_${storyId}`);
        if(story?.coverImageId===id)return "referenced";
        if(story?.currentRevisionId) {
          const record=await getTransactionDoc(transaction,DRAFTS,`${familyId}_${story.currentRevisionId}`);
          if(draftReferencesStoryImage(record?.revision?.draft,id))return "referenced";
        }
      }
      await transaction.collection(IMAGES).doc(id).update({data:{deletedAtMs:nowMs}});
      return "deleted";
    });
  },
  listImages: (familyId, memberId) => loadAll(IMAGES, { familyId, memberId, deletedAtMs: _.exists(false) }),
  listRecentJobs: (familyId, memberId, sinceMs) => loadAll(JOBS, { familyId, memberId, createdAtMs: _.gte(sinceMs) }),
  async listStoryImages(familyId, storyId) {
    const [direct,links]=await Promise.all([
      loadAll(IMAGES,{familyId,storyId,deletedAtMs:_.exists(false)}),
      loadAll(IMAGE_LINKS,{familyId,storyId}),
    ]);
    const linked=await loadLinked(IMAGES,links,'imageId');
    return uniqueById([...direct,...linked]).filter(image=>image.familyId===familyId && image.deletedAtMs===undefined);
  },
  async listRecentStoryJobs(familyId, storyId, sinceMs) {
    const [direct,links]=await Promise.all([
      loadAll(JOBS,{familyId,storyId,createdAtMs:_.gte(sinceMs)}),
      loadAll(JOB_LINKS,{familyId,storyId}),
    ]);
    const linked=await loadLinked(JOBS,links,'jobId');
    return uniqueById([...direct,...linked]).filter(job=>job.familyId===familyId && Number(job.createdAtMs)>=sinceMs);
  },
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
const aigcMetadata = createAigcMetadataWriter({ contentProducer: process.env.AIGC_CONTENT_PRODUCER });

// Photos are read only through photoAccess, which owns the permission check (problem nine).
const photoReader = createPhotoReader({
  callFunction: options => cloud.callFunction(options),
  internalToken: process.env.PHOTO_ACCESS_INTERNAL_TOKEN,
});
const coverServices = createCoverServices({repo, storage, readPhotos: input => photoReader.read(input)});
// Optional user art directions are checked before a paid image job is queued.
const textChecker = createTextChecker({ msgSecCheck: request => cloud.openapi.security.msgSecCheck(request) });
const handlers = createStoryImageHandlers({
  repo, provider, extractScene, sceneConfigured, storage, moderation, downloadImage, aigcMetadata, qualityChecker, referenceAnalyzer, coverServices, textChecker, readPhotos: input => photoReader.read(input),
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
const captionVision = createVisionClient({
  apiKey: process.env.VISION_API_KEY || tokenHubKey,
  model: process.env.VISION_MODEL,
  baseUrl: process.env.VISION_BASE_URL,
});
// Text checks go through problem three's shared contentSecurityCheck function.
const captions = createCaptionHandler({
  repo,
  vision: { ...captionVision, model: process.env.VISION_MODEL || "hy-vision-2.0-instruct" },
  readPhotos: input => photoReader.read(input),
  checkText: input => textChecker.check(input),
});
const diagnostics = createDiagnostics({
  repo, provider, extractScene, sceneConfigured, storage, moderation, downloadImage, aigcMetadata, qualityChecker,
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
      case "capabilities": return { apiVersion: 5, referenceIllustration: referenceAnalyzer.configured, referencePhotos: referenceAnalyzer.configured, guidedGeneration: true, bookCover: true };
      case "coverSources": return await coverServices.sources(ctx, event);
      case "selectCover": return await coverServices.select(ctx, event);
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
