import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BiographyDraft, FamilyRoomState, ManuscriptChapter } from "../miniprogram/domain/biography";
import { clearAiConsent } from "../miniprogram/services/aiConsent";
import { clearPhotoAiConsent } from "../miniprogram/services/photoAiConsent";
import { makeRevision } from "../miniprogram/services/manuscript";
import { withChapterBackdrop } from "../miniprogram/services/chapterBackdrop";
import { draftWithChapters } from "../miniprogram/services/chapters";
import { currentManuscript } from "../miniprogram/services/manuscript";
import { loadRoomStateRemoteFirst } from "../miniprogram/services/roomRepository";
import {
  formatBytes, isActiveJob, moderationLabel, newImageRequestId, nextPollDelayMs, qualityLabel, StoryImageList, StoryImageServiceError, storyImageApi,
} from "../miniprogram/services/storyImageService";
import { createDemoRoomStateForTests } from "./fixtures";

const ROOM_KEY = "shiguang-family-room-v5";
const CURRENT_MEMBER_KEY = "shiguang-current-member-v1";

type PageDefinition = { data?: Record<string, unknown>; [key: string]: unknown };
type PageInstance = PageDefinition & { data: Record<string, unknown>; setData(update: Record<string, unknown>): void };

const definitions = new Map<string, PageDefinition>();

async function pageDefinition(name: "story-images" | "book"): Promise<PageDefinition> {
  const cached = definitions.get(name);
  if (cached) return cached;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Page");
  let captured: PageDefinition | undefined;
  Object.defineProperty(globalThis, "Page", { configurable: true, writable: true, value: (definition: PageDefinition) => { captured = definition; } });
  try {
    if (name === "book") await import("../miniprogram/pages/book/book");
    else await import("../miniprogram/pages/story-images/story-images");
  } finally {
    if (previous) Object.defineProperty(globalThis, "Page", previous);
    else delete (globalThis as Record<string, unknown>).Page;
  }
  assert.ok(captured);
  definitions.set(name, captured);
  return captured;
}

function instantiate(definition: PageDefinition): PageInstance {
  const instance = { ...definition, data: structuredClone(definition.data ?? {}) } as PageInstance;
  instance.setData = update => Object.assign(instance.data, update);
  return instance;
}

function call(page: PageInstance, method: string, ...args: unknown[]): unknown {
  const fn = page[method];
  assert.equal(typeof fn, "function", `missing Page method ${method}`);
  return (fn as (...values: unknown[]) => unknown).apply(page, args);
}

function installWx(overrides: Record<string, unknown> = {}, state?: FamilyRoomState) {
  const stored = new Map<string, unknown>(state ? [[ROOM_KEY, state], [CURRENT_MEMBER_KEY, "owner"]] : []);
  const navigations: string[] = [];
  const previews: unknown[] = [];
  const previousWx = Object.getOwnPropertyDescriptor(globalThis, "wx");
  const previousApp = Object.getOwnPropertyDescriptor(globalThis, "getApp");
  Object.defineProperty(globalThis, "wx", {
    configurable: true,
    writable: true,
    value: {
      getStorageSync: (key: string) => stored.get(key),
      setStorageSync: (key: string, value: unknown) => stored.set(key, value),
      showToast: () => undefined,
      showModal: ({ success }: { success?: (result: { confirm: boolean; cancel: boolean }) => void }) => success?.({ confirm: true, cancel: false }),
      navigateTo: ({ url }: { url: string }) => navigations.push(url),
      previewImage: (options: unknown) => previews.push(options),
      enableAlertBeforeUnload: () => undefined,
      disableAlertBeforeUnload: () => undefined,
      ...overrides,
    },
  });
  return {
    navigations,
    previews,
    setApp(cloudReady: boolean) {
      Object.defineProperty(globalThis, "getApp", { configurable: true, writable: true, value: () => ({ globalData: { cloudReady } }) });
    },
    restore() {
      if (previousWx) Object.defineProperty(globalThis, "wx", previousWx);
      else delete (globalThis as Record<string, unknown>).wx;
      if (previousApp) Object.defineProperty(globalThis, "getApp", previousApp);
      else delete (globalThis as Record<string, unknown>).getApp;
    },
  };
}

function withApi(overrides: Partial<typeof storyImageApi>) {
  const original = { ...storyImageApi };
  Object.assign(storyImageApi, overrides);
  return () => Object.assign(storyImageApi, original);
}

const BACKDROP_ID = "family_o-owner_img_req-bbbbbbbb";

function stateWithBook(backdropImageId = ""): FamilyRoomState {
  const state = createDemoRoomStateForTests();
  const base: BiographyDraft = { title: "外婆的书", paragraphs: [], sourceCount: 0, generatedAt: "2026-09-13T00:00:00.000Z", generationMode: "local-demo" };
  let chapters: ManuscriptChapter[] = [
    { id: "chapter-a", title: "老院子", memoryIds: [], content: [{ text: "院子里晒着被子。\n" }] },
    { id: "chapter-b", title: "", memoryIds: [], content: [{ text: "第二章的文字。\n" }] },
  ];
  if (backdropImageId) chapters = withChapterBackdrop(chapters, "chapter-a", backdropImageId);
  state.manuscriptRevisions = [makeRevision("owner", draftWithChapters(base, chapters), "", "draft", "编辑存档")];
  return state;
}

function listWith(overrides: Partial<StoryImageList> = {}): StoryImageList {
  return {
    images: [
      { imageId: "family_o-owner_img_req-aaaaaaaa", chapterId: "chapter-a", purpose: "illustration", url: "https://tmp.example/a.png", bytes: 2048, moderation: "pending", quality: "flawed", qualityIssues: ["有乱码字"], aiGenerated: true, createdAtMs: 2 },
      { imageId: BACKDROP_ID, chapterId: "chapter-a", purpose: "backdrop", url: "https://tmp.example/b.png", bytes: 1024, moderation: "pass", quality: "pass", qualityIssues: [], aiGenerated: true, createdAtMs: 3 },
    ],
    pending: [{ jobId: "family_o-owner_req-b", status: "queued", message: "正在画，大约 20–60 秒。可以先离开，回来接着看", chapterId: "chapter-b", purpose: "illustration", imageId: "", createdAtMs: 3 }],
    usage: { count: 2, bytes: 3072 },
    limits: { daily: 10, book: 30 },
    ...overrides,
  };
}

function captureTimers() {
  const previousSet = globalThis.setTimeout;
  const previousClear = globalThis.clearTimeout;
  const scheduled: Array<{ delay: number; callback: () => void }> = [];
  globalThis.setTimeout = ((callback: () => void, delay: number) => { scheduled.push({ delay, callback }); return scheduled.length as unknown as ReturnType<typeof setTimeout>; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as unknown as typeof clearTimeout;
  return { scheduled, restore() { globalThis.setTimeout = previousSet; globalThis.clearTimeout = previousClear; } };
}

// ---------- 服务层 ----------

test("配图请求编号符合云函数的格式，轮询先快后慢，占用空间按 KB/MB 显示", () => {
  assert.match(newImageRequestId(Date.parse("2026-09-13T02:00:00.000Z"), () => 0.123456789), /^req-[0-9a-z-]{8,60}$/);
  assert.notEqual(newImageRequestId(), newImageRequestId());
  assert.equal(nextPollDelayMs(0), 3000);
  assert.equal(nextPollDelayMs(89_999), 3000);
  assert.equal(nextPollDelayMs(90_000), 10_000);
  assert.equal(formatBytes(0), "0 KB");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(3.5 * 1024 * 1024), "3.5 MB");
  assert.equal(isActiveJob({ status: "storing" }), true);
  assert.equal(isActiveJob({ status: "unknown" }), false);
  assert.equal(moderationLabel("pending"), "平台审核中");
  assert.equal(moderationLabel("pass"), "");
  assert.equal(qualityLabel({ quality: "flawed", qualityIssues: ["有乱码字", "有水印或 logo"] }), "有瑕疵：有乱码字、有水印或 logo");
  assert.equal(qualityLabel({ quality: "pass", qualityIssues: [] }), "");
  assert.equal(qualityLabel({ quality: "unchecked", qualityIssues: [] }), "没质检");
  assert.equal(qualityLabel({ quality: "pending", qualityIssues: [] }), "质检中");
  assert.equal(isActiveJob({ status: "queued" }), true);
  assert.equal(isActiveJob({ status: "generated" }), true);
});

test("提交配图先征得在线 AI 同意，再带着家庭、档案、章节和请求编号调用云函数", async context => {
  clearAiConsent();
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const env = installWx({
    cloud: {
      callFunction: async ({ name, data }: { name: string; data: Record<string, unknown> }) => {
        calls.push({ name, data });
        if (name === "getOpenId") return { result: { openid: "o-owner" } };
        return { result: { job: { jobId: "family_o-owner_req-x", status: "queued", message: "正在画", chapterId: "chapter-a", purpose: "illustration", imageId: "", createdAtMs: 1 } } };
      },
    },
  });
  env.setApp(true);
  context.after(() => { env.restore(); clearAiConsent(); });

  const job = await storyImageApi.submitChapterImage({ memberId: "owner", chapterId: "chapter-a", purpose: "illustration", requestId: "req-test-00000001" });
  assert.equal(job.status, "queued");
  const submit = calls.find(item => item.name === "storyImages");
  assert.deepEqual(submit?.data, {
    memberId: "owner", chapterId: "chapter-a", requestId: "req-test-00000001", purpose: "illustration",
    action: "submit", familyId: "family_o-owner",
  });
});

test("不同意在线 AI 时不调用配图云函数", async context => {
  clearAiConsent();
  const calls: string[] = [];
  const env = installWx({
    showModal: ({ success }: { success?: (result: { confirm: boolean; cancel: boolean }) => void }) => success?.({ confirm: false, cancel: true }),
    cloud: { callFunction: async ({ name }: { name: string }) => { calls.push(name); return { result: {} }; } },
  });
  env.setApp(true);
  context.after(() => { env.restore(); clearAiConsent(); });

  await assert.rejects(storyImageApi.submitChapterImage({ memberId: "owner", chapterId: "chapter-a", purpose: "backdrop" }),
    (error: unknown) => error instanceof StoryImageServiceError && error.code === "CONSENT_DECLINED");
  assert.deepEqual(calls, []);
});

test("看图写一句话单独征得照片授权，同一次打开不重复询问", async context => {
  clearPhotoAiConsent();
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  let modalCount = 0;
  const env = installWx({
    showModal: ({ success }: { success?: (result: { confirm: boolean; cancel: boolean }) => void }) => {
      modalCount += 1;
      success?.({ confirm: true, cancel: false });
    },
    cloud: {
      callFunction: async ({ name, data }: { name: string; data: Record<string, unknown> }) => {
        calls.push({ name, data });
        if (name === "getOpenId") return { result: { openid: "o-owner" } };
        return { result: { status: "ok", caption: "院子里晒着被子", message: "", aiGenerated: true } };
      },
    },
  });
  env.setApp(true);
  context.after(() => { env.restore(); clearPhotoAiConsent(); });

  await storyImageApi.captionPhotos({ photoIds: ["photo-a"], requestId: "req-caption-one1" });
  await storyImageApi.captionPhotos({ photoIds: ["photo-b"], requestId: "req-caption-two2" });
  assert.equal(modalCount, 1);
  assert.deepEqual(calls.filter(call => call.name === "storyImages").map(call => call.data), [
    { action: "caption", familyId: "family_o-owner", photoIds: ["photo-a"], requestId: "req-caption-one1" },
    { action: "caption", familyId: "family_o-owner", photoIds: ["photo-b"], requestId: "req-caption-two2" },
  ]);
});

test("云函数的明确错误、没部署和超时分别给出能看懂的提示", async context => {
  const env = installWx();
  env.setApp(true);
  context.after(env.restore);
  const wxMock = wx as unknown as { cloud: { callFunction: (options: { name: string }) => Promise<unknown> } };

  wxMock.cloud = { callFunction: async ({ name }) => name === "getOpenId" ? { result: { openid: "o-owner" } } : { result: { error: { code: "DAILY_LIMIT", message: "今天的 10 张画完了，明天再来" } } } };
  await assert.rejects(storyImageApi.listStoryImages("owner"),
    (error: unknown) => error instanceof StoryImageServiceError && error.code === "DAILY_LIMIT" && error.message === "今天的 10 张画完了，明天再来");

  wxMock.cloud = { callFunction: async ({ name }) => { if (name === "getOpenId") return { result: { openid: "o-owner" } }; throw { errMsg: "cloud.callFunction:fail -501000 FUNCTION_NOT_FOUND" }; } };
  await assert.rejects(storyImageApi.removeStoryImage("x"), (error: unknown) => error instanceof StoryImageServiceError && error.code === "FUNCTION_MISSING");

  wxMock.cloud = { callFunction: async ({ name }) => { if (name === "getOpenId") return { result: { openid: "o-owner" } }; throw { errMsg: "cloud.callFunction:fail -504003 Invoking task timed out after 3 seconds" }; } };
  await assert.rejects(storyImageApi.checkImageJob("x"), (error: unknown) => error instanceof StoryImageServiceError && error.code === "TIMEOUT");
});

test("云开发没连上时直接说明，不去调用云函数", async context => {
  const env = installWx({ cloud: { callFunction: async () => { throw new Error("should not be called"); } } });
  env.setApp(false);
  context.after(env.restore);
  await assert.rejects(storyImageApi.listStoryImages("owner"), (error: unknown) => error instanceof StoryImageServiceError && error.code === "CLOUD_NOT_READY");
});

// ---------- 页面 ----------

test("这本书的图：按章节分组，显示占用空间和正在画的图，并在前台轮询", async context => {
  const env = installWx({}, stateWithBook());
  env.setApp(false);
  const timers = captureTimers();
  const restoreApi = withApi({ listStoryImages: async () => listWith() });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  call(page, "onLoad", { chapterId: encodeURIComponent("chapter-a") });
  await call(page, "refresh");

  const groups = page.data.groups as Array<{ id: string; title: string; images: Array<{ sizeLabel: string; moderationLabel: string; qualityLabel: string; purposeLabel: string; isBackdrop: boolean; inUse: boolean }>; pending: Array<{ active: boolean; purposeLabel: string }> }>;
  assert.equal(page.data.focusChapterId, "chapter-a");
  assert.equal(page.data.bookTitle, "外婆的书");
  assert.deepEqual(groups.map(group => group.id), ["chapter-a", "chapter-b"]);
  assert.equal(groups[0].title, "老院子");
  assert.equal(groups[0].images[0].sizeLabel, "2 KB");
  assert.equal(groups[0].images[0].moderationLabel, "平台审核中");
  assert.equal(groups[0].images[0].qualityLabel, "有瑕疵：有乱码字");
  assert.equal(groups[0].images[0].purposeLabel, "插图");
  assert.equal(groups[0].images[1].isBackdrop, true);
  assert.equal(groups[0].images[1].inUse, false);
  assert.equal(groups[1].pending[0].purposeLabel, "插图");
  assert.equal(groups[1].pending[0].active, true);
  assert.equal(page.data.usageLabel, "共 2 张 · 3 KB");
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delay, 3000);
});

test("轮询到图画好后刷新列表，没有正在画的图就不再轮询；离开页面立即停", async context => {
  const env = installWx({}, stateWithBook());
  env.setApp(false);
  const timers = captureTimers();
  let listCalls = 0;
  const checked: string[] = [];
  const restoreApi = withApi({
    listStoryImages: async () => { listCalls++; return listCalls === 1 ? listWith() : listWith({ pending: [] }); },
    checkImageJob: async jobId => { checked.push(jobId); return { job: { ...listWith().pending[0], status: "stored" } }; },
  });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  call(page, "onLoad", {});
  await call(page, "refresh");
  assert.equal(timers.scheduled.length, 1);
  await call(page, "pollOnce");
  assert.deepEqual(checked, ["family_o-owner_req-b"]);
  assert.equal(listCalls, 2);
  assert.equal(timers.scheduled.length, 1, "图画好后不再安排下一次轮询");

  const hidden = instantiate(await pageDefinition("story-images"));
  call(hidden, "onLoad", {});
  call(hidden, "onHide");
  await call(hidden, "pollOnce");
  assert.deepEqual(checked, ["family_o-owner_req-b"], "隐藏的页面不再查询");
});

test("给一章配图会提交这一章并刷新；删除要确认，删完刷新", async context => {
  const env = installWx({}, stateWithBook());
  env.setApp(false);
  const timers = captureTimers();
  const submitted: unknown[] = [];
  const removed: string[] = [];
  const restoreApi = withApi({
    listStoryImages: async () => listWith({ pending: [] }),
    submitChapterImage: async input => { submitted.push(input); return { ...listWith().pending[0], chapterId: input.chapterId, purpose: input.purpose }; },
    removeStoryImage: async imageId => { removed.push(imageId); },
  });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  call(page, "onLoad", {});
  await call(page, "refresh");
  await call(page, "generate", { currentTarget: { dataset: { id: "chapter-a", purpose: "illustration" } } });
  await call(page, "generate", { currentTarget: { dataset: { id: "chapter-b", purpose: "backdrop" } } });
  assert.deepEqual(submitted, [
    { memberId: "owner", chapterId: "chapter-a", purpose: "illustration" },
    { memberId: "owner", chapterId: "chapter-b", purpose: "backdrop" },
  ]);
  assert.equal(page.data.notice, "正在画，大约 20–60 秒。可以先离开，回来接着看");
  assert.equal(page.data.submitting, "");

  await call(page, "remove", { currentTarget: { dataset: { id: "family_o-owner_img_req-aaaaaaaa" } } });
  assert.deepEqual(removed, ["family_o-owner_img_req-aaaaaaaa"]);
  assert.equal(page.data.notice, "已删除");

  call(page, "previewImage", { currentTarget: { dataset: { url: "https://tmp.example/a.png" } } });
  assert.deepEqual(env.previews, [{ current: "https://tmp.example/a.png", urls: ["https://tmp.example/a.png", "https://tmp.example/b.png"] }]);
});

test("插图可以回到来源章节的光标处，正文正在使用的原图不能直接删除", async context => {
  const state = stateWithBook();
  const env = installWx({ navigateBack: () => undefined }, state);
  env.setApp(false);
  const removed: string[] = [];
  const restoreApi = withApi({
    listStoryImages: async () => listWith({ pending: [] }),
    removeStoryImage: async id => { removed.push(id); },
  });
  context.after(() => { restoreApi(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  const emitted: unknown[] = [];
  page.getOpenerEventChannel = () => ({ emit: (name: string, payload: unknown) => emitted.push({ name, payload }) });
  call(page, "onLoad", { chapterId: "chapter-a" });
  await call(page, "refresh");
  call(page, "insertIntoBook", { currentTarget: { dataset: {
    id: "family_o-owner_img_req-aaaaaaaa", chapter: "chapter-a", url: "https://tmp.example/a.png",
  } } });
  assert.deepEqual(emitted, [{ name: "insertStoryImage", payload: {
    imageId: "family_o-owner_img_req-aaaaaaaa", chapterId: "chapter-a", url: "https://tmp.example/a.png",
  } }]);

  const group = (page.data.groups as any[])[0];
  group.images[0].inText = true;
  await call(page, "remove", { currentTarget: { dataset: { id: "family_o-owner_img_req-aaaaaaaa" } } });
  assert.deepEqual(removed, [], "正文引用存在时保留云端原图");
});

test("提交配图失败时把原因显示出来，按钮恢复可点", async context => {
  const env = installWx({}, stateWithBook());
  env.setApp(false);
  const timers = captureTimers();
  const restoreApi = withApi({
    listStoryImages: async () => listWith({ pending: [] }),
    submitChapterImage: async () => { throw new StoryImageServiceError("BOOK_LIMIT", "这个故事已经有 30 张图了，删掉的不会返还名额"); },
  });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  call(page, "onLoad", {});
  await call(page, "refresh");
  await call(page, "generate", { currentTarget: { dataset: { id: "chapter-a" } } });
  assert.equal(page.data.notice, "这个故事已经有 30 张图了，删掉的不会返还名额");
  assert.equal(page.data.submitting, "");
});

test("书稿页「更多」里能打开这一章的配图，未保存的修改不能带过去", async context => {
  const env = installWx({ hideKeyboard: () => undefined }, stateWithBook());
  env.setApp(false);
  context.after(env.restore);

  const page = instantiate(await pageDefinition("book"));
  page.activeChapterId = "chapter-a";
  page.setData({ view: "chapter", editing: false, memberId: "owner" });
  call(page, "selectTool", { currentTarget: { dataset: { action: "images" } } });
  assert.deepEqual(env.navigations, ["/pages/story-images/story-images?memberId=owner&chapterId=chapter-a"]);

  page.setData({ view: "contents" });
  call(page, "selectTool", { currentTarget: { dataset: { action: "images" } } });
  assert.equal(env.navigations[1], "/pages/story-images/story-images?memberId=owner");

  page.setData({ view: "chapter", editing: true });
  call(page, "selectTool", { currentTarget: { dataset: { action: "images" } } });
  assert.equal(env.navigations.length, 2, "有未保存的修改时不跳转");

  const markup = readFileSync("miniprogram/pages/book/book.wxml", "utf8");
  assert.match(markup, /data-action="images"[^>]*>.*给本章配图/);
  assert.match(markup, /data-action="images"[^>]*>.*这本书的图/);
  const app = JSON.parse(readFileSync("miniprogram/app.json", "utf8")) as { pages: string[] };
  assert.ok(app.pages.includes("pages/story-images/story-images"));
});

test("书稿接到选中的 AI 插图后按光标位置插入并保存为图片编号", async context => {
  const env = installWx({}, stateWithBook());
  env.setApp(false);
  const restoreApi = withApi({ listStoryImages: async () => listWith({
    images: [{
      imageId: "family_o-owner_img_req-abcdefgh", chapterId: "chapter-a", purpose: "illustration",
      url: "https://tmp.example/fresh.png", bytes: 2048, moderation: "pass", quality: "pass", qualityIssues: [], aiGenerated: true, createdAtMs: 4,
    }],
    pending: [],
  }) });
  context.after(() => { restoreApi(); env.restore(); });
  const page = instantiate(await pageDefinition("book"));
  await call(page, "refresh");
  let delta: any = { ops: [{ insert: "院子里晒着被子。\n" }] };
  const caret = 2;
  page.editorContext = {
    setContents: ({ delta: next, success }: any) => { delta = next; success(); },
    getContents: ({ success }: any) => success({ delta, text: "院子里晒着被子。\n" }),
    insertImage: ({ src, success }: any) => {
      const text = delta.ops.map((op: any) => typeof op.insert === "string" ? op.insert : "").join("");
      delta = { ops: [{ insert: text.slice(0, caret) }, { insert: { image: src } }, { insert: text.slice(caret) }] };
      success();
    },
  };
  call(page, "openChapter", { currentTarget: { dataset: { id: "chapter-a" } } });
  page.setData({ editorReady: true });
  page.pendingStoryImage = {
    imageId: "family_o-owner_img_req-abcdefgh", chapterId: "chapter-a", url: "https://tmp.example/illustration.png",
  };
  call(page, "onShow");
  assert.equal(page.data.storyImageSelected, true);
  await call(page, "refreshSelectedStoryImageUrl");
  assert.equal(page.data.refreshingStoryImage, false);
  assert.equal((page.pendingStoryImage as any).url, "https://tmp.example/fresh.png");
  await call(page, "placeSelectedStoryImage");
  assert.equal(page.data.editing, true);
  assert.equal(page.data.saveNotice, "插图已放进正文，请点保存。");
  assert.equal(page.data.storyImageSelected, false);
  assert.deepEqual(page.contentBuffer, [
    { text: "院子" },
    { photoId: "photo-ai-req-abcdefgh" },
    { text: "里晒着被子。\n" },
  ]);
  await call(page, "saveEdits");
  const saved = (page.data.draft as BiographyDraft).chapters![0].content;
  assert.ok(saved.some(item => item.photoId === "photo-ai-req-abcdefgh"));
  assert.ok(!JSON.stringify(saved).includes("tmp.example"));

  const reopened = instantiate(await pageDefinition("book"));
  reopened.activeChapterId = "chapter-a";
  reopened.setData({ view: "chapter" });
  let shown: any;
  reopened.editorContext = { setContents: ({ delta: next, success }: any) => { shown = next; success(); } };
  await call(reopened, "refresh");
  assert.deepEqual(shown.ops[1].insert, { image: "https://tmp.example/fresh.png" });
  assert.ok(!JSON.stringify(reopened.contentBuffer).includes("tmp.example"));
});

test("从另一人物的书进入配图时继续使用那个人物的书", async context => {
  const state = stateWithBook();
  const base: BiographyDraft = {
    title: "林秋的人生之书", paragraphs: [], sourceCount: 0,
    generatedAt: "2026-09-13T00:00:00.000Z", generationMode: "local-demo",
  };
  state.manuscriptRevisions!.push(makeRevision("member-1", draftWithChapters(base, [{
    id: "chapter-other", title: "另一章", memoryIds: [], content: [{ text: "另一人的正文。\n" }],
  }]), "", "draft", "编辑存档"));
  const env = installWx({}, state);
  env.setApp(false);
  const timers = captureTimers();
  const listedMembers: string[] = [];
  const restoreApi = withApi({
    listStoryImages: async memberId => { listedMembers.push(memberId); return listWith({ images: [], pending: [] }); },
  });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  call(page, "onLoad", { memberId: encodeURIComponent("member-1"), chapterId: encodeURIComponent("chapter-other") });
  await call(page, "refresh");

  assert.deepEqual(listedMembers, ["member-1"]);
  assert.equal(page.data.memberId, "member-1");
  assert.equal(page.data.bookTitle, "林秋的人生之书");
  assert.equal((page.data.groups as Array<{ id: string }>)[0]?.id, "chapter-other");
});

test("在管理页把一张底图设为本章底图，再点「不用了」取消，都存成书稿新版本", async context => {
  const env = installWx({}, stateWithBook());
  env.setApp(false);
  const timers = captureTimers();
  const restoreApi = withApi({ listStoryImages: async () => listWith({ pending: [] }) });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  call(page, "onLoad", {});
  await call(page, "refresh");
  await call(page, "setBackdrop", { currentTarget: { dataset: { chapter: "chapter-a", image: BACKDROP_ID } } });
  assert.equal(page.data.notice, "已设为本章底图，回到书稿就能看到");
  let groups = page.data.groups as Array<{ backdropImageId: string; images: Array<{ imageId: string; inUse: boolean }> }>;
  assert.equal(groups[0].backdropImageId, BACKDROP_ID);
  assert.equal(groups[0].images.find(image => image.imageId === BACKDROP_ID)?.inUse, true);
  assert.equal(currentManuscript(await loadRoomStateRemoteFirst(), "owner").draft?.chapters?.[0].backdropImageId, BACKDROP_ID);

  await call(page, "setBackdrop", { currentTarget: { dataset: { chapter: "chapter-a", image: "" } } });
  groups = page.data.groups as typeof groups;
  assert.equal(groups[0].backdropImageId, "");
  assert.equal(page.data.savingBackdrop, false);
});

test("删除正在用作底图的图：提示会影响哪一章，先解除底图再删图", async context => {
  const env = installWx({}, stateWithBook(BACKDROP_ID));
  env.setApp(false);
  const timers = captureTimers();
  const modals: string[] = [];
  (wx as unknown as { showModal: unknown }).showModal = ({ content, success }: { content: string; success?: (result: { confirm: boolean; cancel: boolean }) => void }) => {
    modals.push(content);
    success?.({ confirm: true, cancel: false });
  };
  const order: string[] = [];
  const restoreApi = withApi({
    listStoryImages: async () => listWith({ pending: [] }),
    removeStoryImage: async imageId => {
      const chapter = currentManuscript(await loadRoomStateRemoteFirst(), "owner").draft?.chapters?.[0];
      order.push(`remove ${imageId} while backdrop=${chapter?.backdropImageId ?? "none"}`);
    },
  });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  call(page, "onLoad", {});
  await call(page, "refresh");
  await call(page, "remove", { currentTarget: { dataset: { id: BACKDROP_ID } } });
  assert.match(modals[0], /正在用作第一章的底图/);
  assert.deepEqual(order, [`remove ${BACKDROP_ID} while backdrop=none`]);
  assert.equal(page.data.notice, "已删除");
});

test("选中的底图已被删掉时，章节里提示并能一键不用", async context => {
  const env = installWx({}, stateWithBook(BACKDROP_ID));
  env.setApp(false);
  const timers = captureTimers();
  const restoreApi = withApi({ listStoryImages: async () => listWith({ pending: [], images: [] }) });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  call(page, "onLoad", {});
  await call(page, "refresh");
  assert.equal((page.data.groups as Array<{ backdropMissing: boolean }>)[0].backdropMissing, true);
  const markup = readFileSync("miniprogram/pages/story-images/story-images.wxml", "utf8");
  assert.match(markup, /这一章选的底图已经不在了/);
});

test("书稿里带底图的章节在正文区下方显示底图，没有底图的书不去云端取图", async context => {
  const env = installWx({}, stateWithBook(BACKDROP_ID));
  env.setApp(false);
  let listCalls = 0;
  const restoreApi = withApi({ listStoryImages: async () => { listCalls++; return listWith({ pending: [] }); } });
  context.after(() => { restoreApi(); env.restore(); });

  const page = instantiate(await pageDefinition("book"));
  await call(page, "refresh");
  await call(page, "loadBackdrops", "owner", page.refreshId);
  call(page, "openChapter", { currentTarget: { dataset: { id: "chapter-a" } } });
  assert.equal(page.data.backdropUrl, "https://tmp.example/b.png");
  call(page, "backToContents");
  call(page, "openChapter", { currentTarget: { dataset: { id: "chapter-b" } } });
  assert.equal(page.data.backdropUrl, "", "第二章没有底图");
  assert.ok(listCalls >= 1);

  const markup = readFileSync("miniprogram/pages/book/book.wxml", "utf8");
  assert.match(markup, /<image wx:if="\{\{backdropUrl\}\}" class="chapter-backdrop"/);
  const styles = readFileSync("miniprogram/pages/book/book.wxss", "utf8");
  assert.match(styles, /\.keyboard-open \.chapter-backdrop \{ display: none; \}/);

  const plainEnv = installWx({}, stateWithBook());
  plainEnv.setApp(false);
  listCalls = 0;
  const plain = instantiate(await pageDefinition("book"));
  await call(plain, "refresh");
  await call(plain, "loadBackdrops", "owner", plain.refreshId);
  assert.equal(listCalls, 0);
  plainEnv.restore();
});

test("云端取不到底图时书稿照常打开，只是不显示底图", async context => {
  const env = installWx({}, stateWithBook(BACKDROP_ID));
  env.setApp(false);
  const restoreApi = withApi({ listStoryImages: async () => { throw new StoryImageServiceError("CLOUD_NOT_READY", "微信云开发还没连上"); } });
  context.after(() => { restoreApi(); env.restore(); });

  const page = instantiate(await pageDefinition("book"));
  await call(page, "refresh");
  await call(page, "loadBackdrops", "owner", page.refreshId);
  call(page, "openChapter", { currentTarget: { dataset: { id: "chapter-a" } } });
  assert.equal(page.data.backdropUrl, "");
  assert.equal(page.data.loadError, "");
});

test("书稿里显示底图时正文区另外标「图片 AI 生成」，和正文的「文字 AI 生成」分开，键盘打开时和底图一起隐藏", () => {
  const markup = readFileSync("miniprogram/pages/book/book.wxml", "utf8");
  const styles = readFileSync("miniprogram/pages/book/book.wxss", "utf8");
  assert.match(markup, /<view wx:if="\{\{backdropUrl\}\}" class="backdrop-ai-label">图片 AI 生成<\/view>/);
  const labelRule = styles.match(/\.backdrop-ai-label \{([^}]*)\}/)?.[1] ?? "";
  assert.match(labelRule, /z-index: 2/, "角标要压在底图和渐隐之上");
  assert.doesNotMatch(labelRule, /opacity:\s*0/);
  assert.match(styles, /\.keyboard-open \.chapter-backdrop \{ display: none; \}/);
  assert.match(styles, /\.keyboard-open \.backdrop-ai-label \{ display: none; \}/);
});
