const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const core = require("../cloudfunctions/storyImages/core.js");
const hunyuan = require("../cloudfunctions/storyImages/hunyuan.js");
const scene = require("../cloudfunctions/storyImages/scene.js");
const quality = require("../cloudfunctions/storyImages/quality.js");
const { createStoryImageHandlers } = require("../cloudfunctions/storyImages/flow.js");

const OWNER_OPENID = "o-owner";
const FAMILY = "family_o-owner";

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

function memoryRepo() {
  const jobs = new Map();
  const images = new Map();
  let drafts = [];
  return {
    jobs,
    images,
    setDrafts(records) { drafts = records; },
    async getJob(id) { const job = jobs.get(id); return job && { ...job }; },
    async createJob(id, data) { jobs.set(id, { ...data, _id: id }); },
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
    async countJobs({ familyId, memberId, dayKey, statuses }) {
      return [...jobs.values()].filter(job => job.familyId === familyId &&
        (!memberId || job.memberId === memberId) && (!dayKey || job.dayKey === dayKey) &&
        statuses.includes(job.status)).length;
    },
    async listDraftRecords(familyId, memberId) {
      return drafts.filter(record => record.familyId === familyId && record.memberId === memberId);
    },
    async createImage(id, data) { images.set(id, { ...data, _id: id }); },
    async getImage(id) { const image = images.get(id); return image && { ...image }; },
    async updateImage(id, patch) { images.set(id, { ...images.get(id), ...patch }); },
    async listImages(familyId, memberId) {
      return [...images.values()].filter(image => image.familyId === familyId && image.memberId === memberId &&
        image.deletedAtMs === undefined);
    },
    async listRecentJobs(familyId, memberId, sinceMs) {
      return [...jobs.values()].filter(job => job.familyId === familyId && job.memberId === memberId &&
        job.createdAtMs >= sinceMs);
    },
    async findImageByTrace(traceId) { return [...images.values()].find(image => image.moderationTraceId === traceId); },
    async listActiveJobs(limit) {
      return [...jobs.values()].filter(job => core.ACTIVE_STATUSES.includes(job.status)).slice(0, limit);
    },
  };
}

function harness({ provider = {}, deps = {} } = {}) {
  const repo = memoryRepo();
  repo.setDrafts([revisionRecord({ id: "revision-2", savedAt: "2026-09-12T10:00:00.000Z", chapters: [CHAPTER] })]);
  let clock = Date.parse("2026-09-13T02:00:00.000Z");
  const calls = { scene: [], submit: [], query: [], download: [], upload: [], remove: [], moderation: [] };
  const handlers = createStoryImageHandlers({
    repo,
    provider: {
      name: "hunyuan",
      model: "hunyuan-image-3.0",
      configured: true,
      async submit(input) { calls.submit.push(input); return { providerJobId: "hunyuan-job-1" }; },
      async query(id) {
        calls.query.push(id);
        return { state: "done", imageUrl: "https://result.example/1.png", revisedPrompt: "" };
      },
      ...provider,
    },
    sceneConfigured: true,
    async extractScene(source) {
      calls.scene.push(source);
      return { scene: "冬天的院子里晒着被子", objects: ["竹竿", "棉被"], light: "冬日午后", mood: "安静", eraHint: "", figures: [] };
    },
    storage: {
      async upload(cloudPath) { calls.upload.push(cloudPath); return `cloud://env/${cloudPath}`; },
      async tempUrls(fileIDs) { return Object.fromEntries(fileIDs.map(id => [id, `https://tmp.example/${encodeURIComponent(id)}`])); },
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

// ---------- 腾讯云签名 ----------

test("TC3 签名的规范请求与待签字符串和腾讯云官方示例一致", () => {
  const payload = '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}';
  const canonical = hunyuan.canonicalRequest({ host: "cvm.tencentcloudapi.com", action: "DescribeInstances", payload });
  assert.equal(
    crypto.createHash("sha256").update(payload).digest("hex"),
    "35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064",
  );
  assert.equal(canonical.text, [
    "POST",
    "/",
    "",
    "content-type:application/json; charset=utf-8",
    "host:cvm.tencentcloudapi.com",
    "x-tc-action:describeinstances",
    "",
    "content-type;host;x-tc-action",
    "35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064",
  ].join("\n"));
  const toSign = hunyuan.stringToSign({ timestamp: 1551113065, service: "cvm", canonical: canonical.text });
  assert.equal(toSign.text, [
    "TC3-HMAC-SHA256",
    "1551113065",
    "2019-02-25/cvm/tc3_request",
    "7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84",
  ].join("\n"));
});

test("混元请求头带上动作、版本、地域和按 UTC 日期计算的凭证范围", () => {
  const headers = hunyuan.signRequest({
    secretId: "AKIDTEST", secretKey: "secret", action: "SubmitTextToImageJob",
    region: "ap-guangzhou", timestamp: 1757721600, payload: "{}",
  });
  assert.equal(headers["X-TC-Action"], "SubmitTextToImageJob");
  assert.equal(headers["X-TC-Version"], "2022-12-29");
  assert.equal(headers["X-TC-Region"], "ap-guangzhou");
  assert.equal(headers.Host, "aiart.tencentcloudapi.com");
  assert.match(headers.Authorization,
    /^TC3-HMAC-SHA256 Credential=AKIDTEST\/2025-09-13\/aiart\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/);
});

test("混元提交任务关闭提示词改写、保留 AI 生成标识", async () => {
  let sent;
  const client = hunyuan.createHunyuanClient({
    secretId: "id", secretKey: "key",
    now: () => 1757721600000,
    fetchImpl: async (url, init) => {
      sent = { url, init };
      return { ok: true, status: 200, json: async () => ({ Response: { JobId: "job-9", RequestId: "r" } }) };
    },
  });
  assert.deepEqual(await client.submit({ prompt: "画面", width: 1024, height: 768 }), { providerJobId: "job-9" });
  assert.equal(sent.url, "https://aiart.tencentcloudapi.com");
  assert.deepEqual(JSON.parse(sent.init.body), { Prompt: "画面", Resolution: "1024:768", Revise: 0, LogoAdd: 1 });
});

test("混元返回的错误带着错误码抛出，便于区分审核拦截和普通失败", async () => {
  const client = hunyuan.createHunyuanClient({
    secretId: "id", secretKey: "key",
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ Response: { Error: { Code: "OperationDenied.TextIllegalDetected", Message: "x" } } }),
    }),
  });
  await assert.rejects(client.submit({ prompt: "p", width: 1, height: 1 }), error => {
    assert.equal(error.providerCode, "OperationDenied.TextIllegalDetected");
    return true;
  });
});

test("混元任务状态：进行中、完成、失败与审核拦截分开", () => {
  assert.deepEqual(hunyuan.mapQueryResponse({ JobStatusCode: "1" }), { state: "running" });
  assert.deepEqual(hunyuan.mapQueryResponse({ JobStatusCode: "2" }), { state: "running" });
  assert.deepEqual(
    hunyuan.mapQueryResponse({ JobStatusCode: "5", ResultImage: ["https://x/1.png"], RevisedPrompt: ["改写"] }),
    { state: "done", imageUrl: "https://x/1.png", revisedPrompt: "改写" },
  );
  assert.deepEqual(hunyuan.mapQueryResponse({ JobStatusCode: "5", ResultImage: [] }), { state: "failed", errorCode: "EMPTY_RESULT" });
  assert.deepEqual(
    hunyuan.mapQueryResponse({ JobStatusCode: "4", JobErrorCode: "OperationDenied.ImageIllegalDetected" }),
    { state: "blocked", errorCode: "OperationDenied.ImageIllegalDetected" },
  );
  assert.deepEqual(
    hunyuan.mapQueryResponse({ JobStatusCode: "4", JobErrorCode: "FailedOperation.ServerError" }),
    { state: "failed", errorCode: "FailedOperation.ServerError" },
  );
});

test("结果图链接失效时标记为过期，其他下载错误可以稍后重试", async () => {
  await assert.rejects(
    hunyuan.downloadResult("https://x/1.png", { fetchImpl: async () => ({ ok: false, status: 403 }) }),
    error => error.expired === true,
  );
  await assert.rejects(
    hunyuan.downloadResult("https://x/1.png", { fetchImpl: async () => ({ ok: false, status: 502 }) }),
    error => !error.expired,
  );
  const image = await hunyuan.downloadResult("https://x/1.png", {
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: () => "image/jpeg; charset=binary" },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }),
  });
  assert.equal(image.contentType, "image/jpeg");
  assert.equal(image.buffer.length, 3);
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
  assert.throws(() => core.normalizeSubmitInput({ ...submitEvent(), purpose: "cover" }), error => error.code === "PURPOSE_NOT_YET");
  assert.throws(() => core.normalizeSubmitInput({ ...submitEvent(), purpose: "poster" }), error => error.code === "INVALID_PURPOSE");
  assert.throws(() => core.normalizeSubmitInput({ ...submitEvent(), requestId: "../x" }), error => error.code === "INVALID_REQUEST");
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

test("限额：每天 10 张、每个故事 30 张，按北京时间换日", () => {
  assert.deepEqual(core.quotaDecision({ todayCount: 9, bookCount: 29 }), { allowed: true });
  assert.equal(core.quotaDecision({ todayCount: 10, bookCount: 0 }).code, "DAILY_LIMIT");
  assert.equal(core.quotaDecision({ todayCount: 0, bookCount: 30 }).code, "BOOK_LIMIT");
  assert.ok(!core.COUNTED_STATUSES.includes("failed"));
  assert.ok(!core.COUNTED_STATUSES.includes("blocked"));
  assert.ok(core.COUNTED_STATUSES.includes("unknown"));
  assert.equal(core.chinaDayKey(Date.parse("2026-09-12T16:30:00.000Z")), "2026-09-13");
  assert.equal(core.chinaDayKey(Date.parse("2026-09-12T15:59:00.000Z")), "2026-09-12");
});

test("模型给的画面只保留约定字段，清掉控制字符并限制长度", () => {
  const parsed = core.parseSceneJson('好的：{"scene":"院子里\\u0007晒被子。","objects":["竹竿","棉被","","a","b","c","d","e"],"light":"冬天","mood":"安静","eraHint":"","figures":["远景中的背影"],"extra":"忽略"}');
  assert.deepEqual(parsed, {
    scene: "院子里 晒被子", objects: ["竹竿", "棉被", "a", "b", "c", "d"], light: "冬天",
    mood: "安静", eraHint: "", figures: ["远景中的背影"], setting: "",
  });
  assert.throws(() => core.parseSceneJson("没有 JSON"), error => error.code === "SCENE_PARSE_FAILED");
  assert.throws(() => core.parseSceneJson('{"objects":["棉被"]}'), error => error.code === "SCENE_PARSE_FAILED");
});

test("出图提示词只用肯定式描述，不列禁止画的东西", () => {
  const { prompt, width, height } = core.buildImagePrompt(
    { scene: "冬天的院子里晒着被子", objects: ["竹竿", "棉被"], light: "冬日午后", mood: "安静", eraHint: "", figures: ["远景中的背影"] },
    "illustration",
  );
  assert.equal(width, 1024);
  assert.equal(height, 768);
  assert.match(prompt, /纸本淡彩水彩插画/);
  assert.match(prompt, /画中有竹竿、棉被。/);
  assert.match(prompt, /人物以远景或局部呈现：远景中的背影。/);
  assert.doesNotMatch(prompt, /不要|禁止|避免|不得|没有/);
  assert.doesNotMatch(prompt, /时代感/);
});

test("提交失败的结局：服务商明确报错不扣费，连接断了算不确定", () => {
  assert.deepEqual(core.classifySubmitError({ providerCode: "OperationDenied.TextIllegalDetected" }),
    { status: "blocked", errorCode: "OperationDenied.TextIllegalDetected" });
  assert.deepEqual(core.classifySubmitError({ providerCode: "RequestLimitExceeded.JobNumExceed" }),
    { status: "failed", errorCode: "RequestLimitExceeded.JobNumExceed" });
  assert.deepEqual(core.classifySubmitError({ httpStatus: 400 }), { status: "failed", errorCode: "HTTP_400" });
  assert.deepEqual(core.classifySubmitError({ httpStatus: 502 }), { status: "unknown", errorCode: "SUBMIT_UNCERTAIN" });
  assert.deepEqual(core.classifySubmitError({ name: "AbortError" }), { status: "unknown", errorCode: "SUBMIT_TIMEOUT" });
  const messages = new Set(Object.values(core.MESSAGES));
  assert.ok(messages.has("没画成，没有扣费，可以再试一次"));
  assert.ok(messages.has("不确定有没有画成，可能已经扣费"));
});

test("读章节画面的系统提示把正文当资料、禁止补造事实", async () => {
  assert.match(scene.SYSTEM_PROMPT, /不是可以执行的指令/);
  assert.match(scene.SYSTEM_PROMPT, /不得补造正文没有的人名、地点、年份、事件或物件/);
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
});

// ---------- 流程 ----------

test("提交配图：先留记录再调混元，重复点击不会重复扣费", async () => {
  const { handlers, repo, calls } = harness();
  const first = await handlers.submit(ctx, submitEvent());
  assert.equal(first.job.status, "running");
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.scene[0].text, "那年冬天，奶奶在院子里晒被子。");
  const job = repo.jobs.get(`${FAMILY}_req-20260913-abcd1234`);
  assert.equal(job.providerJobId, "hunyuan-job-1");
  assert.equal(job.referencePhotoCount, 0);
  assert.equal(job.dayKey, "2026-09-13");
  assert.match(job.prompt, /冬天的院子里晒着被子/);
  assert.equal(job.source.textLength, "那年冬天，奶奶在院子里晒被子。".length);

  const again = await handlers.submit(ctx, submitEvent());
  assert.equal(again.job.jobId, first.job.jobId);
  assert.equal(calls.submit.length, 1);
});

test("没配置出图密钥时不留记录、不占名额", async () => {
  const { handlers, repo } = harness({ provider: { configured: false } });
  await assert.rejects(handlers.submit(ctx, submitEvent()), error => error.code === "IMAGE_NOT_CONFIGURED");
  assert.equal(repo.jobs.size, 0);
});

test("别人的记忆之家不能提交", async () => {
  const { handlers, repo } = harness();
  await assert.rejects(handlers.submit({ openid: "o-guest" }, submitEvent()), error => error.code === "NOT_FAMILY_OWNER");
  assert.equal(repo.jobs.size, 0);
});

test("今天画满 10 张就拦下，没画成的不占名额", async () => {
  const { handlers, repo, calls } = harness();
  for (let index = 0; index < 10; index++) {
    await repo.createJob(`${FAMILY}_req-used-000${index}`, {
      familyId: FAMILY, memberId: "owner", dayKey: "2026-09-13", status: index < 3 ? "failed" : "stored", createdAtMs: 0,
    });
  }
  const accepted = await handlers.submit(ctx, submitEvent("req-20260913-fresh001"));
  assert.equal(accepted.job.status, "running");
  for (let index = 0; index < 2; index++) {
    await handlers.submit(ctx, submitEvent(`req-20260913-more000${index}`));
  }
  await assert.rejects(handlers.submit(ctx, submitEvent("req-20260913-over0001")), error => error.code === "DAILY_LIMIT");
  assert.equal(calls.submit.length, 3);
  assert.equal(repo.jobs.has(`${FAMILY}_req-20260913-over0001`), false);
});

test("提交时连接断了记为不确定，照样占名额，也不自动重试", async () => {
  const { handlers, repo, calls } = harness({
    provider: { async submit() { const error = new Error("aborted"); error.name = "AbortError"; throw error; } },
  });
  const result = await handlers.submit(ctx, submitEvent());
  assert.equal(result.job.status, "unknown");
  assert.equal(result.job.message, "不确定有没有画成，可能已经扣费");
  assert.equal(repo.jobs.get(result.job.jobId).errorCode, "SUBMIT_TIMEOUT");
  assert.equal(await repo.countJobs({ familyId: FAMILY, statuses: core.COUNTED_STATUSES }), 1);
  assert.equal(calls.submit.length, 0);
});

test("读不懂章节画面时记为没画成，不调用混元", async () => {
  const { handlers, calls } = harness({
    deps: { async extractScene() { throw new core.StoryImageError("SCENE_PARSE_FAILED", "x"); } },
  });
  const result = await handlers.submit(ctx, submitEvent());
  assert.equal(result.job.status, "failed");
  assert.equal(calls.submit.length, 0);
});

test("画好后转存进云存储、登记图片、送去内容安全检测；并发查询只转存一次", async () => {
  const { handlers, repo, calls } = harness();
  const { job } = await handlers.submit(ctx, submitEvent());
  const [first, second] = await Promise.all([
    handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId }),
    handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId }),
  ]);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0], "story-images/family_o-owner/owner/req-20260913-abcd1234.png");
  const stored = [first, second].find(result => result.image);
  assert.equal(stored.job.status, "stored");
  assert.equal(stored.image.chapterId, "chapter-1");
  assert.equal(stored.image.aiGenerated, true);
  assert.match(stored.image.url, /^https:\/\/tmp\.example\//);
  const image = repo.images.get(`${FAMILY}_img_req-20260913-abcd1234`);
  assert.equal(image.moderation, "pending");
  assert.equal(image.moderationTraceId, "trace-1");
  assert.deepEqual(calls.moderation, [{ fileID: image.fileID, openid: OWNER_OPENID }]);
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

test("混元审核拦下的任务显示没通过审核", async () => {
  const { handlers } = harness({
    provider: { async query() { return { state: "blocked", errorCode: "OperationDenied.ImageIllegalDetected" }; } },
  });
  const { job } = await handlers.submit(ctx, submitEvent());
  const result = await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(result.job.status, "blocked");
});

test("查询别人家的任务一律说找不到", async () => {
  const { handlers } = harness();
  const { job } = await handlers.submit(ctx, submitEvent());
  await assert.rejects(handlers.status({ openid: "o-guest" }, { familyId: "family_o-guest", jobId: job.jobId }),
    error => error.code === "JOB_NOT_FOUND");
});

test("定时兜底：卡住的提交记为不确定，卡住的转存放回重查，进行中的去查进度", async () => {
  const { handlers, repo, calls, tick } = harness({
    provider: { async query(id) { calls.query.push(id); return { state: "running" }; } },
  });
  await repo.createJob(`${FAMILY}_req-stuck-submit`, { familyId: FAMILY, memberId: "owner", status: "submitted", createdAtMs: Date.parse("2026-09-13T02:00:00.000Z"), updatedAtMs: Date.parse("2026-09-13T02:00:00.000Z") });
  await repo.createJob(`${FAMILY}_req-stuck-store`, { familyId: FAMILY, memberId: "owner", status: "storing", providerJobId: "p2", createdAtMs: Date.parse("2026-09-13T02:00:00.000Z"), updatedAtMs: Date.parse("2026-09-13T02:00:00.000Z") });
  await repo.createJob(`${FAMILY}_req-running-1`, { familyId: FAMILY, memberId: "owner", status: "running", providerJobId: "p3", createdAtMs: Date.parse("2026-09-13T02:00:00.000Z"), updatedAtMs: Date.parse("2026-09-13T02:00:00.000Z") });
  tick(4 * 60 * 1000);
  const result = await handlers.sweep();
  assert.equal(result.swept, 3);
  assert.equal(repo.jobs.get(`${FAMILY}_req-stuck-submit`).status, "unknown");
  assert.equal(repo.jobs.get(`${FAMILY}_req-stuck-store`).status, "running");
  assert.deepEqual(calls.query, ["p3"]);
});

test("管理页列出没删除、没被判违规的图，并算出占用空间；删除会删掉云存储文件", async () => {
  const { handlers, repo, calls } = harness();
  await repo.createImage(`${FAMILY}_img_a`, { familyId: FAMILY, memberId: "owner", chapterId: "chapter-1", purpose: "illustration", fileID: "cloud://a", bytes: 100, moderation: "pass", createdAtMs: 1, jobId: `${FAMILY}_req-a` });
  await repo.createImage(`${FAMILY}_img_b`, { familyId: FAMILY, memberId: "owner", chapterId: "chapter-1", purpose: "illustration", fileID: "cloud://b", bytes: 50, moderation: "pending", createdAtMs: 2 });
  await repo.createImage(`${FAMILY}_img_c`, { familyId: FAMILY, memberId: "owner", chapterId: "chapter-1", purpose: "illustration", fileID: "cloud://c", bytes: 999, moderation: "risky", createdAtMs: 3 });
  await repo.createJob(`${FAMILY}_req-a`, { familyId: FAMILY, memberId: "owner", status: "stored", createdAtMs: 1 });

  const listed = await handlers.list(ctx, { familyId: FAMILY, memberId: "owner" });
  assert.deepEqual(listed.images.map(image => image.imageId), [`${FAMILY}_img_b`, `${FAMILY}_img_a`]);
  assert.deepEqual(listed.usage, { count: 2, bytes: 150 });
  assert.deepEqual(listed.limits, { daily: 10, book: 30 });

  await handlers.remove(ctx, { familyId: FAMILY, imageId: `${FAMILY}_img_a` });
  assert.deepEqual(calls.remove, ["cloud://a"]);
  assert.ok(repo.images.get(`${FAMILY}_img_a`).deletedAtMs);
  assert.ok(repo.jobs.get(`${FAMILY}_req-a`).imageDeletedAtMs);
  assert.deepEqual((await handlers.list(ctx, { familyId: FAMILY, memberId: "owner" })).usage, { count: 1, bytes: 50 });
  await assert.rejects(handlers.remove(ctx, { familyId: FAMILY, imageId: `${FAMILY}_img_a` }), error => error.code === "IMAGE_NOT_FOUND");
});

test("内容安全检测判为违规的图会被隐藏并删除文件", async () => {
  const { handlers, repo, calls } = harness();
  await repo.createImage(`${FAMILY}_img_x`, { familyId: FAMILY, memberId: "owner", fileID: "cloud://x", moderation: "pending", moderationTraceId: "trace-x" });
  assert.deepEqual(await handlers.moderationResult({ trace_id: "trace-x", result: { suggest: "risky", label: 20002 } }), { ok: true });
  const image = repo.images.get(`${FAMILY}_img_x`);
  assert.equal(image.moderation, "risky");
  assert.ok(image.deletedAtMs);
  assert.deepEqual(calls.remove, ["cloud://x"]);
  assert.deepEqual(await handlers.moderationResult({ trace_id: "missing", result: { suggest: "pass" } }), { ok: false });
});

test("清空记忆之家时先删云存储里的配图文件，再删配图记录", () => {
  const fs = require("node:fs");
  const path = require("node:path");
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

// ---------- 阶段 2a：底图与质检 ----------

test("底图只画景物：上方留白、最多三个物件、没有人物，也不用描述情景的那句话", () => {
  const { prompt, width, height } = core.buildImagePrompt({
    scene: "奶奶在冬天的院子里晒被子", setting: "冬天的小院", objects: ["竹竿", "棉被", "木凳", "瓦罐"],
    light: "冬日午后", mood: "安静", eraHint: "", figures: ["远景中的背影"],
  }, "backdrop");
  assert.equal(width, 1248);
  assert.equal(height, 832);
  assert.match(prompt, /上方大面积是接近纯白的宣纸留白/);
  assert.match(prompt, /景物：冬天的小院。/);
  assert.match(prompt, /画中有竹竿、棉被、木凳。/);
  assert.doesNotMatch(prompt, /瓦罐/);
  assert.doesNotMatch(prompt, /奶奶|背影|人物/);
  assert.doesNotMatch(prompt, /不要|禁止|避免|不得|没有/);
});

test("提炼画面时单独要一个不含人物的地点，模型没给就留空", () => {
  assert.match(scene.SYSTEM_PROMPT, /setting：只写地点和环境本身，不写人物/);
  assert.equal(core.parseSceneJson('{"scene":"院子","setting":"冬天的小院。"}').setting, "冬天的小院");
  assert.equal(core.parseSceneJson('{"scene":"院子"}').setting, "");
  const { prompt } = core.buildImagePrompt({ scene: "院子", setting: "", objects: [], light: "", mood: "", eraHint: "", figures: [] }, "backdrop");
  assert.doesNotMatch(prompt, /景物：/);
});

test("提交底图按底图尺寸出图", async () => {
  const { handlers, calls, repo } = harness();
  const { job } = await handlers.submit(ctx, { ...submitEvent(), purpose: "backdrop" });
  assert.equal(job.purpose, "backdrop");
  assert.deepEqual([calls.submit[0].width, calls.submit[0].height], [1248, 832]);
  assert.doesNotMatch(calls.submit[0].prompt, /晒着被子/);
  assert.equal(repo.jobs.get(job.jobId).purpose, "backdrop");
});

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
  assert.match(quality.QUALITY_PROMPT, /「图片由AI生成」是规定必须保留的标识，不算问题/);
});

test("质检服务没配置、超时或出错时都记为没质检，不会当作通过", async () => {
  const notConfigured = quality.createQualityChecker({ apiKey: "" });
  assert.equal(notConfigured.configured, false);
  assert.deepEqual(await notConfigured.check("https://x/1.png"), { quality: "unchecked", qualityIssues: [], qualityNote: "", qualityError: "VISION_NOT_CONFIGURED" });

  let sent;
  const ok = quality.createQualityChecker({
    apiKey: "k",
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"readableText":false,"pseudoText":false,"watermarkOrLogo":false,"signature":false}' } }] }) };
    },
  });
  assert.equal((await ok.check("https://x/1.png")).quality, "pass");
  assert.equal(sent.url, "https://api.hunyuan.cloud.tencent.com/v1/chat/completions");
  assert.equal(sent.body.model, "hunyuan-vision");
  assert.deepEqual(sent.body.messages[0].content[1], { type: "image_url", image_url: { url: "https://x/1.png" } });

  const timeout = quality.createQualityChecker({ apiKey: "k", fetchImpl: async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; } });
  assert.equal((await timeout.check("https://x/1.png")).qualityError, "VISION_TIMEOUT");
  const broken = quality.createQualityChecker({ apiKey: "k", fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.deepEqual(await broken.check("https://x/1.png"), { quality: "unchecked", qualityIssues: [], qualityNote: "", qualityError: "VISION_HTTP_429" });
});

test("转存后用结果图做质检，发现乱码字就标出来给用户看", async () => {
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
  assert.deepEqual(checked, ["https://result.example/1.png"]);
  assert.equal(result.image.quality, "flawed");
  assert.deepEqual(result.image.qualityIssues, ["有乱码字"]);
  assert.equal(repo.images.get(`${FAMILY}_img_req-20260913-abcd1234`).qualityNote, "左上角有乱码");
});

test("没配置质检时图片照常转存，标为没质检", async () => {
  const { handlers } = harness();
  const { job } = await handlers.submit(ctx, submitEvent());
  const result = await handlers.status(ctx, { familyId: FAMILY, jobId: job.jobId });
  assert.equal(result.job.status, "stored");
  assert.equal(result.image.quality, "unchecked");
  assert.deepEqual(result.image.qualityIssues, []);
});

test("定时兜底超过 20 秒就不再开始新的任务，留到下一轮", async () => {
  const queried = [];
  let h;
  h = harness({ provider: { async query(id) { queried.push(id); h.tick(15_000); return { state: "running" }; } } });
  for (const id of ["a", "b", "c"]) {
    await h.repo.createJob(`${FAMILY}_req-sweep-00${id}`, {
      familyId: FAMILY, memberId: "owner", status: "running", providerJobId: `p-${id}`,
      createdAtMs: Date.parse("2026-09-13T02:00:00.000Z"), updatedAtMs: Date.parse("2026-09-13T02:00:00.000Z"),
    });
  }
  const result = await h.handlers.sweep();
  assert.deepEqual(queried, ["p-a", "p-b"]);
  assert.equal(result.swept, 2);
  assert.equal(result.deferred, 1);
  assert.equal(result.results[2].action, "deferred");
});
