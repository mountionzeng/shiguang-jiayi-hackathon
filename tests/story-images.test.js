const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const core = require("../cloudfunctions/storyImages/core.js");
const tokenhub = require("../cloudfunctions/storyImages/tokenhub.js");
const scene = require("../cloudfunctions/storyImages/scene.js");
const quality = require("../cloudfunctions/storyImages/quality.js");
const reference = require("../cloudfunctions/storyImages/reference.js");
const { createStoryImageHandlers } = require("../cloudfunctions/storyImages/flow.js");

const OWNER_OPENID = "o-owner";
const FAMILY = "family_o-owner";
const T0 = Date.parse("2026-09-13T02:00:00.000Z");

function revisionRecord({ id, savedAt, memberId = "owner", chapters }) {
  return {
    familyId: FAMILY,
    memberId,
    draftType: "manuscript-revision",
    revision: {
      id,
      memberId,
      savedAt,
      draft: { title: "", paragraphs: [], sourceCount: 0, generatedAt: "", generationMode: "cloud-ai", chapters },
    },
  };
}

const CHAPTER = {
  id: "chapter-1",
  title: "老院子",
  memoryIds: [],
  content: [{ text: "那年冬天，" }, { photoId: "photo-abc" }, { text: "奶奶在院子里晒被子。" }],
};

function aigcMetadataFake(calls) {
  return {
    configured: true,
    produceIdFor(sourceId) { return `aigc-${sourceId.length}`; },
    write(buffer, contentType, produceId) {
      calls.aigc.push({ buffer: Buffer.from(buffer), contentType, produceId });
      return { buffer: Buffer.concat([buffer, Buffer.from("-with-aigc")]), contentType, produceId };
    },
    writeForSource(buffer, contentType, sourceId) {
      return this.write(buffer, contentType, this.produceIdFor(sourceId));
    },
  };
}

function memoryRepo() {
  const jobs = new Map();
  const images = new Map();
  const stories = new Map();
  const memories = new Map();
  const imageLinks = new Map();
  const jobLinks = new Map();
  let drafts = [];
  return {
    jobs,
    images,
    stories,
    memories,
    imageLinks,
    jobLinks,
    beforeSoftDelete: undefined,
    setDrafts(records) {
      drafts = records;
      for(const record of records.filter(item=>item.storyId && item.revision)) {
        const current=stories.get(record.storyId);
        if(!current || String(record.revision.savedAt).localeCompare(String(current.savedAt || ''))>=0)stories.set(record.storyId,{familyId:record.familyId,id:record.storyId,currentRevisionId:record.revision.id,savedAt:record.revision.savedAt});
      }
    },
    setStory(storyId,patch={}) { stories.set(storyId,{familyId:FAMILY,id:storyId,...stories.get(storyId),...patch}); },
    setMemory(id,patch={}) { memories.set(id,{familyId:FAMILY,id,...memories.get(id),...patch}); },
    async listStoryMemories(familyId,story) {
      const ids = new Set(Array.isArray(story?.memoryIds) ? story.memoryIds : []);
      return [...memories.values()].filter(memory => memory.familyId === familyId && ids.has(memory.id) && !memory.deletedAt && !memory.sourcePolicyRequired && !memory.sourceIds);
    },
    linkImage(storyId,imageId) { imageLinks.set(storyId+'|'+imageId,{familyId:FAMILY,storyId,imageId}); },
    linkJob(storyId,jobId) { jobLinks.set(storyId+'|'+jobId,{familyId:FAMILY,storyId,jobId}); },
    async isActiveStory(familyId,storyId) { const story=stories.get(storyId);return Boolean(story && story.familyId===familyId && !story.deletedAt); },
    async isImageLinkedToStory(familyId,storyId,imageId) { return imageLinks.get(storyId+'|'+imageId)?.familyId===familyId; },
    async isJobLinkedToStory(familyId,storyId,jobId) { return jobLinks.get(storyId+'|'+jobId)?.familyId===familyId; },
    async listImageStoryIds(familyId,imageId) { return [...imageLinks.values()].filter(link=>link.familyId===familyId && link.imageId===imageId).map(link=>link.storyId); },
    async getJob(id) { const job = jobs.get(id); return job && { ...job }; },
    async createJob(id, data) { jobs.set(id, { ...data, _id: id }); },
    async createJobForActiveStory(id,data) {
      const existing=jobs.get(id);
      if(existing)return {...existing};
      const story=stories.get(data.storyId);
      if(!story || story.familyId!==data.familyId || story.deletedAt)throw new core.StoryImageError('STORY_NOT_FOUND','这本故事书已不可用，请返回书架');
      if(story.currentRevisionId!==data.sourceRevisionId)throw new core.StoryImageError('REVISION_CHANGED','书稿版本已经变化，请重新配图');
      const record=drafts.find(item=>item.familyId===data.familyId&&item.storyId===data.storyId&&item.revision?.id===data.sourceRevisionId);
      if(!record)throw new core.StoryImageError('STORY_NOT_FOUND','这本故事书已不可用，请返回书架');
      core.assertUnrestrictedStory(story,record.revision.draft);
      jobs.set(id,{...data,_id:id});
      return undefined;
    },
    async updateJob(id, patch) {
      if (!jobs.has(id)) throw new Error("document does not exist");
      jobs.set(id, { ...jobs.get(id), ...patch });
    },
    async claimJob(id, fromStatuses, patch) {
      const job = jobs.get(id);
      if (!job || !fromStatuses.includes(job.status)) return false;
      jobs.set(id, { ...job, ...patch });
      return true;
    },
    async countJobs({ familyId, memberId, storyId, dayKey, statuses }) {
      return [...jobs.values()].filter(job => job.familyId === familyId &&
        (!memberId || job.memberId === memberId) && (!storyId || job.storyId === storyId) && (!dayKey || job.dayKey === dayKey) &&
        statuses.includes(job.status)).length;
    },
    async listDraftRecords(familyId, memberId) {
      return drafts.filter(record => record.familyId === familyId && record.memberId === memberId);
    },
    async listStoryDraftRecords(familyId, storyId) {
      return drafts.filter(record => record.familyId === familyId && record.storyId === storyId);
    },
    async getActiveStoryDraft(familyId,storyId){
      const story=stories.get(storyId);
      const record=drafts.find(item=>item.familyId===familyId&&item.storyId===storyId&&item.revision?.id===story?.currentRevisionId);
      return story&&record?{story:{...story},revision:{...record.revision},draft:structuredClone(record.revision.draft)}:undefined;
    },
    async assertStoryImageSource(job){
      const context=await this.getActiveStoryDraft(job.familyId,job.storyId);
      if(!context)throw new core.StoryImageError('STORY_NOT_FOUND','这本故事书已不可用');
      if(context.revision.id!==job.sourceRevisionId)throw new core.StoryImageError('REVISION_CHANGED','书稿版本已经变化');
      core.assertUnrestrictedStory(context.story,context.draft);
      const memories=await this.listStoryMemories(job.familyId,context.story);
      const source=job.purpose === "cover" ? core.bookSource(context.draft,memories) : core.chapterSource(context.draft,job.chapterId,memories);
      if((source.fullTextHash || core.textHash(source.text))!==job.source?.textHash)
        throw new core.StoryImageError('REVISION_CHANGED','章节内容已经变化');
    },
    async createImage(id, data) { images.set(id, { ...data, _id: id }); },
    async getImage(id) { const image = images.get(id); return image && { ...image }; },
    async updateImage(id, patch) { images.set(id, { ...images.get(id), ...patch }); },
    async softDeleteImage(id,{familyId,storyIds,nowMs}) {
      if(this.beforeSoftDelete)await this.beforeSoftDelete();
      const image=images.get(id);
      if(!image || image.familyId!==familyId || image.deletedAtMs!==undefined)return 'missing';
      for(const storyId of storyIds || []) {
        const story=stories.get(storyId);
        const current=story?.currentRevisionId ? drafts.find(record=>record.revision?.id===story.currentRevisionId) : undefined;
        if(story?.coverImageId===id || core.draftReferencesStoryImage(current?.revision?.draft,id))return 'referenced';
      }
      images.set(id,{...image,deletedAtMs:nowMs});
      return 'deleted';
    },
    async listImages(familyId, memberId) {
      return [...images.values()].filter(image => image.familyId === familyId && image.memberId === memberId &&
        image.deletedAtMs === undefined);
    },
    async listRecentJobs(familyId, memberId, sinceMs) {
      return [...jobs.values()].filter(job => job.familyId === familyId && job.memberId === memberId &&
        job.createdAtMs >= sinceMs);
    },
    async listStoryImages(familyId, storyId) {
      return [...images.values()].filter(image => image.familyId === familyId && image.storyId === storyId && image.deletedAtMs === undefined);
    },
    async listRecentStoryJobs(familyId, storyId, sinceMs) {
      return [...jobs.values()].filter(job => job.familyId === familyId && job.storyId === storyId && job.createdAtMs >= sinceMs);
    },
    async findImageByTrace(traceId) { return [...images.values()].find(image => image.moderationTraceId === traceId); },
    async listActiveJobs(limit) {
      return [...jobs.values()].filter(job => core.ACTIVE_STATUSES.includes(job.status)).slice(0, limit);
    },
    async listImagesPendingQuality(limit) {
      return [...images.values()].filter(image => image.quality === "pending" && image.deletedAtMs === undefined).slice(0, limit);
    },
  };
}

function harness({ provider = {}, deps = {} } = {}) {
  const repo = memoryRepo();
  repo.setDrafts([revisionRecord({ id: "revision-2", savedAt: "2026-09-12T10:00:00.000Z", chapters: [CHAPTER] })]);
  let clock = T0;
  const calls = { scene: [], reference: [], tempUrls: [], generate: [], download: [], aigc: [], upload: [], uploadBuffers: [], remove: [], moderation: [] };
  const handlers = createStoryImageHandlers({
    repo,
    provider: {
      name: "tokenhub",
      model: "hy-image-v3",
      configured: true,
      async generate(input) {
        calls.generate.push(input);
        return { resultUrl: "https://result.example/1.png", revisedPrompt: "短发女孩，浅蓝外套", providerJobId: "tokenhub-1", usageTokens: 1024 };
      },
      ...provider,
    },
    sceneConfigured: true,
    async extractScene(source) {
      calls.scene.push(source);
      return { scene: "冬天的院子里晒着被子", setting: "", objects: ["竹竿", "棉被"], light: "冬日午后", mood: "安静", eraHint: "", figures: [] };
    },
    referenceAnalyzer: {
      configured: true,
      async analyze(url) {
        calls.reference.push(url);
        return { style: "轻柔水彩", palette: ["暖白", "浅蓝"], figures: ["短发女孩，浅蓝外套"], objects: ["红围巾"] };
      },
    },
    aigcMetadata: aigcMetadataFake(calls),
    storage: {
      async upload(cloudPath, buffer) {
        calls.upload.push(cloudPath);
        calls.uploadBuffers.push(Buffer.from(buffer));
        return `cloud://env/${cloudPath}`;
      },
      async tempUrls(fileIDs, maxAge) {
        calls.tempUrls.push({ fileIDs, maxAge });
        return Object.fromEntries(fileIDs.map(id => [id, `https://tmp.example/${encodeURIComponent(id)}`]));
      },
      async remove(fileIDs) { calls.remove.push(...fileIDs); },
    },
    moderation: { async check(input) { calls.moderation.push(input); return "trace-1"; } },
    async downloadImage(url) { calls.download.push(url); return { buffer: Buffer.from("png-bytes"), contentType: "image/png" }; },
    now: () => clock,
    log: { error() {} },
    ...deps,
  });
  return { repo, calls, handlers, tick(ms) { clock += ms; } };
}

const ctx = { openid: OWNER_OPENID };
const submitEvent = (requestId = "req-20260913-abcd1234") => ({
  familyId: FAMILY, memberId: "owner", chapterId: "chapter-1", requestId, purpose: "illustration",
});

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// ---------- TokenHub 出图客户端 ----------

test("TokenHub 出图：同步接口、API Key 鉴权、关闭改写、明确带上 AI 生成水印", async () => {
  let sent;
  const client = tokenhub.createTokenHubImageClient({
    apiKey: "sk-test",
    fetchImpl: async (url, init) => {
      sent = { url, init };
      return jsonResponse(200, {
        id: "4-WandImage-abc", data: [{ url: "https://aigc-image.cos.myqcloud.com/x/result.png", revised_prompt: "改写后" }],
        request_id: "r", tokenhub_usage: { total_tokens: 1024 },
      });
    },
  });
  assert.equal(client.configured, true);
  const result = await client.generate({ prompt: "画面", width: 1024, height: 768, seed: 12345 });
  assert.deepEqual(result, {
    resultUrl: "https://aigc-image.cos.myqcloud.com/x/result.png", revisedPrompt: "改写后", providerJobId: "4-WandImage-abc", usageTokens: 1024,
  });
  assert.equal(sent.url, "https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v3-generation");
  assert.equal(sent.init.method, "POST");
  assert.equal(sent.init.headers.Authorization, "Bearer sk-test");
  assert.deepEqual(JSON.parse(sent.init.body), { model: "hy-image-v3", prompt: "画面", size: "1024x768", seed: 12345, revise: false, footnote: "AI生成" });
  assert.equal(tokenhub.createTokenHubImageClient({ apiKey: "" }).configured, false);
});

test("TokenHub 出图在云函数的 60 秒上限前停止并预留结果落库时间", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../deploy/wechat-cloud.manifest.json"), "utf8"));
  const functionTimeoutMs = manifest.cloudFunctions.storyImages.timeoutSeconds * 1_000;
  assert.equal(functionTimeoutMs, 60_000);
  assert.ok(tokenhub.IMAGE_GENERATE_TIMEOUT_MS >= 50_000);
  assert.ok(tokenhub.IMAGE_GENERATE_TIMEOUT_MS <= functionTimeoutMs - 8_000);
});

test("TokenHub 出图：拒绝的请求带着 HTTP 状态码抛出，成功却没有图片的算不确定", async () => {
  const refused = tokenhub.createTokenHubImageClient({ apiKey: "k", fetchImpl: async () => jsonResponse(422, {}) });
  await assert.rejects(refused.generate({ prompt: "p", width: 1024, height: 768 }), error => error.httpStatus === 422);
  const empty = tokenhub.createTokenHubImageClient({ apiKey: "k", fetchImpl: async () => jsonResponse(200, { data: [] }) });
  await assert.rejects(empty.generate({ prompt: "p", width: 1024, height: 768 }), error => error.httpStatus === undefined && error.message === "TOKENHUB_NO_IMAGE");
  const tooBig = tokenhub.createTokenHubImageClient({ apiKey: "k", fetchImpl: async () => { throw new Error("should not call"); } });
  await assert.rejects(tooBig.generate({ prompt: "p", width: 2048, height: 1024 }), error => error.httpStatus === 400);
  await assert.rejects(tooBig.generate({ prompt: "p", width: 1024, height: 768, seed: 0 }), error => error.httpStatus === 400);
});

test("两种配图尺寸都在 TokenHub 允许的范围内", () => {
  for (const style of Object.values(core.STYLES)) {
    assert.ok(style.width >= 512 && style.width <= 2048 && style.height >= 512 && style.height <= 2048);
    assert.ok(style.width * style.height <= tokenhub.MAX_IMAGE_AREA);
  }
});

test("结果图链接失效时标记为过期，并按文件魔数识别格式而不信响应头", async () => {
  await assert.rejects(
    tokenhub.downloadResult("https://x/1.png", { fetchImpl: async () => ({ ok: false, status: 403 }) }),
    error => error.expired === true,
  );
  await assert.rejects(
    tokenhub.downloadResult("https://x/1.png", { fetchImpl: async () => ({ ok: false, status: 502 }) }),
    error => !error.expired,
  );
  const image = await tokenhub.downloadResult("https://x/1.png", {
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer,
    }),
  });
  assert.equal(image.contentType, "image/jpeg");
  assert.equal(image.buffer.length, 4);
  let downloadOptions;
  const webp = await tokenhub.downloadResult("https://x/2", {
    fetchImpl: async (_url, options) => {
      downloadOptions = options;
      return ({
      ok: true, status: 200,
      headers: { get: () => "application/octet-stream" },
      arrayBuffer: async () => Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBP", "binary"),
      });
    },
  });
  assert.equal(webp.contentType, "image/webp");
  assert.equal(downloadOptions.headers.Accept, "image/png,image/jpeg");
  await assert.rejects(
    tokenhub.downloadResult("https://x/3", {
      fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
    }),
    /RESULT_IMAGE_TYPE_UNSUPPORTED/,
  );
});

test("出图失败的结局：审核拦截、明确拒绝不占名额；超时、服务端错误算不确定", () => {
  assert.deepEqual(core.classifyGenerateError({ httpStatus: 422 }), { status: "blocked", errorCode: "CONTENT_BLOCKED" });
  assert.deepEqual(core.classifyGenerateError({ httpStatus: 429 }), { status: "failed", errorCode: "HTTP_429" });
  assert.deepEqual(core.classifyGenerateError({ httpStatus: 401 }), { status: "failed", errorCode: "HTTP_401" });
  assert.deepEqual(core.classifyGenerateError({ httpStatus: 500 }), { status: "unknown", errorCode: "HTTP_500" });
  assert.deepEqual(core.classifyGenerateError({ name: "AbortError" }), { status: "unknown", errorCode: "GENERATE_TIMEOUT" });
  assert.deepEqual(core.classifyGenerateError(new Error("TOKENHUB_NO_IMAGE")), { status: "unknown", errorCode: "GENERATE_UNCERTAIN" });
  assert.equal(core.MESSAGES.failed, "没画成，这次不占名额，可以再试一次");
  assert.equal(core.MESSAGES.unknown, "不确定有没有画成，可能已经扣费");
});

// ---------- 校验与提示词 ----------

test("只有记忆之家的主人能生成配图", () => {
  assert.doesNotThrow(() => core.requireOwner(OWNER_OPENID, FAMILY));
  assert.throws(() => core.requireOwner("o-guest", FAMILY), error => error.code === "NOT_FAMILY_OWNER");
  assert.throws(() => core.requireOwner("", FAMILY), error => error.code === "OPENID_NOT_AVAILABLE");
});

test("章节插图和底图都能提交，封面要等故事有稳定编号", () => {
  assert.equal(core.normalizeSubmitInput(submitEvent()).purpose, "illustration");
  assert.equal(core.normalizeSubmitInput({ ...submitEvent(), purpose: "backdrop" }).purpose, "backdrop");
  assert.throws(() => core.normalizeSubmitInput({ ...submitEvent(), purpose: "cover" }), error => error.code === "INVALID_STORY");
  assert.throws(() => core.normalizeSubmitInput({ ...submitEvent(), purpose: "poster" }), error => error.code === "INVALID_PURPOSE");
  assert.throws(() => core.normalizeSubmitInput({ ...submitEvent(), requestId: "../x" }), error => error.code === "INVALID_REQUEST");
  const referenceImageId = `${FAMILY}_img_req-20260913-old00001`;
  assert.equal(core.normalizeSubmitInput({ ...submitEvent(), referenceImageId }).referenceImageId, referenceImageId);
  assert.throws(() => core.normalizeSubmitInput({ ...submitEvent(), referenceImageId: "../x" }), error => error.code === "INVALID_REFERENCE_IMAGE");
  assert.throws(() => core.normalizeSubmitInput({ ...submitEvent(), purpose: "backdrop", referenceImageId }), error => error.code === "INVALID_REFERENCE_PURPOSE");
});

test("章节正文取这个档案最新保存的版本，只读文字，不读照片引用", () => {
  const records = [
    revisionRecord({ id: "revision-1", savedAt: "2026-09-10T00:00:00.000Z", chapters: [{ ...CHAPTER, content: [{ text: "旧版本" }] }] }),
    revisionRecord({ id: "revision-2", savedAt: "2026-09-12T00:00:00.000Z", chapters: [CHAPTER] }),
    revisionRecord({ id: "revision-9", savedAt: "2026-09-13T00:00:00.000Z", memberId: "someone-else", chapters: [] }),
  ];
  const source = core.chapterSource(core.latestDraftForMember(records, "owner"), "chapter-1");
  assert.equal(source.title, "老院子");
  assert.equal(source.text, "那年冬天，奶奶在院子里晒被子。");
  assert.ok(!source.text.includes("photo-abc"));
  assert.throws(() => core.chapterSource(core.latestDraftForMember(records, "owner"), "chapter-x"), error => error.code === "CHAPTER_NOT_FOUND");
  assert.throws(
    () => core.chapterSource({ chapters: [{ id: "c", content: [{ photoId: "photo-abc" }] }] }, "c"),
    error => error.code === "CHAPTER_EMPTY",
  );
  const personal = [{ familyId: FAMILY, memberId: "owner", draftType: "personal", draft: { chapters: [CHAPTER] } }];
  assert.equal(core.latestDraftForMember(personal, "owner").chapters[0].id, "chapter-1");
});

test("故事配图只读指定 storyId 的最新版本", async () => {
  const h = harness();
  const storyId = "story-book-a";
  h.repo.setDrafts([{
    familyId: FAMILY, storyId, draftType: "story-revision",
    revision: { id: "revision-story-a", storyId, savedAt: "2026-09-17T00:00:00Z", draft: { chapters: [CHAPTER] } },
  }, {
    familyId: FAMILY, storyId: "story-book-b", draftType: "story-revision",
    revision: { id: "revision-story-b", storyId: "story-book-b", savedAt: "2026-09-18T00:00:00Z", draft: { chapters: [{ ...CHAPTER, content: [{ text: "另一本书" }] }] } },
  }]);
  const event = { familyId: FAMILY, storyId, chapterId: CHAPTER.id, requestId: "req-story-a-00000001", purpose: "illustration" };
  const { job } = await h.handlers.submit(ctx, event);
  assert.equal(job.chapterId, CHAPTER.id);
  assert.equal(h.repo.jobs.get(`${FAMILY}_${event.requestId}`).storyId, storyId);
  assert.equal(h.calls.scene[0].text, "那年冬天，奶奶在院子里晒被子。");
  assert.deepEqual((await h.handlers.list(ctx, { familyId: FAMILY, storyId })).pending.map(item => item.jobId), [`${FAMILY}_${event.requestId}`]);
  await assert.rejects(h.handlers.status(ctx,{familyId:FAMILY,storyId:"story-book-b",jobId:`${FAMILY}_${event.requestId}`}),error=>error.code==="JOB_NOT_FOUND");
});

test("故事配图在排队及事务写入前拒绝来源稿",async()=>{
  for(const marker of ['story','draft']){
    const h=harness(),storyId="story-book-a";
    const draft={chapters:[CHAPTER],...(marker==='draft'?{provenanceVersion:1}:{})};
    h.repo.setDrafts([{familyId:FAMILY,storyId,draftType:"story-revision",revision:{id:"revision-source",storyId,savedAt:"2026-09-18",draft}}]);
    if(marker==='story')h.repo.setStory(storyId,{sourcePolicyRequired:true});
    const event={familyId:FAMILY,storyId,chapterId:CHAPTER.id,requestId:"req-source-"+marker+"-0001",purpose:"illustration"};
    await assert.rejects(h.handlers.submit(ctx,event),error=>error.code==="STORY_PROTOCOL_REQUIRED");
    assert.equal(h.calls.scene.length,0);
    assert.equal(h.repo.jobs.size,0);
  }
});

test("已经排队的故事在付费出图前重新检查来源状态",async()=>{
  const h=harness(),storyId="story-book-a";
  h.repo.setDrafts([{familyId:FAMILY,storyId,draftType:"story-revision",
    revision:{id:"revision-before-source",storyId,savedAt:"2026-09-18",draft:{chapters:[CHAPTER]}}}]);
  const event={familyId:FAMILY,storyId,chapterId:CHAPTER.id,requestId:"req-late-source-0001",purpose:"illustration"};
  const submitted=await h.handlers.submit(ctx,event);
  assert.equal(submitted.job.status,"queued");
  h.repo.setStory(storyId,{sourcePolicyRequired:true});
  const result=await h.handlers.status(ctx,{familyId:FAMILY,storyId,jobId:`${FAMILY}_${event.requestId}`});
  assert.equal(result.job.status,"failed");
  assert.equal(h.calls.generate.length,0);
});

test("长章节前 4000 字不变、后半段改动时，付费出图前拒绝旧请求", async () => {
  const h = harness(), storyId = "story-long-chapter";
  const prefix = "院中的日常。".repeat(600);
  const record = body => ({ familyId: FAMILY, storyId, draftType: "story-revision",
    revision: { id: "revision-long", storyId, savedAt: "2026-09-18", draft: {
      chapters: [{ id: CHAPTER.id, content: [{ text: `${prefix}${body}` }] }],
    } } });
  h.repo.setDrafts([record("1983年的冬天。")]);
  const event = { familyId: FAMILY, storyId, chapterId: CHAPTER.id, requestId: "req-long-era-0001", purpose: "illustration" };
  assert.equal((await h.handlers.submit(ctx, event)).job.status, "queued");
  h.repo.setDrafts([record("1984年的冬天。")]);
  const result = await h.handlers.status(ctx, { familyId: FAMILY, storyId, jobId: `${FAMILY}_${event.requestId}` });
  assert.equal(result.job.status, "failed");
  assert.equal(h.calls.generate.length, 0);
});

test("来源记忆参与提示词后，记忆改动也会在付费前拒绝旧请求", async () => {
  const h = harness(), storyId = "story-memory-art";
  const draft = { chapters: [{ ...CHAPTER, memoryIds: ["memory-a"] }] };
  h.repo.setDrafts([{ familyId: FAMILY, storyId, draftType: "story-revision",
    revision: { id: "revision-memory-art", storyId, savedAt: "2026-09-18", draft } }]);
  h.repo.setStory(storyId, { memoryIds: ["memory-a"] });
  h.repo.setMemory("memory-a", { text: "1983年冬天，村里的小院很安静。" });
  const event = { familyId: FAMILY, storyId, chapterId: CHAPTER.id, requestId: "req-memory-art-0001", purpose: "illustration" };
  assert.equal((await h.handlers.submit(ctx, event)).job.status, "queued");
  h.repo.setMemory("memory-a", { text: "1984年冬天，村里的小院很安静。" });
  const result = await h.handlers.status(ctx, { familyId: FAMILY, storyId, jobId: `${FAMILY}_${event.requestId}` });
  assert.equal(result.job.status, "failed");
  assert.equal(h.calls.generate.length, 0);
});

test("迁移图片链接支持本书参考和删除，同时拒绝另一故事操作",async()=>{
  const h=harness(), storyId="story-book-a", imageId=`${FAMILY}_img_req-linked001`;
  h.repo.setDrafts([{
    familyId:FAMILY,storyId,draftType:"story-revision",
    revision:{id:"revision-story-a",storyId,savedAt:"2026-09-17T00:00:00Z",draft:{chapters:[CHAPTER]}},
  }]);
  await h.repo.createImage(imageId,{familyId:FAMILY,memberId:"owner",chapterId:CHAPTER.id,purpose:"illustration",fileID:"cloud://linked",moderation:"pass",createdAtMs:1});
  h.repo.linkImage(storyId,imageId);
  const event={familyId:FAMILY,storyId,chapterId:CHAPTER.id,requestId:"req-linked-ref-0001",purpose:"illustration",referenceImageId:imageId};
  const submitted=await h.handlers.submit(ctx,event);
  assert.equal(submitted.job.referenceApplied,true);
  await assert.rejects(h.handlers.remove(ctx,{familyId:FAMILY,storyId:"story-book-b",imageId}),error=>error.code==="IMAGE_NOT_FOUND");
  await h.handlers.remove(ctx,{familyId:FAMILY,storyId,imageId});
  assert.ok(h.repo.images.get(imageId).deletedAtMs);
});

test("已删除故事的旧页面不能再提交付费配图任务", async () => {
  const h=harness(), storyId="story-book-a";
  h.repo.setDrafts([{
    familyId:FAMILY,storyId,draftType:"story-revision",
    revision:{id:"revision-story-a",storyId,savedAt:"2026-09-17T00:00:00Z",draft:{chapters:[CHAPTER]}},
  }]);
  h.repo.setStory(storyId,{deletedAt:"2026-09-17T01:00:00Z"});
  const event={familyId:FAMILY,storyId,chapterId:CHAPTER.id,requestId:"req-deleted-story-0001",purpose:"illustration"};
  await assert.rejects(h.handlers.submit(ctx,event),error=>error.code==="STORY_NOT_FOUND");
  assert.equal(h.repo.jobs.size,0);
  assert.equal(h.calls.scene.length,0);
  assert.equal(h.calls.generate.length,0);
});

test("其他章节只提供人物连续性线索，能认出女孩且不夹带无关情节", () => {
  const draft = { chapters: [
    { id: "chapter-1", title: "雨夜", content: [{ text: "她站在车站等车。" }] },
    { id: "chapter-2", title: "小时候", content: [{ text: "阿宁是家里的小女儿，也是个爱笑的女孩。清晨全家吃了面条。" }] },
    { id: "chapter-3", title: "远行", content: [{ text: "火车驶过很多城市，窗外一直下雨。" }] },
  ] };
  const source = core.chapterSource(draft, "chapter-1");
  assert.match(source.characterContext, /人物线索：女儿、女孩/);
  assert.doesNotMatch(source.characterContext, /面条|火车|城市|她站在车站/);
  assert.equal(source.text, "她站在车站等车。");
  assert.equal(core.bookCharacterContext(draft, "chapter-2").includes("她站在车站等车"), false);
});

test("当前章节的性别线索覆盖其他章节，完全没有依据时改成中性人物", () => {
  const sceneWithBoy = { scene: "车站等车", objects: [], light: "", mood: "", eraHint: "", figures: ["远景中的男孩背影"] };
  assert.deepEqual(
    core.alignSceneFigures(sceneWithBoy, { text: "女孩站在站台上。", characterContext: "《旧事》人物线索：男孩" }).figures,
    ["远景中的女孩背影"],
  );
  assert.deepEqual(core.alignSceneFigures(sceneWithBoy, { text: "有人站在站台上。", characterContext: "" }).figures, ["远景中的人物背影"]);
  assert.deepEqual(core.alignVisualReference({
    style: "水彩", palette: ["浅蓝"], figures: ["短发男孩，蓝色外套"], objects: ["红围巾", "木凳"],
  }, { text: "女孩坐在木凳上。", characterContext: "" }, { objects: ["木凳"] }), {
    style: "水彩", palette: ["浅蓝"], figures: ["短发女孩，蓝色外套"], objects: ["木凳"],
  });
  assert.deepEqual(core.alignVisualReference({
    style: "水彩", palette: [], figures: ["短发男孩，蓝色外套"], objects: ["书", "红围巾"],
  }, { text: "女孩和爸爸背着书包出门。", characterContext: "" }, { objects: ["书", "书包"] }), {
    style: "水彩", palette: [], figures: ["短发人物，蓝色外套"], objects: [],
  });
});

test("限额：每天 10 张、每个故事 30 张，按北京时间换日；排队和画着的也算", () => {
  assert.deepEqual(core.quotaDecision({ todayCount: 9, bookCount: 29 }), { allowed: true });
  assert.equal(core.quotaDecision({ todayCount: 10, bookCount: 0 }).code, "DAILY_LIMIT");
  assert.equal(core.quotaDecision({ todayCount: 0, bookCount: 30 }).code, "BOOK_LIMIT");
  for (const status of ["submitted", "queued", "generating", "generated", "storing", "stored", "unknown", "expired"]) {
    assert.ok(core.COUNTED_STATUSES.includes(status), status);
  }
  assert.ok(!core.COUNTED_STATUSES.includes("failed"));
  assert.ok(!core.COUNTED_STATUSES.includes("blocked"));
  assert.equal(core.chinaDayKey(Date.parse("2026-09-12T16:30:00.000Z")), "2026-09-13");
  assert.equal(core.chinaDayKey(Date.parse("2026-09-12T15:59:00.000Z")), "2026-09-12");
});

test("模型给的画面只保留约定字段，清掉控制字符并限制长度", () => {
  const parsed = core.parseSceneJson('好的：{"scene":"院子里\\u0007晒被子。","objects":["竹竿","棉被","","a","b","c","d","e"],"light":"冬天","mood":"安静","eraHint":"","figures":["远景中的背影"],"extra":"忽略"}');
  assert.deepEqual(parsed, {
    scene: "院子里 晒被子", setting: "", objects: ["竹竿", "棉被", "a", "b", "c", "d"], light: "冬天",
    mood: "安静", eraHint: "", figures: ["远景中的背影"],
  });
  assert.equal(core.parseSceneJson('{"scene":"院子","setting":"冬天的小院。"}').setting, "冬天的小院");
  assert.throws(() => core.parseSceneJson("没有 JSON"), error => error.code === "SCENE_PARSE_FAILED");
  assert.throws(() => core.parseSceneJson('{"objects":["棉被"]}'), error => error.code === "SCENE_PARSE_FAILED");
});

test("插图提示词只用肯定式描述，不列禁止画的东西", () => {
  const { prompt, width, height } = core.buildImagePrompt(
    { scene: "冬天的院子里晒着被子", setting: "", objects: ["竹竿", "棉被"], light: "冬日午后", mood: "安静", eraHint: "", figures: ["远景中的背影"] },
    "illustration",
  );
  assert.deepEqual([width, height], [1024, 768]);
  assert.match(prompt, /纸本手绘插画/);
  assert.match(prompt, /纸面的纤维/);
  assert.match(prompt, /画中有竹竿、棉被。/);
  assert.match(prompt, /人物以远景或局部呈现：远景中的背影。/);
  assert.doesNotMatch(prompt, /不要|禁止|避免|不得|没有/);
  assert.doesNotMatch(prompt, /时代感/);
});

test("已保存的全书文字只提炼媒介线索，当前章仍控制画面事实与年代", () => {
  const draft = { chapters: [
    { id: "c1", content: [{ text: "我在窗前想起那一天。" }] },
    { id: "c2", content: [{ text: "村里的旧院子有一口井。" }] },
    { id: "c3", content: [{ text: "乡间集市散后，我们走过田地。" }] },
  ] };
  const source = core.chapterSource(draft, "c1");
  assert.equal(source.bookLifeCategory, "local");
  const prompt = core.buildImagePrompt({ scene: "窗前", setting: "窗前", objects: [], light: "", mood: "怀旧", eraHint: "", figures: [] }, "illustration", undefined, source).prompt;
  assert.match(prompt, /淡墨皴擦与薄水彩/);
  assert.match(prompt, /视点贴近讲述者/);
  assert.match(prompt, /叠笔与擦洗/);
  assert.doesNotMatch(prompt, /旧院子|集市|田地|年代质地/);
});

test("同一本书的来源记忆参与美术提炼，但不改写当前画面事实", () => {
  const draft = { chapters: [
    { id: "c1", content: [{ text: "我在窗前看着桌上的搪瓷杯。" }], memoryIds: ["memory-a"] },
    { id: "c2", content: [{ text: "城市里的楼房一排排亮着灯。" }], memoryIds: ["memory-b"] },
  ] };
  const memories = [
    { id: "memory-a", familyId: FAMILY, text: "1983年冬天，村里的院子很安静，我总是怀旧地想起晒被子的日子。" },
    { id: "memory-b", familyId: FAMILY, text: "1998年夏天，公交站旁人来人往。" },
  ];
  const source = core.chapterSource(draft, "c1", memories);
  assert.equal(source.text, "我在窗前看着桌上的搪瓷杯。");
  assert.match(source.artText, /1983年冬天/);
  assert.doesNotMatch(source.artText, /1998年夏天/);
  const prompt = core.buildImagePrompt({
    scene: "窗前的搪瓷杯", setting: "窗前", objects: ["搪瓷杯"], light: "", mood: "", eraHint: "", figures: [],
  }, "illustration", undefined, source).prompt;
  assert.match(prompt, /淡墨皴擦与薄水彩/);
  assert.match(prompt, /叠笔与擦洗/);
  assert.match(prompt, /正文明确写出的1983年/);
  assert.doesNotMatch(prompt, /晒被子|公交站|1998/);

  const cover = core.bookSource(draft, memories);
  const coverPrompt = core.buildImagePrompt({
    scene: "窗边桌上的搪瓷杯与远处灯光", setting: "窗边", objects: ["搪瓷杯"], light: "", mood: "", eraHint: "", figures: [],
  }, "cover", undefined, cover).prompt;
  assert.doesNotMatch(coverPrompt, /年代质地/);
  assert.match(coverPrompt, /主体与留白/);
});

test("被正文否定的情绪不会变成画法；明确年代才进入提示词", () => {
  const scene = { scene: "窗前的桌子", setting: "窗前", objects: ["桌子"], light: "", mood: "怀旧", eraHint: "", figures: [] };
  const source = { text: "我不想再沉在怀旧里，今天只想看窗前的桌子。" };
  const prompt = core.buildImagePrompt(scene, "illustration", undefined, source).prompt;
  assert.doesNotMatch(prompt, /被时间轻轻洗过|年代质地/);
  const dated = core.buildImagePrompt({ ...scene, eraHint: "1980年代" }, "cover", undefined, { text: "1980年代的家里" }).prompt;
  assert.match(dated, /正文明确写出的1980年代/);
});

test("长章节后半段的明确年代仍进入美术提示词，且完整正文参与来源校验", () => {
  const body = `${"院子里的日常。".repeat(600)}后来写到1983 年冬天。`;
  const source = core.chapterSource({ chapters: [{ id: "long", content: [{ text: body }] }] }, "long");
  assert.equal(source.text.length, 4000);
  assert.doesNotMatch(source.text, /1983/);
  assert.equal(source.fullTextHash, core.textHash(body));
  const scene = { scene: "院子", setting: "院子", objects: [], light: "", mood: "安静", eraHint: "", figures: [] };
  const prompt = core.buildImagePrompt(scene, "illustration", undefined, source).prompt;
  assert.match(prompt, /正文明确写出的1983年/);
  const changed = core.chapterSource({ chapters: [{ id: "long", content: [{ text: body.replace("1983", "1984") }] }] }, "long");
  assert.notEqual(changed.fullTextHash, source.fullTextHash);
});

test("正文跨越多个明确年代时，不把其中之一当作全书年代", () => {
  const source = { text: "1983年的小院。1998年的城市。" };
  const scene = { scene: "小院", setting: "小院", objects: [], light: "", mood: "", eraHint: "1983年", figures: [] };
  const prompt = core.buildImagePrompt(scene, "cover", undefined, source).prompt;
  assert.doesNotMatch(prompt, /年代质地/);
});

test("美术想法在排队前必须审核，重复请求不能改写原想法", async () => {
  const checks = [];
  const h = harness({ deps: { textChecker: { async check(input) { checks.push(input); return { ok: true }; } } } });
  const event = { ...submitEvent("req-art-direction-0001"), artDirection: "暖黄彩铅和粗纸" };
  const submitted = await h.handlers.submit(ctx, event);
  assert.equal(submitted.job.ideaApplied, true);
  assert.deepEqual(checks, [{ text: event.artDirection, openid: OWNER_OPENID }]);
  assert.match(h.repo.jobs.get(`${FAMILY}_${event.requestId}`).prompt, /用户的美术偏好：暖黄彩铅和粗纸/);
  await assert.rejects(h.handlers.submit(ctx, { ...event, artDirection: "青色水墨" }), error => error.code === "REQUEST_CONFLICT");
  assert.equal(checks.length, 1);
  assert.throws(() => core.normalizeSubmitInput({ ...event, artDirection: "不要油画" }), error => error.code === "INVALID_ART_DIRECTION");
  const blocked = harness({ deps: { textChecker: { async check() { return { ok: false, risky: true }; } } } });
  await assert.rejects(blocked.handlers.submit(ctx, event), error => error.code === "ART_DIRECTION_BLOCKED");
  assert.equal(blocked.repo.jobs.size, 0);
  await assert.rejects(harness().handlers.submit(ctx, event), error => error.code === "ART_DIRECTION_CHECK_FAILED");
});

test("参考图只提取有限的视觉连续性信息，并写进新图提示词", async () => {
  assert.deepEqual(reference.parseReferenceJson('{"style":"轻柔水彩","palette":["暖白","浅蓝"],"figures":["短发女孩，浅蓝外套"],"objects":["红围巾"],"event":"忽略"}'), {
    style: "轻柔水彩", palette: ["暖白", "浅蓝"], figures: ["短发女孩，浅蓝外套"], objects: ["红围巾"],
  });
  assert.equal(reference.parseReferenceJson("无法识别"), undefined);
  const prompt = core.buildImagePrompt({
    scene: "女孩在车站等车", setting: "车站", objects: ["长椅"], light: "傍晚", mood: "安静", eraHint: "", figures: ["远景中的女孩背影"],
  }, "illustration", { style: "轻柔水彩", palette: ["暖白", "浅蓝"], figures: ["短发女孩，浅蓝外套"], objects: ["红围巾"] }).prompt;
  assert.match(prompt, /参考图的视觉连续性/);
  assert.match(prompt, /短发女孩，浅蓝外套/);
  assert.match(prompt, /暖白、浅蓝/);
  assert.doesNotMatch(prompt, /忽略/);

  let sent;
  const analyzer = reference.createReferenceAnalyzer({
    apiKey: "k",
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"style":"水彩","palette":[],"figures":[],"objects":[]}' } }] }) };
    },
  });
  assert.equal((await analyzer.analyze("https://tmp.example/reference.png")).style, "水彩");
  assert.equal(sent.url, "https://tokenhub.tencentmaas.com/v1/chat/completions");
  assert.deepEqual(sent.body.messages[0].content[1], { type: "image_url", image_url: { url: "https://tmp.example/reference.png" } });
  await assert.rejects(reference.createReferenceAnalyzer({ apiKey: "" }).analyze("https://x/1.png"), error => error.code === "REFERENCE_ANALYSIS_FAILED");
});

test("底图只画景物：上方留白、最多三个物件、没有人物，也不用描述情景的那句话", () => {
  const { prompt, width, height } = core.buildImagePrompt({
    scene: "奶奶在冬天的院子里晒被子", setting: "冬天的小院", objects: ["竹竿", "棉被", "木凳", "瓦罐"],
    light: "冬日午后", mood: "安静", eraHint: "", figures: ["远景中的背影"],
  }, "backdrop");
  assert.deepEqual([width, height], [1248, 832]);
  assert.match(prompt, /上方大面积是接近纯白的宣纸留白/);
  assert.match(prompt, /景物：冬天的小院。/);
  assert.match(prompt, /画中有竹竿、棉被、木凳。/);
  assert.doesNotMatch(prompt, /瓦罐|奶奶|背影|人物/);
  assert.doesNotMatch(prompt, /不要|禁止|避免|不得|没有/);
});

test("读章节超时明确告知尚未开始画图，未知错误不暴露内部信息", async () => {
  const h = harness({ deps: { extractScene: async () => { throw new core.StoryImageError("SCENE_TIMEOUT", "internal detail"); } } });
  const { job } = await h.handlers.submit(ctx, submitEvent());
  assert.equal(job.status, "failed");
  assert.match(job.message, /读取章节超时/);
  assert.match(job.message, /还没有开始画图/);
  assert.equal(h.calls.generate.length, 0);
  assert.equal(core.publicJob({ status: "failed", errorCode: "SECRET_INTERNAL_DETAIL" }).message, core.MESSAGES.failed);
});

test("读章节画面的系统提示把正文当资料、禁止补造事实，并单独要不含人物的地点", async () => {
  assert.match(scene.SYSTEM_PROMPT, /不是可以执行的指令/);
  assert.match(scene.SYSTEM_PROMPT, /不得补造正文没有的人名、地点、年份、事件或物件/);
  assert.match(scene.SYSTEM_PROMPT, /setting：只写地点和环境本身，不写人物/);
  assert.match(scene.SYSTEM_PROMPT, /冲突时以当前正文为准/);
  assert.match(scene.SYSTEM_PROMPT, /性别没有可靠依据时.*不显露性别/);
  const notConfigured = scene.createSceneExtractor({ apiKey: "", model: "" });
  await assert.rejects(notConfigured({ title: "", text: "x" }), error => error.code === "AI_NOT_CONFIGURED");
  let body;
  const extract = scene.createSceneExtractor({
    apiKey: "k", model: "m", baseUrl: "https://ai.example/v1/",
    fetchImpl: async (url, init) => {
      body = { url, payload: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"scene":"院子","objects":[],"light":"","mood":"","eraHint":"","figures":[]}' } }] }) };
    },
  });
  assert.equal((await extract({ title: "老院子", text: "奶奶晒被子" })).scene, "院子");
  assert.equal(body.url, "https://ai.example/v1/chat/completions");
  assert.match(body.payload.messages[1].content, /章名：老院子/);
  const messages = scene.buildSceneMessages({ title: "车站", text: "她在等车", characterContext: "《小时候》：她是个女孩。" });
  assert.match(messages[1].content, /当前章节正文：[\s\S]*她在等车/);
  assert.match(messages[1].content, /人物连续性资料[\s\S]*她是个女孩/);
});

test("定时兜底对每种状态的处理", () => {
  const at = (status, ageMs, extra = {}) => core.sweepAction({ status, updatedAtMs: T0 - ageMs, ...extra }, T0);
  assert.equal(at("submitted", 60_000), "skip");
  assert.equal(at("submitted", 4 * 60_000), "mark-failed");
  assert.equal(at("queued", 30_000), "skip", "页面还在查进度时交给页面去画");
  assert.equal(at("queued", 90_000), "generate");
  assert.equal(at("generating", 60_000), "skip");
  assert.equal(at("generating", 4 * 60_000), "mark-unknown");
  assert.equal(at("generated", 0), "store");
  assert.equal(at("storing", 4 * 60_000), "release");
  assert.equal(at("stored", 99 * 60_000), "skip");
});

// ---------- 质检 ----------

test("质检回答必须四项都是真假值，否则算没质检", () => {
  assert.deepEqual(
    quality.parseQualityJson('{"readableText":false,"pseudoText":true,"watermarkOrLogo":false,"signature":false,"note":"左上角有乱码"}'),
    { quality: "flawed", qualityIssues: ["pseudoText"], qualityNote: "左上角有乱码", qualityError: "" },
  );
  assert.equal(
    quality.parseQualityJson('{"readableText":false,"pseudoText":false,"watermarkOrLogo":false,"signature":false}').quality,
    "pass",
  );
  assert.equal(quality.parseQualityJson('{"readableText":false,"pseudoText":"no","watermarkOrLogo":false,"signature":false}'), undefined);
  assert.equal(quality.parseQualityJson("看起来没问题"), undefined);
  assert.match(quality.QUALITY_PROMPT, /「AI生成」或旧版「图片由AI生成」.*不算问题/);
});

test("质检走 TokenHub 的看图模型；没配置、超时或出错时都记为没质检", async () => {
  const notConfigured = quality.createQualityChecker({ apiKey: "" });
  assert.equal(notConfigured.configured, false);
  assert.deepEqual(await notConfigured.check("https://x/1.png"), { quality: "unchecked", qualityIssues: [], qualityNote: "", qualityError: "VISION_NOT_CONFIGURED" });

  let sent;
  const ok = quality.createQualityChecker({
    apiKey: "k",
    fetchImpl: async (url, init) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"readableText":false,"pseudoText":false,"watermarkOrLogo":false,"signature":false}' } }] }) };
    },
  });
  assert.equal((await ok.check("https://x/1.png")).quality, "pass");
  assert.equal(sent.url, "https://tokenhub.tencentmaas.com/v1/chat/completions");
  assert.equal(sent.headers.Authorization, "Bearer k");
  assert.equal(sent.body.model, "hy-vision-2.0-instruct");
  assert.deepEqual(sent.body.messages[0].content[1], { type: "image_url", image_url: { url: "https://x/1.png" } });

  const timeout = quality.createQualityChecker({ apiKey: "k", fetchImpl: async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; } });
  assert.equal((await timeout.check("https://x/1.png")).qualityError, "VISION_TIMEOUT");
  const broken = quality.createQualityChecker({ apiKey: "k", fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.deepEqual(await broken.check("https://x/1.png"), { quality: "unchecked", qualityIssues: [], qualityNote: "", qualityError: "VISION_HTTP_429" });
});

// ---------- 流程 ----------

test("点配图只读章节、写好提示词、排进队，马上返回；重复点击不重复排队", async () => {
  const { handlers, repo, calls } = harness();
  const first = await handlers.submit(ctx, submitEvent());
  assert.equal(first.job.status, "queued");
  assert.equal(calls.generate.length, 0, "提交时还不出图");
  assert.equal(calls.scene[0].text, "那年冬天，奶奶在院子里晒被子。");
  const job = repo.jobs.get(`${FAMILY}_req-20260913-abcd1234`);
  assert.equal(job.provider, "tokenhub");
  assert.equal(job.model, "hy-image-v3");
  assert.equal(job.referencePhotoCount, 0);
  assert.equal(job.dayKey, "2026-09-13");
  assert.match(job.prompt, /冬天的院子里晒着被子/);
  assert.deepEqual([job.width, job.height], [1024, 768]);

  const again = await handlers.submit(ctx, submitEvent());
  assert.equal(again.job.jobId, first.job.jobId);
  assert.equal(calls.scene.length, 1);
});

test("可以参考同一章节的旧插图再画，但不能跨章节或使用已删除图片", async () => {
  const { handlers, repo, calls } = harness();
  const referenceImageId = `${FAMILY}_img_req-20260913-old00001`;
  await repo.createImage(referenceImageId, {
    familyId: FAMILY, memberId: "owner", chapterId: "chapter-1", purpose: "illustration",
    fileID: "cloud://env/story-images/old.png", moderation: "pass", createdAtMs: T0 - 1,
  });
  const result = await handlers.submit(ctx, { ...submitEvent(), referenceImageId });
  assert.equal(result.job.status, "queued");
  assert.deepEqual(calls.reference, ["https://tmp.example/cloud%3A%2F%2Fenv%2Fstory-images%2Fold.png"]);
  assert.equal(calls.tempUrls[0].maxAge, 5 * 60);
  const job = repo.jobs.get(result.job.jobId);
  assert.equal(job.referenceImageId, referenceImageId);
  assert.equal(job.referenceImageCount, 1);
  assert.match(job.prompt, /短发女孩，浅蓝外套/);
  assert.equal(job.visualReference, undefined);
  await assert.rejects(
    handlers.submit(ctx, { ...submitEvent(), referenceImageId: `${FAMILY}_img_req-20260913-another1` }),
    error => error.code === "REQUEST_CONFLICT",
  );
  await assert.rejects(
    handlers.submit(ctx, { ...submitEvent(), chapterId: "chapter-other", referenceImageId }),
    error => error.code === "REQUEST_CONFLICT",
  );
  await assert.rejects(
    handlers.submit(ctx, { ...submitEvent(), memberId: "someone-else", referenceImageId }),
    error => error.code === "REQUEST_CONFLICT",
  );

  repo.images.set(referenceImageId, { ...repo.images.get(referenceImageId), memberId: "someone-else" });
  await assert.rejects(
    handlers.submit(ctx, { ...submitEvent("req-20260913-member01"), referenceImageId }),
    error => error.code === "REFERENCE_IMAGE_NOT_FOUND",
  );
  repo.images.set(referenceImageId, { ...repo.images.get(referenceImageId), memberId: "owner", familyId: "family_o-other" });
  await assert.rejects(
    handlers.submit(ctx, { ...submitEvent("req-20260913-family01"), referenceImageId }),
    error => error.code === "REFERENCE_IMAGE_NOT_FOUND",
  );
  assert.equal(calls.reference.length, 1, "越权参考图不会发给视觉模型");
  repo.images.set(referenceImageId, { ...repo.images.get(referenceImageId), familyId: FAMILY });

  repo.images.set(referenceImageId, { ...repo.images.get(referenceImageId), chapterId: "chapter-other" });
  await assert.rejects(
    handlers.submit(ctx, { ...submitEvent("req-20260913-other001"), referenceImageId }),
    error => error.code === "REFERENCE_IMAGE_NOT_FOUND",
  );
  repo.images.set(referenceImageId, { ...repo.images.get(referenceImageId), chapterId: "chapter-1", deletedAtMs: T0 });
  await assert.rejects(
    handlers.submit(ctx, { ...submitEvent("req-20260913-deleted01"), referenceImageId }),
    error => error.code === "REFERENCE_IMAGE_NOT_FOUND",
  );
  repo.images.set(referenceImageId, { ...repo.images.get(referenceImageId), deletedAtMs: undefined, purpose: "backdrop" });
  await assert.rejects(
    handlers.submit(ctx, { ...submitEvent("req-20260913-backdrop1"), referenceImageId }),
    error => error.code === "REFERENCE_IMAGE_NOT_FOUND",
  );
  for (const moderation of ["pending", "unchecked", "review", "risky"]) {
    repo.images.set(referenceImageId, { ...repo.images.get(referenceImageId), purpose: "illustration", moderation });
    await assert.rejects(
      handlers.submit(ctx, { ...submitEvent(`req-20260913-${moderation}1`), referenceImageId }),
      error => error.code === "REFERENCE_IMAGE_NOT_READY",
    );
  }
});

test("没配置出图密钥时不留记录、不占名额", async () => {
  const { handlers, repo } = harness({ provider: { configured: false } });
  await assert.rejects(handlers.submit(ctx, submitEvent()), error => error.code === "IMAGE_NOT_CONFIGURED");
  assert.equal(repo.jobs.size, 0);
});

test("没配置文件级 AIGC 隐式标识时不出图、不留记录", async () => {
  const { handlers, repo, calls } = harness({ deps: { aigcMetadata: { configured: false } } });
  await assert.rejects(handlers.submit(ctx, submitEvent()), error => error.code === "AIGC_METADATA_NOT_CONFIGURED");
  assert.equal(repo.jobs.size, 0);
  assert.equal(calls.generate.length, 0);
});

test("别人的记忆之家不能提交", async () => {
  const { handlers, repo } = harness();
  await assert.rejects(handlers.submit({ openid: "o-guest" }, submitEvent()), error => error.code === "NOT_FAMILY_OWNER");
  assert.equal(repo.jobs.size, 0);
});

test("今天画满 10 张就拦下，没画成的不占名额", async () => {
  const { handlers, repo } = harness();
  for (let index = 0; index < 10; index++) {
    await repo.createJob(`${FAMILY}_req-used-000${index}`, {
      familyId: FAMILY, memberId: "owner", dayKey: "2026-09-13", status: index < 3 ? "failed" : "stored", createdAtMs: 0,
    });
  }
  for (let index = 0; index < 3; index++) {
    assert.equal((await handlers.submit(ctx, submitEvent(`req-20260913-fresh00${index}`))).job.status, "queued");
  }
  await assert.rejects(handlers.submit(ctx, submitEvent("req-20260913-over0001")), error => error.code === "DAILY_LIMIT");
  assert.equal(repo.jobs.has(`${FAMILY}_req-20260913-over0001`), false);
});

test("读不懂章节画面时记为没画成，不排队出图", async () => {
  const { handlers, calls } = harness({
    deps: { async extractScene() { throw new core.StoryImageError("SCENE_PARSE_FAILED", "x"); } },
  });
  const result = await handlers.submit(ctx, submitEvent());
  assert.equal(result.job.status, "failed");
  assert.equal(calls.generate.length, 0);
});

test("页面查进度时才出图：画好先记下链接，再转存云存储、登记图片、送内容安全检测", async () => {
  const { handlers, repo, calls } = harness();
  const { job } = await handlers.submit(ctx, submitEvent());
  const queuedPrompt = repo.jobs.get(job.jobId).prompt;
  const result = await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(calls.generate.length, 1);
  assert.deepEqual(calls.generate[0], { prompt: queuedPrompt, width: 1024, height: 768, seed: core.imageSeed(FAMILY, submitEvent().requestId) });
  assert.deepEqual(calls.download, ["https://result.example/1.png"]);
  assert.equal(calls.aigc.length, 1);
  assert.equal(calls.aigc[0].contentType, "image/png");
  assert.match(calls.aigc[0].produceId, /^aigc-/);
  assert.deepEqual(calls.upload, ["story-images/family_o-owner/owner/req-20260913-abcd1234.png"]);
  assert.equal(calls.uploadBuffers[0].toString(), "png-bytes-with-aigc");
  assert.equal(result.job.status, "stored");
  assert.equal(result.image.chapterId, "chapter-1");
  assert.equal(result.image.aiGenerated, true);
  assert.equal(result.image.quality, "unchecked");
  const stored = repo.jobs.get(job.jobId);
  assert.equal(stored.resultUrl, "https://result.example/1.png");
  assert.equal(stored.providerJobId, "tokenhub-1");
  assert.equal(stored.usageTokens, 1024);
  assert.equal(stored.prompt, "");
  assert.equal(stored.revisedPrompt, "");
  const image = repo.images.get(`${FAMILY}_img_req-20260913-abcd1234`);
  assert.equal(image.bytes, calls.uploadBuffers[0].length);
  assert.equal(image.aigcProduceId, calls.aigc[0].produceId);
  assert.equal(image.moderation, "pending");
  assert.deepEqual(calls.moderation, [{ fileID: image.fileID, openid: OWNER_OPENID }]);
});

test("出图超过一分钟时先保存结果链接，下一次查询再转存", async () => {
  let h;
  h = harness({
    provider: {
      async generate(input) {
        h.calls.generate.push(input);
        h.tick(60_001);
        return { resultUrl: "https://result.example/slow.png", revisedPrompt: "", providerJobId: "slow", usageTokens: 1 };
      },
    },
  });
  const { job } = await h.handlers.submit(ctx, submitEvent());
  const first = await h.handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(first.job.status, "generated");
  assert.equal(h.repo.jobs.get(job.jobId).resultUrl, "https://result.example/slow.png");
  assert.equal(h.calls.upload.length, 0);

  const second = await h.handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(second.job.status, "stored");
  assert.equal(h.calls.generate.length, 1);
});

test("确定性的隐式标识写入失败进入终态，保留结果链接且不再重试", async () => {
  let metadataAttempts = 0;
  const { handlers, calls, repo } = harness({
    deps: {
      aigcMetadata: {
        configured: true,
        writeForSource() { metadataAttempts++; throw new Error("AIGC_IMAGE_DECODE_FAILED"); },
      },
    },
  });
  const { job } = await handlers.submit(ctx, submitEvent());
  const result = await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(result.job.status, "failed");
  assert.equal(result.job.message, core.MESSAGES.failed);
  assert.equal(repo.jobs.get(job.jobId).errorCode, "AIGC_IMAGE_DECODE_FAILED");
  assert.equal(repo.jobs.get(job.jobId).resultUrl, "https://result.example/1.png");
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.moderation.length, 0);
  assert.equal(repo.images.size, 0);
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.download.length, 1);
  assert.equal(metadataAttempts, 1);

  await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  await handlers.sweep();
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.download.length, 1);
  assert.equal(metadataAttempts, 1);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.moderation.length, 0);
});

test("隐式标识配置或内部故障会保留已付费结果，恢复后重试转存", async () => {
  let metadataAttempts = 0;
  const calls = [];
  const writer = aigcMetadataFake({ aigc: calls });
  const { handlers, repo, calls: effects } = harness({
    deps: {
      aigcMetadata: {
        configured: true,
        writeForSource(...args) {
          metadataAttempts += 1;
          if (metadataAttempts === 1) throw new Error("AIGC_METADATA_NOT_CONFIGURED");
          if (metadataAttempts === 2) throw new Error("unexpected decoder detail");
          return writer.writeForSource(...args);
        },
      },
    },
  });
  const { job } = await handlers.submit(ctx, submitEvent());
  const first = await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(first.job.status, "generated");
  assert.equal(repo.jobs.get(job.jobId).resultUrl, "https://result.example/1.png");
  assert.equal(effects.generate.length, 1);
  assert.equal(effects.upload.length, 0);

  const second = await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(second.job.status, "generated");
  assert.equal(effects.generate.length, 1);
  assert.equal(effects.upload.length, 0);

  const third = await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(third.job.status, "stored");
  assert.equal(effects.generate.length, 1);
  assert.equal(effects.download.length, 3);
  assert.equal(effects.upload.length, 1);
});

test("两个查询同时到达，只出一张图、只转存一次", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { handlers, calls } = harness({
    provider: {
      async generate(input) {
        calls.generate.push(input);
        await gate;
        return { resultUrl: "https://result.example/1.png", revisedPrompt: "", providerJobId: "tokenhub-1", usageTokens: 1 };
      },
    },
  });
  const { job } = await handlers.submit(ctx, submitEvent());
  const first = handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  const second = handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  release();
  const results = await Promise.all([first, second]);
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.upload.length, 1);
  assert.ok(results.some(result => result.job.status === "stored"));
});

test("审核拦截显示没通过审核；超时算不确定并占名额，都不自动重画", async () => {
  const blocked = harness({ provider: { async generate() { const error = new Error("TOKENHUB_HTTP_422"); error.httpStatus = 422; throw error; } } });
  const a = await blocked.handlers.submit(ctx, submitEvent());
  assert.equal((await blocked.handlers.status(ctx, { familyId: FAMILY, jobId: a.job.jobId })).job.status, "blocked");

  const timedOut = harness({ provider: { async generate() { const error = new Error("aborted"); error.name = "AbortError"; throw error; } } });
  const b = await timedOut.handlers.submit(ctx, submitEvent());
  const result = await timedOut.handlers.status(ctx, { familyId: FAMILY, jobId: b.job.jobId });
  assert.equal(result.job.status, "unknown");
  assert.equal(result.job.message, "不确定有没有画成，可能已经扣费");
  assert.equal(await timedOut.repo.countJobs({ familyId: FAMILY, statuses: core.COUNTED_STATUSES }), 1);
  await timedOut.handlers.status(ctx, { familyId: FAMILY, jobId: b.job.jobId });
});

test("上传失败时退回「已画好」，下次用同一个链接重试，不重新出图", async () => {
  let uploads = 0;
  const { handlers, calls, repo } = harness({
    deps: {
      storage: {
        async upload(cloudPath) { uploads++; if (uploads === 1) throw new Error("upload failed"); return `cloud://env/${cloudPath}`; },
        async tempUrls(fileIDs) { return Object.fromEntries(fileIDs.map(id => [id, "https://tmp.example/x"])); },
        async remove() {},
      },
    },
  });
  const { job } = await handlers.submit(ctx, submitEvent());
  assert.equal((await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId })).job.status, "generated");
  assert.equal((await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId })).job.status, "stored");
  assert.equal(calls.generate.length, 1);
  assert.equal(uploads, 2);
  assert.equal(repo.images.size, 1);
});

test("结果链接过期时明确告诉用户画好了但没保存", async () => {
  const { handlers } = harness({
    deps: { async downloadImage() { const error = new Error("RESULT_GONE_403"); error.expired = true; throw error; } },
  });
  const { job } = await handlers.submit(ctx, submitEvent());
  const result = await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(result.job.status, "expired");
  assert.equal(result.job.message, "画好了但没来得及保存");
});

test("查询别人家的任务一律说找不到", async () => {
  const { handlers } = harness();
  const { job } = await handlers.submit(ctx, submitEvent());
  await assert.rejects(handlers.status({ openid: "o-guest" }, { familyId: "family_o-guest", jobId: job.jobId }),
    error => error.code === "JOB_NOT_FOUND");
});

test("转存后用云存储链接做质检，发现乱码字就标出来给用户看", async () => {
  const checked = [];
  const { handlers, repo } = harness({
    deps: {
      qualityChecker: {
        configured: true,
        async check(url) { checked.push(url); return { quality: "flawed", qualityIssues: ["pseudoText"], qualityNote: "左上角有乱码", qualityError: "" }; },
      },
    },
  });
  const { job } = await handlers.submit(ctx, submitEvent());
  const result = await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(checked.length, 1);
  assert.match(checked[0], /^https:\/\/tmp\.example\//);
  assert.equal(result.image.quality, "flawed");
  assert.deepEqual(result.image.qualityIssues, ["有乱码字"]);
  assert.equal(repo.images.get(`${FAMILY}_img_req-20260913-abcd1234`).qualityNote, "左上角有乱码");
});

test("出图太慢挤掉了质检的时间，就先标质检中，由定时任务补上", async () => {
  const checked = [];
  let h;
  h = harness({
    provider: {
      async generate() { h.tick(45_000); return { resultUrl: "https://result.example/1.png", revisedPrompt: "", providerJobId: "t", usageTokens: 1 }; },
    },
    deps: {
      qualityChecker: { configured: true, async check(url) { checked.push(url); return { quality: "pass", qualityIssues: [], qualityNote: "", qualityError: "" }; } },
    },
  });
  const { job } = await h.handlers.submit(ctx, submitEvent());
  const result = await h.handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(result.job.status, "stored");
  assert.equal(result.image.quality, "pending");
  assert.equal(checked.length, 0);

  const swept = await h.handlers.sweep();
  assert.equal(swept.qualityChecked, 1);
  assert.equal(h.repo.images.get(`${FAMILY}_img_req-20260913-abcd1234`).quality, "pass");
});

test("定时兜底：卡住的准备算没画成、没人查的排队去画、卡住的出图算不确定、卡住的转存放回重试", async () => {
  let h;
  h = harness({
    provider: {
      async generate(input) { h.calls.generate.push(input); h.tick(30_000); return { resultUrl: "https://result.example/1.png", revisedPrompt: "", providerJobId: "t", usageTokens: 1 }; },
    },
  });
  const job = (id, status, extra = {}) => h.repo.createJob(`${FAMILY}_req-sweep-${id}`, {
    familyId: FAMILY, memberId: "owner", requestId: `req-sweep-${id}`, chapterId: "chapter-1", purpose: "illustration",
    status, prompt: "画面", width: 1024, height: 768, requesterOpenId: OWNER_OPENID,
    createdAtMs: T0 - 5 * 60_000, updatedAtMs: T0 - 5 * 60_000, ...extra,
  });
  await job("submitted", "submitted");
  await job("generating", "generating");
  await job("storing", "storing", { resultUrl: "https://result.example/s.png" });
  await job("queued-a", "queued");
  await job("queued-b", "queued");
  await job("fresh", "queued", { updatedAtMs: T0 - 10_000 });

  const result = await h.handlers.sweep();
  const statusOf = id => h.repo.jobs.get(`${FAMILY}_req-sweep-${id}`).status;
  assert.equal(statusOf("submitted"), "failed");
  assert.equal(statusOf("generating"), "unknown");
  assert.equal(h.repo.jobs.get(`${FAMILY}_req-sweep-generating`).prompt, "");
  assert.equal(statusOf("storing"), "generated");
  assert.equal(statusOf("queued-a"), "stored");
  assert.equal(statusOf("queued-b"), "queued", "一次只开始一张同步出图，剩下的留到下一分钟");
  assert.equal(statusOf("fresh"), "queued", "刚排队的交给正在查进度的页面");
  assert.equal(h.calls.generate.length, 1);
  assert.equal(result.deferred, 1);
});

test("管理页列出没删除、没被判违规的图，并算出占用空间；删除会删掉云存储文件", async () => {
  const { handlers, repo, calls } = harness();
  await repo.createImage(`${FAMILY}_img_a`, { familyId: FAMILY, memberId: "owner", chapterId: "chapter-1", purpose: "illustration", fileID: "cloud://a", bytes: 100, moderation: "pass", quality: "pass", createdAtMs: 1, jobId: `${FAMILY}_req-a` });
  await repo.createImage(`${FAMILY}_img_b`, { familyId: FAMILY, memberId: "owner", chapterId: "chapter-1", purpose: "backdrop", fileID: "cloud://b", bytes: 50, moderation: "pending", createdAtMs: 2 });
  await repo.createImage(`${FAMILY}_img_c`, { familyId: FAMILY, memberId: "owner", chapterId: "chapter-1", purpose: "illustration", fileID: "cloud://c", bytes: 999, moderation: "risky", createdAtMs: 3 });
  await repo.createJob(`${FAMILY}_req-a`, { familyId: FAMILY, memberId: "owner", status: "stored", createdAtMs: 1 });

  const listed = await handlers.list(ctx, { familyId: FAMILY, memberId: "owner" });
  assert.deepEqual(listed.images.map(image => image.imageId), [`${FAMILY}_img_b`, `${FAMILY}_img_a`]);
  assert.equal(listed.images[0].quality, "unchecked");
  assert.deepEqual(listed.usage, { count: 2, bytes: 150 });
  assert.deepEqual(listed.limits, { daily: 10, book: 30 });

  await handlers.remove(ctx, { familyId: FAMILY, imageId: `${FAMILY}_img_a` });
  assert.deepEqual(calls.remove, ["cloud://a"]);
  assert.ok(repo.images.get(`${FAMILY}_img_a`).deletedAtMs);
  assert.ok(repo.jobs.get(`${FAMILY}_req-a`).imageDeletedAtMs);
  assert.deepEqual((await handlers.list(ctx, { familyId: FAMILY, memberId: "owner" })).usage, { count: 1, bytes: 50 });
  await assert.rejects(handlers.remove(ctx, { familyId: FAMILY, imageId: `${FAMILY}_img_a` }), error => error.code === "IMAGE_NOT_FOUND");
});

test("删除插图前以云端最新书稿为准，正文仍引用时拒绝删除", async () => {
  const { handlers, repo, calls } = harness();
  const imageId = `${FAMILY}_img_req-abcdefgh`;
  await repo.createImage(imageId, {
    familyId: FAMILY, memberId: "owner", chapterId: "chapter-1", purpose: "illustration",
    fileID: "cloud://used", bytes: 100, moderation: "pass", createdAtMs: 1,
  });
  repo.setDrafts([revisionRecord({
    id: "revision-used", savedAt: "2026-09-13T00:00:00.000Z",
    chapters: [{ ...CHAPTER, content: [{ text: "正文" }, { photoId: "photo-ai-req-abcdefgh" }] }],
  })]);
  await assert.rejects(
    handlers.remove(ctx, { familyId: FAMILY, imageId }),
    error => error.code === "IMAGE_IN_MANUSCRIPT",
  );
  assert.equal(repo.images.get(imageId).deletedAtMs, undefined);
  assert.deepEqual(calls.remove, []);

  repo.setDrafts([revisionRecord({
    id: "revision-unused", savedAt: "2026-09-14T00:00:00.000Z", chapters: [CHAPTER],
  })]);
  await handlers.remove(ctx, { familyId: FAMILY, imageId });
  assert.deepEqual(calls.remove, ["cloud://used"]);
});

test("删除插图与保存新版本并发时，以事务内最新书稿为准", async () => {
  const {handlers,repo,calls}=harness(), storyId="story-book-a";
  const imageId=`${FAMILY}_img_req-concurrent1`;
  await repo.createImage(imageId,{familyId:FAMILY,storyId,memberId:"owner",chapterId:"chapter-1",purpose:"illustration",fileID:"cloud://concurrent",bytes:100,moderation:"pass",createdAtMs:1});
  repo.setDrafts([{
    familyId:FAMILY,storyId,draftType:"story-revision",
    revision:{id:"revision-before",storyId,savedAt:"2026-09-17T00:00:00Z",draft:{chapters:[{...CHAPTER,content:[{text:"还没引用"}]}]}},
  }]);
  repo.beforeSoftDelete=async()=>repo.setDrafts([{
    familyId:FAMILY,storyId,draftType:"story-revision",
    revision:{id:"revision-after",storyId,savedAt:"2026-09-17T00:01:00Z",draft:{chapters:[{...CHAPTER,content:[{text:"正文"},{photoId:"photo-ai-req-concurrent1"}]}]}},
  }]);
  await assert.rejects(handlers.remove(ctx,{familyId:FAMILY,storyId,imageId}),error=>error.code==="IMAGE_IN_MANUSCRIPT");
  assert.equal(repo.images.get(imageId).deletedAtMs,undefined);
  assert.deepEqual(calls.remove,[]);
});

test("内容安全检测判为违规的生成图会被隐藏并删除文件，照片结果转发给 photoAccess", async () => {
  const forwarded = [];
  const { handlers, repo, calls } = harness({ deps: {
    async forwardPhotoModeration(result) { forwarded.push(result); },
  } });
  await repo.createImage(`${FAMILY}_img_x`, { familyId: FAMILY, memberId: "owner", fileID: "cloud://x", moderation: "pending", moderationTraceId: "trace-x" });
  assert.deepEqual(await handlers.moderationResult({ trace_id: "trace-x", result: { suggest: "risky", label: 20002 } }), { ok: true, target: "story_images" });
  const image = repo.images.get(`${FAMILY}_img_x`);
  assert.equal(image.moderation, "risky");
  assert.ok(image.deletedAtMs);
  assert.deepEqual(calls.remove, ["cloud://x"]);
  assert.deepEqual(await handlers.moderationResult({ trace_id: "photo-trace", result: { suggest: "pass", label: 100 } }), { ok: true, target: "photos" });
  assert.deepEqual(forwarded, [{ traceId: "photo-trace", suggest: "pass", label: 100 }]);
});

test("云函数配置：每分钟补做一次，申请内容安全接口，并从环境读取 AIGC 服务提供者编码", () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../cloudfunctions/storyImages/config.json"), "utf8"));
  assert.deepEqual(config.permissions.openapi, ["security.mediaCheckAsync", "security.msgSecCheck"]);
  assert.equal(config.triggers[0].config, "0 * * * * * *");
  const index = fs.readFileSync(path.join(__dirname, "../cloudfunctions/storyImages/index.js"), "utf8");
  assert.match(index, /process\.env\.TOKENHUB_API_KEY/);
  assert.match(index, /createAigcMetadataWriter\(\{ contentProducer: process\.env\.AIGC_CONTENT_PRODUCER \}\)/);
  assert.doesNotMatch(index, /HUNYUAN_SECRET/);
  assert.equal(fs.existsSync(path.join(__dirname, "../cloudfunctions/storyImages/hunyuan.js")), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../deploy/wechat-cloud.manifest.json"), "utf8"));
  assert.ok(manifest.cloudFunctions.storyImages.environmentVariables.includes("AIGC_CONTENT_PRODUCER"));
});

test("清空记忆之家时先删云存储里的配图文件，再删配图记录", () => {
  for (const name of ["resetCurrentUserRoom", "deleteDemoFamilyOnce"]) {
    const source = fs.readFileSync(path.join(__dirname, `../cloudfunctions/${name}/index.js`), "utf8");
    assert.match(source, /imageJobs:\s*"image_jobs"/);
    assert.match(source, /storyImages:\s*"story_images"/);
    assert.match(source, /cloud\.deleteFile\(\{ fileList:/);
    const main = source.slice(source.indexOf("async function main"));
    assert.ok(main.indexOf("removeStoryImageFiles(") >= 0, `${name} 没有删除配图文件`);
    assert.ok(main.indexOf("removeStoryImageFiles(") < main.indexOf("Promise.all"), `${name} 要先删文件再清记录`);
  }
  const inspect = fs.readFileSync(path.join(__dirname, "../cloudfunctions/inspectFamilyData/index.js"), "utf8");
  assert.match(inspect, /imageJobs:\s*"image_jobs"/);
  assert.match(inspect, /storyImages:\s*"story_images"/);
  const { CORE_COLLECTIONS } = require("../cloudfunctions/ensureCloudCollections/bootstrap.js");
  assert.ok(CORE_COLLECTIONS.includes("image_jobs"));
  assert.ok(CORE_COLLECTIONS.includes("story_images"));
});

// ---------- Node 16 运行环境 ----------

test("云函数在没有内置 fetch 的 Node 16 上也能发请求：POST、JSON、二进制、状态码与超时中止", async context => {
  const http = require("node:http");
  const { nodeFetch } = require("../cloudfunctions/storyImages/httpFetch.js");
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (request.url === "/json") {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ method: request.method, auth: request.headers.authorization, body: JSON.parse(body) }));
      } else if (request.url === "/bytes") {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(Buffer.from([1, 2, 3, 4]));
      } else if (request.url === "/refused") {
        response.writeHead(422);
        response.end("{}");
      } else {
        setTimeout(() => { response.writeHead(200); response.end("late"); }, 2_000);
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => { server.closeAllConnections?.(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const json = await nodeFetch(`${base}/json`, {
    method: "POST", headers: { Authorization: "Bearer k", "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "画面" }),
  });
  assert.equal(json.ok, true);
  assert.deepEqual(await json.json(), { method: "POST", auth: "Bearer k", body: { prompt: "画面" } });

  const bytes = await nodeFetch(`${base}/bytes`);
  assert.equal(bytes.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await bytes.arrayBuffer())], [1, 2, 3, 4]);

  const refused = await nodeFetch(`${base}/refused`, { method: "POST", body: "{}" });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 422);

  const controller = new AbortController();
  const slow = nodeFetch(`${base}/slow`, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(slow, error => error.name === "AbortError");
});

test("出图、读章节、质检、下载都不直接依赖全局 fetch", () => {
  const qualitySource = fs.readFileSync(path.join(__dirname, "../cloudfunctions/storyImages/quality.js"), "utf8");
  assert.match(qualitySource, /require\("\.\/vision"\)/, "质检通过共用的看图调用发请求");
  for (const name of ["tokenhub", "scene", "vision"]) {
    const source = fs.readFileSync(path.join(__dirname, `../cloudfunctions/storyImages/${name}.js`), "utf8");
    assert.doesNotMatch(source, /fetchImpl = fetch\b/, `${name}.js 仍然默认使用全局 fetch`);
    assert.match(source, /require\("\.\/httpFetch"\)/);
  }
});

// ---------- 补回改接 TokenHub 时变弱的流程覆盖 ----------

test("提交底图：按底图尺寸排队，出图时用 1248x832，入库记为底图", async () => {
  const { handlers, calls, repo } = harness();
  const { job } = await handlers.submit(ctx, { ...submitEvent(), purpose: "backdrop" });
  assert.equal(job.purpose, "backdrop");
  const queued = repo.jobs.get(job.jobId);
  assert.deepEqual([queued.width, queued.height], [1248, 832]);
  assert.doesNotMatch(queued.prompt, /晒着被子/, "底图不用描述情景的那句话");
  const result = await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(result.job.status, "stored");
  assert.deepEqual([calls.generate[0].width, calls.generate[0].height], [1248, 832]);
  assert.equal(repo.images.get(`${FAMILY}_img_req-20260913-abcd1234`).purpose, "backdrop");
  assert.equal(result.image.purpose, "backdrop");
});

test("TokenHub 明确拒绝（如并发超限 429）记为没画成、不占名额，可以马上再提交", async () => {
  const { handlers, repo } = harness({
    provider: { async generate() { const error = new Error("TOKENHUB_HTTP_429"); error.httpStatus = 429; throw error; } },
  });
  const { job } = await handlers.submit(ctx, submitEvent());
  const result = await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(result.job.status, "failed");
  assert.equal(result.job.message, "没画成，这次不占名额，可以再试一次");
  assert.equal(repo.jobs.get(job.jobId).errorCode, "HTTP_429");
  assert.equal(await repo.countJobs({ familyId: FAMILY, statuses: core.COUNTED_STATUSES }), 0);
  assert.equal((await handlers.submit(ctx, submitEvent("req-20260913-retry001"))).job.status, "queued");
});

test("TokenHub 返回成功却没有图片时记为不确定，占名额，不当成失败", async () => {
  const { handlers, repo, calls } = harness({
    provider: { async generate() { throw new Error("TOKENHUB_NO_IMAGE"); } },
  });
  const { job } = await handlers.submit(ctx, submitEvent());
  const result = await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(result.job.status, "unknown");
  assert.equal(repo.jobs.get(job.jobId).errorCode, "GENERATE_UNCERTAIN");
  assert.equal(await repo.countJobs({ familyId: FAMILY, statuses: core.COUNTED_STATUSES }), 1);
  assert.equal(calls.upload.length, 0);
});

// ---------- 上线诊断 ----------

const { createDiagnostics, DIAGNOSTIC_CHAPTER, authorizeDiagnose } = require("../cloudfunctions/storyImages/diagnostics.js");
const DIAGNOSE_TOKEN = "diag-token-0123456789abcdef";

function diagnosticsHarness({ provider = {}, deps = {} } = {}) {
  const repo = memoryRepo();
  let clock = T0;
  const calls = { scene: [], generate: [], aigc: [], upload: [], uploadBuffers: [], moderation: [], quality: [], drafts: 0 };
  repo.listDraftRecords = async () => { calls.drafts++; return []; };
  const diagnostics = createDiagnostics({
    repo,
    provider: {
      name: "tokenhub",
      model: "hy-image-v3",
      configured: true,
      async generate(input) {
        calls.generate.push(input);
        return { resultUrl: "https://result.example/d.png", revisedPrompt: "", providerJobId: "t", usageTokens: 20000 };
      },
      ...provider,
    },
    async extractScene(source) {
      calls.scene.push(source);
      return { scene: "河边的石桥", setting: "小镇河边", objects: ["石桥"], light: "清晨", mood: "安静", eraHint: "", figures: [] };
    },
    sceneConfigured: true,
    qualityChecker: {
      configured: true,
      async check(url) { calls.quality.push(url); return { quality: "pass", qualityIssues: [], qualityNote: "", qualityError: "" }; },
    },
    aigcMetadata: aigcMetadataFake(calls),
    storage: {
      async upload(cloudPath, buffer) {
        calls.upload.push(cloudPath);
        calls.uploadBuffers.push(Buffer.from(buffer));
        return `cloud://env/${cloudPath}`;
      },
      async tempUrls(fileIDs) { return Object.fromEntries(fileIDs.map(id => [id, "https://tmp.example/d.png"])); },
      async remove() {},
    },
    moderation: { async check(input) { calls.moderation.push(input); return "trace-d"; } },
    async downloadImage() { return { buffer: Buffer.from("png"), contentType: "image/png" }; },
    expectedToken: DIAGNOSE_TOKEN,
    runtime: "v16.13.0",
    now: () => clock,
    ...deps,
  });
  return { repo, calls, diagnostics, tick(ms) { clock += ms; } };
}

test("诊断要带对口令；云函数没配口令或口令太短时一律拒绝", async () => {
  assert.equal(authorizeDiagnose({ diagnoseToken: DIAGNOSE_TOKEN }, DIAGNOSE_TOKEN), true);
  assert.equal(authorizeDiagnose({ diagnoseToken: "wrong-token-0123456789abcd" }, DIAGNOSE_TOKEN), false);
  assert.equal(authorizeDiagnose({}, DIAGNOSE_TOKEN), false);
  assert.equal(authorizeDiagnose({ diagnoseToken: "short" }, "short"), false);
  assert.equal(authorizeDiagnose({ diagnoseToken: "" }, undefined), false);
  const { diagnostics, calls } = diagnosticsHarness();
  await assert.rejects(diagnostics.run(ctx, { action: "diagnose", diagnoseToken: "nope", sample: "image" }), error => error.code === "DIAGNOSE_FORBIDDEN");
  assert.equal(calls.generate.length, 0);
});

test("只检查配置：回报各项是否已配置和运行环境，不花钱、不带任何密钥", async () => {
  const { diagnostics, calls } = diagnosticsHarness();
  const result = await diagnostics.run(ctx, { action: "diagnose", diagnoseToken: DIAGNOSE_TOKEN });
  assert.deepEqual(result, {
    ok: true, mode: "config", runtime: "v16.13.0",
    configured: { image: true, sceneModel: true, quality: true, aigcMetadata: true }, hasOpenId: true,
  });
  assert.equal(calls.generate.length + calls.scene.length, 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(DIAGNOSE_TOKEN));
});

test("试读画面用虚构段落，不读任何人的书稿", async () => {
  const { diagnostics, calls } = diagnosticsHarness();
  const result = await diagnostics.run(ctx, { action: "diagnose", diagnoseToken: DIAGNOSE_TOKEN, sample: "scene" });
  assert.equal(result.ok, true);
  assert.equal(calls.scene[0], DIAGNOSTIC_CHAPTER);
  assert.match(DIAGNOSTIC_CHAPTER.text, /虚构段落，不属于任何真实故事/);
  assert.match(result.steps[0].prompt, /河边的石桥/);
  assert.equal(calls.drafts, 0);
});

test("试画一张：出图、下载、存云存储、送审、质检每步都记下耗时，图单独存放、不进任何书稿", async () => {
  const { diagnostics, calls, repo } = diagnosticsHarness();
  const result = await diagnostics.run(ctx, { action: "diagnose", diagnoseToken: DIAGNOSE_TOKEN, sample: "image" });
  assert.equal(result.ok, true);
  assert.equal(result.jobStatus, "stored");
  assert.deepEqual(result.steps.map(item => [item.name, item.ok]), [
    ["generate", true], ["download", true], ["aigcMetadata", true], ["upload", true], ["moderation", true], ["quality", true],
  ]);
  assert.ok(result.steps.every(item => typeof item.ms === "number"));
  assert.deepEqual([calls.generate[0].width, calls.generate[0].height], [1024, 768]);
  assert.match(calls.generate[0].prompt, /石桥/);
  assert.match(calls.upload[0], /^story-images\/_diagnostics\/req-diag-/);
  assert.equal(calls.aigc.length, 1);
  assert.equal(calls.uploadBuffers[0].toString(), "png-with-aigc");
  assert.deepEqual(calls.moderation, [{ fileID: result.fileID, openid: OWNER_OPENID }]);
  assert.equal(result.viewUrl, "https://tmp.example/d.png");
  const image = repo.images.get(result.imageId);
  assert.equal(image.familyId, "_diagnostics");
  assert.equal(image.purpose, "diagnostic");
  assert.equal(image.bytes, calls.uploadBuffers[0].length);
  assert.equal(image.aigcProduceId, calls.aigc[0].produceId);
  const job = repo.jobs.get(image.jobId);
  assert.equal(job.aigcProduceId, image.aigcProduceId);
  assert.equal(image.quality, "pass");
  assert.equal(image.moderationTraceId, "trace-d");
  assert.equal(calls.drafts, 0);
});

test("云端测试没带微信身份时跳过内容审核并说明原因，其余照常", async () => {
  const { diagnostics, calls } = diagnosticsHarness();
  const result = await diagnostics.run({ openid: "" }, { action: "diagnose", diagnoseToken: DIAGNOSE_TOKEN, sample: "image" });
  const moderationStep = result.steps.find(item => item.name === "moderation");
  assert.equal(moderationStep.skipped, true);
  assert.equal(moderationStep.error.code, "NO_OPENID");
  assert.equal(calls.moderation.length, 0);
  assert.equal(result.ok, true);
  assert.equal(result.hasOpenId, false);
});

test("试画被 TokenHub 审核拦下时停在出图这一步，不存文件", async () => {
  const { diagnostics, calls, repo } = diagnosticsHarness({
    provider: { async generate() { const error = new Error("TOKENHUB_HTTP_422"); error.httpStatus = 422; throw error; } },
  });
  const result = await diagnostics.run(ctx, { action: "diagnose", diagnoseToken: DIAGNOSE_TOKEN, sample: "image" });
  assert.equal(result.ok, false);
  assert.equal(result.jobStatus, "blocked");
  assert.deepEqual(result.steps.map(item => item.name), ["generate"]);
  assert.deepEqual(result.steps[0].error, { code: "HTTP_422", message: "TOKENHUB_HTTP_422" });
  assert.equal(calls.upload.length, 0);
  assert.equal([...repo.jobs.values()][0].status, "blocked");
});

test("没配出图密钥时说明缺哪项，不留记录", async () => {
  const { diagnostics, repo } = diagnosticsHarness({ provider: { configured: false } });
  const result = await diagnostics.run(ctx, { action: "diagnose", diagnoseToken: DIAGNOSE_TOKEN, sample: "image" });
  assert.equal(result.ok, false);
  assert.equal(result.steps[0].error.code, "IMAGE_NOT_CONFIGURED");
  assert.equal(repo.jobs.size, 0);
});

test("诊断没配 AIGC 隐式标识时不调用付费生图", async () => {
  const { diagnostics, calls, repo } = diagnosticsHarness({ deps: { aigcMetadata: { configured: false } } });
  const result = await diagnostics.run(ctx, { action: "diagnose", diagnoseToken: DIAGNOSE_TOKEN, sample: "image" });
  assert.equal(result.ok, false);
  assert.equal(result.steps[0].error.code, "AIGC_METADATA_NOT_CONFIGURED");
  assert.equal(calls.generate.length, 0);
  assert.equal(repo.jobs.size, 0);
});

test("诊断写入 AIGC 隐式标识失败时将任务记为失败并保留结果链接", async () => {
  const { diagnostics, calls, repo } = diagnosticsHarness({
    deps: {
      aigcMetadata: {
        configured: true,
        writeForSource() { const error = new Error("secret detail"); error.code = "AIGC_PRODUCE_ID_REQUIRED"; throw error; },
      },
    },
  });
  const result = await diagnostics.run(ctx, { action: "diagnose", diagnoseToken: DIAGNOSE_TOKEN, sample: "image" });
  assert.equal(result.ok, false);
  assert.equal(result.jobStatus, "failed");
  assert.deepEqual(result.steps.map(item => item.name), ["generate", "download", "aigcMetadata"]);
  const job = [...repo.jobs.values()][0];
  assert.equal(job.status, "failed");
  assert.equal(job.errorCode, "AIGC_PRODUCE_ID_REQUIRED");
  assert.equal(job.resultUrl, "https://result.example/d.png");
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.moderation.length, 0);
  assert.equal(repo.images.size, 0);
  assert.doesNotMatch(JSON.stringify(result), /secret detail/);
});

test("试画每天最多 3 张", async () => {
  const { diagnostics, repo } = diagnosticsHarness();
  for (let index = 0; index < 3; index++) {
    await repo.createJob(`_diagnostics_req-diag-old${index}`, { familyId: "_diagnostics", dayKey: "2026-09-13", status: "stored", createdAtMs: 0 });
  }
  await assert.rejects(diagnostics.run(ctx, { action: "diagnose", diagnoseToken: DIAGNOSE_TOKEN, sample: "image" }), error => error.code === "DIAGNOSE_LIMIT");
});

test("出图用掉大半时间时跳过质检，标为质检中交给定时任务", async () => {
  let h;
  h = diagnosticsHarness({
    provider: { async generate() { h.tick(50_000); return { resultUrl: "https://result.example/d.png", revisedPrompt: "", providerJobId: "t", usageTokens: 1 }; } },
  });
  const result = await h.diagnostics.run(ctx, { action: "diagnose", diagnoseToken: DIAGNOSE_TOKEN, sample: "image" });
  const qualityStep = result.steps.find(item => item.name === "quality");
  assert.equal(qualityStep.skipped, true);
  assert.equal(qualityStep.error.code, "NO_TIME");
  assert.equal(h.calls.quality.length, 0);
  assert.equal(h.repo.images.get(result.imageId).quality, "pending");
  assert.equal(result.totalMs, 50_000);
});

test("入口接上了诊断动作，由环境变量里的口令把关", () => {
  const index = fs.readFileSync(path.join(__dirname, "../cloudfunctions/storyImages/index.js"), "utf8");
  assert.match(index, /case "diagnose": return await diagnostics\.run\(ctx, event\);/);
  assert.match(index, /expectedToken: process\.env\.STORY_IMAGES_DIAGNOSE_TOKEN/);
});

// ---------- 共用的看图调用 ----------

test("看图调用：没配置时不发请求；配置后按 TokenHub 格式发文字和图片（链接或 base64），拿回模型的原话", async () => {
  const { createVisionClient, DEFAULT_MODEL } = require("../cloudfunctions/storyImages/vision.js");
  let calls = 0;
  const idle = createVisionClient({ apiKey: "", fetchImpl: async () => { calls++; return jsonResponse(200, {}); } });
  assert.equal(idle.configured, false);
  assert.deepEqual(await idle.ask({ text: "看看", images: ["https://x/1.png"] }), { ok: false, errorCode: "VISION_NOT_CONFIGURED" });
  assert.equal(calls, 0);

  let sent;
  const client = createVisionClient({
    apiKey: "k", baseUrl: "https://vision.example/v1/",
    fetchImpl: async (url, init) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return jsonResponse(200, { choices: [{ message: { content: "院子里晒着被子" } }] });
    },
  });
  const answer = await client.ask({ text: "用一句话说说", images: ["https://x/1.png", "data:image/jpeg;base64,AAAA"] });
  assert.deepEqual(answer, { ok: true, content: "院子里晒着被子" });
  assert.equal(sent.url, "https://vision.example/v1/chat/completions");
  assert.equal(sent.headers.Authorization, "Bearer k");
  assert.equal(sent.body.model, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, "hy-vision-2.0-instruct");
  assert.equal(sent.body.temperature, 0);
  assert.deepEqual(sent.body.messages[0].content, [
    { type: "text", text: "用一句话说说" },
    { type: "image_url", image_url: { url: "https://x/1.png" } },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
  ]);
});

test("看图调用：被拒、超时、连不上都返回错误码，不抛异常", async () => {
  const { createVisionClient } = require("../cloudfunctions/storyImages/vision.js");
  const refused = createVisionClient({ apiKey: "k", fetchImpl: async () => jsonResponse(422, {}) });
  assert.deepEqual(await refused.ask({ text: "t", images: [] }), { ok: false, errorCode: "VISION_HTTP_422", httpStatus: 422 });
  const timedOut = createVisionClient({ apiKey: "k", fetchImpl: async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; } });
  assert.deepEqual(await timedOut.ask({ text: "t", images: [] }), { ok: false, errorCode: "VISION_TIMEOUT" });
  const offline = createVisionClient({ apiKey: "k", fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.deepEqual(await offline.ask({ text: "t", images: [] }), { ok: false, errorCode: "VISION_REQUEST_FAILED" });
});

// ---------- 看图写一句话 ----------

const captionModule = require("../cloudfunctions/storyImages/caption.js");
const { createPhotoReader } = require("../cloudfunctions/storyImages/photoReader.js");
const { createTextChecker } = require("../cloudfunctions/storyImages/textCheck.js");

function captionHarness({ photos, vision = {}, checkText = async () => ({ ok: true }), readError } = {}) {
  const logs = new Map();
  const calls = { read: [], ask: [], checkText: [] };
  const repo = {
    logs,
    async getCaptionLog(id) { return logs.get(id); },
    async createCaptionLog(id, data) { logs.set(id, { ...data, _id: id }); },
    async updateCaptionLog(id, patch) { logs.set(id, { ...logs.get(id), ...patch }); },
    async countCaptionLogs({ requesterOpenId, dayKey, statuses }) {
      return [...logs.values()].filter(item => item.requesterOpenId === requesterOpenId && item.dayKey === dayKey && statuses.includes(item.status)).length;
    },
  };
  const handler = captionModule.createCaptionHandler({
    repo,
    vision: {
      configured: true,
      model: "hy-vision-2.0-instruct",
      async ask(input) { calls.ask.push(input); return { ok: true, content: "清晨的小院里晾着棉被。\n补充说明" }; },
      ...vision,
    },
    async readPhotos(input) {
      calls.read.push(input);
      if (readError) throw readError;
      return photos || input.photoIds.map(photoId => ({ photoId, status: "ok", url: `https://tmp.example/${photoId}.jpg` }));
    },
    async checkText(input) { calls.checkText.push(input); return checkText(input); },
    now: () => T0,
    log: { error() {} },
  });
  return { handler, repo, calls };
}

const captionEvent = (requestId = "req-caption-0001", photoIds = ["photo-abc-1"]) => ({ action: "caption", familyId: FAMILY, requestId, photoIds });

test("看图写一句话校验家庭、请求和 1 到 3 张不重复照片", () => {
  assert.deepEqual(captionModule.normalizeCaptionInput(captionEvent()), { familyId: FAMILY, requestId: "req-caption-0001", photoIds: ["photo-abc-1"] });
  assert.throws(() => captionModule.normalizeCaptionInput({ ...captionEvent(), familyId: "../family" }), error => error.code === "INVALID_FAMILY");
  assert.throws(() => captionModule.normalizeCaptionInput(captionEvent("bad")), error => error.code === "INVALID_REQUEST");
  assert.throws(() => captionModule.normalizeCaptionInput(captionEvent("req-caption-0001", [])), error => error.code === "INVALID_PHOTOS");
  assert.throws(() => captionModule.normalizeCaptionInput(captionEvent("req-caption-0001", ["photo-a1", "photo-a1"])), error => error.code === "INVALID_PHOTOS");
});

test("看图写一句话通过 photoAccess 取临时链接，文字过检后才返回 AI 草稿", async () => {
  const { handler, repo, calls } = captionHarness();
  const result = await handler.caption(ctx, captionEvent("req-caption-ok01", ["photo-abc-1", "photo-abc-2"]));
  assert.deepEqual(result, { status: "ok", caption: "清晨的小院里晾着棉被", aiGenerated: true, message: "" });
  assert.deepEqual(calls.read[0], {
    familyId: FAMILY, photoIds: ["photo-abc-1", "photo-abc-2"], variant: "small", purpose: "ai-caption", onBehalfOfOpenid: OWNER_OPENID,
  });
  assert.deepEqual(calls.ask[0].images, ["https://tmp.example/photo-abc-1.jpg", "https://tmp.example/photo-abc-2.jpg"]);
  assert.deepEqual(calls.checkText, [{ text: "清晨的小院里晾着棉被", openid: OWNER_OPENID }]);
  const saved = repo.logs.get(`${FAMILY}_req-caption-ok01`);
  assert.equal(saved.status, "ok");
  assert.doesNotMatch(JSON.stringify(saved), /清晨|棉被|tmp\.example/);
});

test("照片违规或文字未明确通过时不调用下一步、不给用户 AI 草稿", async () => {
  const riskyPhoto = captionHarness({ photos: [{ photoId: "photo-abc-1", status: "risky" }] });
  assert.deepEqual(await riskyPhoto.handler.caption(ctx, captionEvent("req-caption-risk")), {
    status: "photo_unavailable", message: "这张照片没通过平台审核", photos: [{ photoId: "photo-abc-1", status: "risky" }], aiGenerated: false,
  });
  assert.equal(riskyPhoto.calls.ask.length, 0);

  const riskyText = captionHarness({ checkText: async () => ({ ok: false, risky: true, errorCode: "TEXT_RISKY" }) });
  assert.deepEqual(await riskyText.handler.caption(ctx, captionEvent("req-caption-text")), {
    status: "text_blocked", message: "没看出来，自己写一句吧", aiGenerated: false,
  });
  assert.equal(riskyText.repo.logs.get(`${FAMILY}_req-caption-text`).status, "text_blocked");
});

test("photoAccess 只认约定状态并保留请求顺序，不直接读照片存储", async () => {
  let sent;
  const reader = createPhotoReader({
    internalToken: "internal-token",
    async callFunction(options) {
      sent = options;
      return { result: { photos: [{ photoId: "photo-b", status: "risky" }, { photoId: "photo-a", status: "ok", url: "https://tmp/a" }] } };
    },
  });
  const photos = await reader.read({ familyId: FAMILY, photoIds: ["photo-a", "photo-b", "photo-c"], variant: "small", purpose: "ai-caption", onBehalfOfOpenid: OWNER_OPENID });
  assert.deepEqual(sent, {
    name: "photoAccess",
    data: { action: "read", familyId: FAMILY, photoIds: ["photo-a", "photo-b", "photo-c"], variant: "small", purpose: "ai-caption", onBehalfOfOpenid: OWNER_OPENID, internalToken: "internal-token" },
  });
  assert.deepEqual(photos.map(photo => [photo.photoId, photo.status]), [["photo-a", "ok"], ["photo-b", "risky"], ["photo-c", "not_found"]]);
});

test("生成文字直接用当前用户 openid 审核，接口失败时按未通过处理", async () => {
  let sent;
  const checker = createTextChecker({ async msgSecCheck(options) { sent = options; return { result: { suggest: "pass", label: 100 } }; } });
  assert.deepEqual(await checker.check({ text: "院子里晒着棉被", openid: OWNER_OPENID }), { ok: true, suggest: "pass", label: 100 });
  assert.deepEqual(sent, { content: "院子里晒着棉被", version: 2, scene: 3, openid: OWNER_OPENID });
  const risky = createTextChecker({ async msgSecCheck() { return { result: { suggest: "review", label: 200 } }; } });
  assert.deepEqual(await risky.check({ text: "文字", openid: OWNER_OPENID }), { ok: false, risky: true, errorCode: "TEXT_RISKY", suggest: "review", label: 200 });
  const broken = createTextChecker({ async msgSecCheck() { throw new Error("offline"); } });
  assert.equal((await broken.check({ text: "文字", openid: OWNER_OPENID })).ok, false);
});

test("每天看图额度按微信账号统计，同一请求不会重复调用", async () => {
  const { handler, repo, calls } = captionHarness();
  for (let index = 0; index < 30; index++) {
    await repo.createCaptionLog(`used-${index}`, { requesterOpenId: OWNER_OPENID, dayKey: "2026-09-13", status: "ok" });
  }
  await assert.rejects(handler.caption(ctx, captionEvent("req-caption-over")), error => error.code === "CAPTION_LIMIT");
  assert.equal(calls.read.length, 0);

  const fresh = captionHarness();
  await fresh.handler.caption(ctx, captionEvent("req-caption-same"));
  await assert.rejects(fresh.handler.caption(ctx, captionEvent("req-caption-same")), error => error.code === "DUPLICATE_REQUEST");
  assert.equal(fresh.calls.ask.length, 1);
});

test("全书封面复用出图状态机，带末章上下文且同请求重试不重复付费", async () => {
  const h = harness({deps:{coverServices:{prepare:async()=>[]}}});
  const storyId = 'story-cover-book';
  h.repo.setDrafts([{familyId:FAMILY,storyId,draftType:'story-revision',revision:{id:'revision-cover',storyId,savedAt:'2026-09-23',draft:{title:'全书',chapters:[CHAPTER,{id:'last',title:'结尾',content:[{text:'成年后在海边安家。'}]}]}}}]);
  const event={familyId:FAMILY,storyId,purpose:'cover',coverConsent:true,requestId:'req-cover-12345678',referenceImageIds:[],referencePhotoIds:[]};
  const first=await h.handlers.submit(ctx,event);
  assert.equal(first.job.status,'queued');
  assert.match(h.calls.scene[0].text,/海边安家/);
  assert.equal(h.calls.scene[0].scope,'book');
  await h.handlers.submit(ctx,event);
  assert.equal(h.calls.scene.length,1);
  await assert.rejects(h.handlers.submit(ctx,{...event,referencePhotoIds:['photo-other']}),{code:'REQUEST_CONFLICT'});
  const result=await h.handlers.status(ctx,{familyId:FAMILY,storyId,jobId:first.job.jobId});
  assert.equal(result.job.status,'stored');
  assert.equal(result.image.purpose,'cover');
  assert.equal(h.calls.generate[0].width,768);
  assert.equal(h.calls.generate[0].height,1024);
  assert.equal(h.calls.aigc.length,1);
  await h.handlers.status(ctx,{familyId:FAMILY,storyId,jobId:first.job.jobId});
  assert.equal(h.calls.generate.length,1);
});
