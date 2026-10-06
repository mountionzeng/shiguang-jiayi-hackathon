import { storyCoverApi } from "../miniprogram/services/storyCoverService";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach } from "node:test";

import { BiographyDraft, FamilyRoomState, ManuscriptChapter } from "../miniprogram/domain/biography";
import { clearAiConsent } from "../miniprogram/services/aiConsent";
import { clearPhotoAiConsent } from "../miniprogram/services/photoAiConsent";
import { clearIllustrationReferenceConsent, requestIllustrationReferenceConsent } from "../miniprogram/services/illustrationReferenceConsent";
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

async function pageDefinition(name: "story-images" | "book" | "story-cover"): Promise<PageDefinition> {
  const cached = definitions.get(name);
  if (cached) return cached;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Page");
  let captured: PageDefinition | undefined;
  Object.defineProperty(globalThis, "Page", { configurable: true, writable: true, value: (definition: PageDefinition) => { captured = definition; } });
  try {
    if (name === "book") await import("../miniprogram/pages/book/book");
    else if (name === "story-cover") await import("../miniprogram/pages/story-cover/story-cover");
    else await import("../miniprogram/pages/story-images/story-images");
  } finally {
    if (previous) Object.defineProperty(globalThis, "Page", previous);
    else delete (globalThis as Record<string, unknown>).Page;
  }
  assert.ok(captured);
  definitions.set(name, captured);
  return captured;
}

const pollingPages: PageInstance[] = [];
afterEach(() => {
  for (const page of pollingPages.splice(0)) call(page, "onUnload");
});

function instantiate(definition: PageDefinition): PageInstance {
  const instance = { ...definition, data: structuredClone(definition.data ?? {}) } as PageInstance;
  instance.setData = update => Object.assign(instance.data, update);
  if (typeof instance.schedulePoll === 'function') pollingPages.push(instance);
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
    setApp(cloudReady: boolean, imageAiReady = cloudReady, aiReady = cloudReady) {
      Object.defineProperty(globalThis, "getApp", { configurable: true, writable: true, value: () => ({ globalData: { cloudReady, aiReady, imageAiReady } }) });
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
    limits: { daily: null, book: null, unlimited: true },
    ...overrides,
  };
}

test('book loads local photos and cloud images together without overwriting editing, unloaded or newer pages', async () => {
  for (const scenario of ['editing', 'unloaded', 'superseded']) {
    const state = stateWithBook(BACKDROP_ID);
    state.manuscriptRevisions![0].draft.chapters![0].content.push({ photoId: 'photo-a' }, { photoId: 'photo-b' });
    const pending: Array<() => void> = [];
    let cloudReads = 0;
    const env = installWx({
      env: { USER_DATA_PATH: 'wxfile://usr' },
      getStorageSync: (key: string) => key.startsWith('shiguang-local-photo-') ? 'wxfile://store_shared.jpg' : undefined,
      getFileSystemManager: () => ({
        getSavedFileList: ({ success }: any) => pending.push(() => success({ fileList: [{ filePath: 'wxfile://store_shared.jpg' }] })),
        accessSync: () => undefined,
      }),
    });
    const restoreApi = withApi({ listStoryImages: async () => { cloudReads++; return listWith(); } });
    try {
      const page = instantiate(await pageDefinition('book'));
      const loading = call(page, 'refresh', state);
      await new Promise(resolve => setImmediate(resolve));
      const imagesReady = page.bookImagesReady;
      assert.equal(pending.length, 2);
      assert.equal(cloudReads, 1, 'cloud images do not wait for local paths');
      if (scenario === 'editing') {
        page.bodyBuffer = '刚刚输入的文字';
        page.setData({ editing: true });
      } else if (scenario === 'unloaded') {
        page.unloaded = true;
      } else {
        const newer = stateWithBook();
        newer.manuscriptRevisions![0].draft.title = '较新的刷新';
        await call(page, 'refresh', newer);
      }
      const before = JSON.stringify({ ...page.data, backdropUrl: '' });
      for (const finish of pending.reverse()) finish();
      await loading;
      await imagesReady;
      assert.equal(JSON.stringify({ ...page.data, backdropUrl: '' }), before, `${scenario}: late photo responses must not render stale text`);
      if (scenario === 'editing') assert.equal(page.bodyBuffer, '刚刚输入的文字');
      if (scenario === 'superseded') assert.equal((page.data.draft as BiographyDraft).title, '较新的刷新');
    } finally { restoreApi(); env.restore(); }
  }
});

function captureTimers() {
  const previousSet = globalThis.setTimeout;
  const previousClear = globalThis.clearTimeout;
  const scheduled: Array<{ delay: number; callback: () => void }> = [];
  globalThis.setTimeout = ((callback: () => void, delay: number) => { scheduled.push({ delay, callback }); return scheduled.length as unknown as ReturnType<typeof setTimeout>; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as unknown as typeof clearTimeout;
  return { scheduled, restore() { globalThis.setTimeout = previousSet; globalThis.clearTimeout = previousClear; } };
}

test('book contents and plain text render before background images without re-seeding an edited chapter', async context => {
  const env = installWx({}, stateWithBook(BACKDROP_ID));
  let resolveImages!: (value: StoryImageList) => void;
  const images = new Promise<StoryImageList>(resolve => { resolveImages = resolve; });
  const restoreApi = withApi({ listStoryImages: () => images });
  context.after(() => { resolveImages(listWith()); restoreApi(); env.restore(); });
  const page = instantiate(await pageDefinition('book'));
  let completed = false;
  const loading = Promise.resolve(call(page, 'refresh')).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, true, 'the table of contents must not wait for decoration');
  assert.equal(page.data.view, 'contents');
  let seeded = 0;
  page.editorContext = { setContents: ({ success }: any) => { seeded++; success(); } };
  await call(page, 'openChapter', { currentTarget: { dataset: { id: 'chapter-a' } } });
  call(page, 'onEditorInput', { detail: { delta: { ops: [{ insert: '等待背景图时输入的新正文\n' }] }, text: '等待背景图时输入的新正文\n' } });
  const before = JSON.stringify(page.contentBuffer);
  const seedCount = seeded;
  resolveImages(listWith());
  await loading;
  await page.bookImagesReady;
  assert.equal(page.data.backdropUrl, 'https://tmp.example/b.png');
  assert.equal(JSON.stringify(page.contentBuffer), before);
  assert.equal(page.data.editing, true);
  assert.equal(seeded, seedCount, 'late backgrounds must never call editor.setContents');
});

test('opening an illustrated chapter waits for image mappings and a later chapter selection wins', async context => {
  const state = stateWithBook();
  state.manuscriptRevisions![0].draft.chapters![0].content.push({ photoId: 'photo-ai-req-aaaaaaaa' });
  const env = installWx({}, state);
  let resolveImages!: (value: StoryImageList) => void;
  const images = new Promise<StoryImageList>(resolve => { resolveImages = resolve; });
  const restoreApi = withApi({ listStoryImages: () => images });
  context.after(() => { resolveImages(listWith()); restoreApi(); env.restore(); });
  const page = instantiate(await pageDefinition('book'));
  let completed = false;
  const loading = Promise.resolve(call(page, 'refresh')).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, true, 'inline images in unopened chapters must not delay the contents');
  const opening = call(page, 'openChapter', { currentTarget: { dataset: { id: 'chapter-a' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.view, 'contents', 'do not mount an image editor before its URL-to-ID mapping exists');
  await call(page, 'openChapter', { currentTarget: { dataset: { id: 'chapter-b' } } });
  resolveImages(listWith());
  await opening;
  await loading;
  assert.equal(page.activeChapterId, 'chapter-b', 'late image response cannot undo the newer selection');
  await call(page, 'openChapter', { currentTarget: { dataset: { id: 'chapter-a' } } });
  assert.equal(page.activeChapterId, 'chapter-a');
  assert.equal((page.photoPaths as Record<string, string>)['photo-ai-req-aaaaaaaa'], 'https://tmp.example/a.png');
});

test('direct entry to an illustrated chapter still waits before seeding the native editor', async context => {
  const state = stateWithBook();
  state.manuscriptRevisions![0].draft.chapters![0].content.push({ photoId: 'photo-ai-req-aaaaaaaa' });
  const env = installWx({}, state);
  let resolveImages!: (value: StoryImageList) => void;
  const images = new Promise<StoryImageList>(resolve => { resolveImages = resolve; });
  const restoreApi = withApi({ listStoryImages: () => images });
  context.after(() => { resolveImages(listWith()); restoreApi(); env.restore(); });
  const page = instantiate(await pageDefinition('book'));
  page.activeChapterId = 'chapter-a';
  page.setData({ view: 'chapter' });
  const deltas: any[] = [];
  page.editorContext = { setContents: ({ delta, success }: any) => { deltas.push(delta); success(); } };
  let completed = false;
  const loading = Promise.resolve(call(page, 'refresh')).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(deltas.length, 0);
  resolveImages(listWith());
  await loading;
  assert.equal(deltas.length, 1);
  assert.ok(deltas[0].ops.some((op: any) => op.insert?.image === 'https://tmp.example/a.png'));
  assert.equal((page.imageIds as Record<string, string>)['https://tmp.example/a.png'], 'photo-ai-req-aaaaaaaa');
});

test('late image mappings preserve newly inserted photos and a cancelled chapter never opens', async context => {
  const state = stateWithBook();
  state.manuscriptRevisions![0].draft.chapters![0].content.push({ photoId: 'photo-ai-req-aaaaaaaa' });
  const env = installWx({}, state);
  let resolveImages!: (value: StoryImageList) => void;
  const images = new Promise<StoryImageList>(resolve => { resolveImages = resolve; });
  const restoreApi = withApi({ listStoryImages: () => images });
  context.after(() => { resolveImages(listWith()); restoreApi(); env.restore(); });
  const page = instantiate(await pageDefinition('book'));
  await call(page, 'refresh');
  const opening = call(page, 'openChapter', { currentTarget: { dataset: { id: 'chapter-a' } } });
  await call(page, 'backToContents');
  (page.photoPaths as Record<string, string>)['photo-new'] = 'wxfile://usr/new.jpg';
  (page.imageIds as Record<string, string>)['wxfile://usr/new.jpg'] = 'photo-new';
  resolveImages(listWith());
  await opening;
  await page.bookImagesReady;
  assert.equal(page.data.view, 'contents');
  assert.equal((page.photoPaths as Record<string, string>)['photo-new'], 'wxfile://usr/new.jpg');
  assert.equal((page.imageIds as Record<string, string>)['wxfile://usr/new.jpg'], 'photo-new');
});

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
  clearIllustrationReferenceConsent();
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const env = installWx({
    cloud: {
      callFunction: async ({ name, data }: { name: string; data: Record<string, unknown> }) => {
        calls.push({ name, data });
        if (name === "getOpenId") return { result: { openid: "o-owner" } };
        if (data.action === "capabilities") return { result: { apiVersion: 2, referenceIllustration: true } };
        return { result: { job: { jobId: "family_o-owner_req-x", status: "queued", message: "正在画", chapterId: "chapter-a", purpose: "illustration", imageId: "", referenceApplied: true, referenceImageId: "family_o-owner_img_req-aaaaaaaa", createdAtMs: 1 } } };
      },
    },
  });
  env.setApp(true);
  context.after(() => { env.restore(); clearAiConsent(); clearIllustrationReferenceConsent(); });

  const job = await storyImageApi.submitChapterImage({
    memberId: "owner", chapterId: "chapter-a", purpose: "illustration", requestId: "req-test-00000001",
    referenceImageId: "family_o-owner_img_req-aaaaaaaa",
  });
  assert.equal(job.status, "queued");
  const submit = calls.find(item => item.name === "storyImages" && item.data.action === "submit");
  assert.deepEqual(submit?.data, {
    memberId: "owner", chapterId: "chapter-a", requestId: "req-test-00000001", purpose: "illustration",
    referenceImageId: "family_o-owner_img_req-aaaaaaaa",
    action: "submit", familyId: "family_o-owner",
  });
});

test("带美术想法生成会先确认云端能力，并验证想法确实被任务采用", async context => {
  clearAiConsent();
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const env = installWx({
    cloud: { callFunction: async ({ name, data }: { name: string; data: Record<string, unknown> }) => {
      calls.push({ name, data });
      if (name === "getOpenId") return { result: { openid: "o-owner" } };
      if (data.action === "capabilities") return { result: { apiVersion: 4, guidedGeneration: true } };
      return { result: { job: {
        jobId: "family_o-owner_req-idea", status: "queued", message: "正在画", chapterId: "chapter-a",
        purpose: "illustration", imageId: "", ideaApplied: true, createdAtMs: 1,
      } } };
    } },
  });
  env.setApp(true);
  context.after(() => { env.restore(); clearAiConsent(); });

  await storyImageApi.submitChapterImage({
    memberId: "owner", chapterId: "chapter-a", purpose: "illustration", requestId: "req-idea-00000001",
    artDirection: "傍晚暖光，人物只画背影",
  });
  assert.deepEqual(calls.filter(item => item.name === "storyImages").map(item => item.data.action), ["capabilities", "submit"]);
  assert.equal(calls.find(item => item.data.action === "submit")?.data.artDirection, "傍晚暖光，人物只画背影");
});

test("带本章照片生成插图和底图都会先确认能力与照片同意，并验证照片确实被采用", async context => {
  clearAiConsent();
  clearPhotoAiConsent();
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const env = installWx({
    cloud: { callFunction: async ({ name, data }: { name: string; data: Record<string, unknown> }) => {
      calls.push({ name, data });
      if (name === "photoAccess") return { result: { photos: [{ photoId: "photo-cat", status: "ok", url: "https://tmp.example/cat.jpg" }] } };
      if (name === "getOpenId") return { result: { openid: "o-owner" } };
      if (data.action === "capabilities") return { result: { apiVersion: 5, referencePhotos: true } };
      return { result: { job: {
        jobId: `family_o-owner_${data.requestId}`, status: "queued", message: "正在画", chapterId: "chapter-a",
        purpose: data.purpose, imageId: "", referenceApplied: true, referencePhotoIds: ["photo-cat"], createdAtMs: 1,
      } } };
    } },
  });
  env.setApp(true);
  context.after(() => { env.restore(); clearAiConsent(); clearPhotoAiConsent(); });

  await storyImageApi.submitChapterImage({
    memberId: "owner", chapterId: "chapter-a", purpose: "illustration", requestId: "req-photo-00000001",
    referencePhotoIds: ["photo-cat"],
  });
  await storyImageApi.submitChapterImage({
    memberId: "owner", chapterId: "chapter-a", purpose: "backdrop", requestId: "req-photo-00000002",
    referencePhotoIds: ["photo-cat"],
  });
  assert.deepEqual(calls.filter(item => item.name === "storyImages").map(item => item.data.action), ["capabilities", "submit", "capabilities", "submit"]);
  const submits = calls.filter(item => item.data.action === "submit").map(item => item.data);
  assert.deepEqual(submits.map(item => item.purpose), ["illustration", "backdrop"]);
  assert.deepEqual(submits.map(item => item.referencePhotoIds), [["photo-cat"], ["photo-cat"]]);
  assert.deepEqual(submits.map(item => item.photoReferenceConsent), [true, true]);
});

test("旧版云端不能静默忽略用户的美术想法", async context => {
  clearAiConsent();
  const actions: unknown[] = [];
  const env = installWx({ cloud: { callFunction: async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
    if (name === "getOpenId") return { result: { openid: "o-owner" } };
    if (name === "storyImages") actions.push(data?.action);
    return { result: { apiVersion: 3, guidedGeneration: false } };
  } } });
  env.setApp(true);
  context.after(() => { env.restore(); clearAiConsent(); });
  await assert.rejects(storyImageApi.submitChapterImage({
    memberId: "owner", chapterId: "chapter-a", purpose: "illustration", artDirection: "暖一点",
  }), (error: unknown) => error instanceof StoryImageServiceError && error.code === "GUIDED_GENERATION_UNAVAILABLE");
  assert.deepEqual(actions, ["capabilities"]);
});

test("图片专用发布闸门开放时可以真实走提交路径，同时文字 AI 仍保持关闭", async context => {
  clearAiConsent();
  clearPhotoAiConsent();
  const calls: Array<{ name: string; data?: Record<string, unknown> }> = [];
  const env = installWx({
    cloud: {
      callFunction: async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
        calls.push({ name, data });
        if (name === "getOpenId") return { result: { openid: "o-owner" } };
        assert.equal(name, "storyImages");
        assert.equal(data?.action, "submit");
        return { result: { job: {
          jobId: "family_o-owner_req-gate",
          status: "queued",
          message: "正在画",
          chapterId: "chapter-a",
          purpose: "illustration",
          imageId: "",
          createdAtMs: 1,
        } } };
      },
    },
  });
  env.setApp(true, true, false);
  context.after(() => { env.restore(); clearAiConsent(); clearPhotoAiConsent(); });

  const job = await storyImageApi.submitChapterImage({
    memberId: "owner",
    chapterId: "chapter-a",
    purpose: "illustration",
    requestId: "req-image-gate-0001",
  });
  assert.equal(job.status, "queued");
  assert.ok(calls.some(({ name, data }) => name === "storyImages" && data?.action === "submit"));

  await assert.rejects(
    storyImageApi.captionPhotos({ photoIds: ["photo-a"], requestId: "req-caption-gate-01" }),
    (error: unknown) => error instanceof StoryImageServiceError && error.code === "TEXT_AI_NOT_READY",
  );
  assert.equal(calls.some(({ data }) => data?.action === "caption"), false, "文字 AI 闸门关闭时不能调用云函数");
});

test("旧版云函数静默忽略参考图时，新客户端明确报错而不假装已经参考", async context => {
  clearAiConsent();
  clearIllustrationReferenceConsent();
  const actions: unknown[] = [];
  const env = installWx({
    cloud: { callFunction: async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
      if (name === "getOpenId") return { result: { openid: "o-owner" } };
      if (name !== "storyImages") return { result: {} };
      actions.push(data?.action);
      return { result: { error: { code: "UNKNOWN_ACTION", message: "不支持的操作" } } };
    } },
  });
  env.setApp(true);
  context.after(() => { env.restore(); clearAiConsent(); clearIllustrationReferenceConsent(); });

  await assert.rejects(storyImageApi.submitChapterImage({
    memberId: "owner", chapterId: "chapter-a", purpose: "illustration", requestId: "req-test-00000002",
    referenceImageId: "family_o-owner_img_req-aaaaaaaa",
  }), (error: unknown) => error instanceof StoryImageServiceError && error.code === "REFERENCE_UNAVAILABLE");
  assert.deepEqual(actions, ["capabilities"], "能力不支持时不能提交付费出图任务");
});

test("云端明确报告参考图分析未配置时，不弹参考图授权也不提交任务", async context => {
  clearAiConsent();
  clearIllustrationReferenceConsent();
  const actions: unknown[] = [];
  let referencePrompts = 0;
  const env = installWx({
    showModal: ({ title, success }: { title?: string; success?: (result: { confirm: boolean; cancel: boolean }) => void }) => {
      if (title === "允许 AI 参考这张插图？") referencePrompts++;
      success?.({ confirm: true, cancel: false });
    },
    cloud: { callFunction: async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
      if (name === "getOpenId") return { result: { openid: "o-owner" } };
      if (name !== "storyImages") return { result: {} };
      actions.push(data?.action);
      return { result: { apiVersion: 2, referenceIllustration: false } };
    } },
  });
  env.setApp(true);
  context.after(() => { env.restore(); clearAiConsent(); clearIllustrationReferenceConsent(); });

  await assert.rejects(storyImageApi.submitChapterImage({
    memberId: "owner", chapterId: "chapter-a", purpose: "illustration", requestId: "req-test-00000003",
    referenceImageId: "family_o-owner_img_req-aaaaaaaa",
  }), (error: unknown) => error instanceof StoryImageServiceError && error.code === "REFERENCE_UNAVAILABLE");
  assert.deepEqual(actions, ["capabilities"]);
  assert.equal(referencePrompts, 0);
});

test("参考插图授权按图片分别确认，同一张图在本次打开中不重复询问", async context => {
  clearIllustrationReferenceConsent();
  let prompts = 0;
  const env = installWx({ showModal: ({ success }: { success?: (result: { confirm: boolean; cancel: boolean }) => void }) => {
    prompts++;
    success?.({ confirm: true, cancel: false });
  } });
  context.after(() => { env.restore(); clearIllustrationReferenceConsent(); });

  assert.equal(await requestIllustrationReferenceConsent("image-a"), true);
  assert.equal(await requestIllustrationReferenceConsent("image-a"), true);
  assert.equal(await requestIllustrationReferenceConsent("image-b"), true);
  assert.equal(prompts, 2);
});

test("拒绝或无法显示参考图授权时不发送图片，拒绝后仍可再次选择", async context => {
  clearAiConsent();
  clearIllustrationReferenceConsent();
  const actions: unknown[] = [];
  let referencePrompts = 0;
  const env = installWx({
    showModal: ({ title, success }: { title?: string; success?: (result: { confirm: boolean; cancel: boolean }) => void }) => {
      if (title === "允许 AI 参考这张插图？") {
        referencePrompts++;
        success?.({ confirm: false, cancel: true });
      } else success?.({ confirm: true, cancel: false });
    },
    cloud: { callFunction: async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
      if (name === "getOpenId") return { result: { openid: "o-owner" } };
      if (name !== "storyImages") return { result: {} };
      actions.push(data?.action);
      return { result: { apiVersion: 2, referenceIllustration: true } };
    } },
  });
  env.setApp(true);
  context.after(() => { env.restore(); clearAiConsent(); clearIllustrationReferenceConsent(); });

  const input = {
    memberId: "owner", chapterId: "chapter-a", purpose: "illustration" as const,
    referenceImageId: "family_o-owner_img_req-aaaaaaaa",
  };
  await assert.rejects(storyImageApi.submitChapterImage(input),
    (error: unknown) => error instanceof StoryImageServiceError && error.code === "CONSENT_DECLINED");
  await assert.rejects(storyImageApi.submitChapterImage(input),
    (error: unknown) => error instanceof StoryImageServiceError && error.code === "CONSENT_DECLINED");
  assert.deepEqual(actions, ["capabilities", "capabilities"]);
  assert.equal(referencePrompts, 2, "拒绝不会被缓存，用户下次仍能重新选择");
});

test("参考图授权弹窗失败时按未授权处理", async context => {
  clearIllustrationReferenceConsent();
  const env = installWx({ showModal: ({ fail }: { fail?: () => void }) => fail?.() });
  context.after(() => { env.restore(); clearIllustrationReferenceConsent(); });
  assert.equal(await requestIllustrationReferenceConsent("image-fail"), false);
});

test("能力预检通过但提交没有确认具体参考图时，客户端拒绝静默降级", async context => {
  clearAiConsent();
  clearIllustrationReferenceConsent();
  const actions: unknown[] = [];
  const env = installWx({
    cloud: { callFunction: async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
      if (name === "getOpenId") return { result: { openid: "o-owner" } };
      if (name !== "storyImages") return { result: {} };
      actions.push(data?.action);
      if (data?.action === "capabilities") return { result: { apiVersion: 2, referenceIllustration: true } };
      return { result: { job: {
        jobId: "family_o-owner_req-x", status: "queued", message: "正在画", chapterId: "chapter-a",
        purpose: "illustration", imageId: "", referenceApplied: true,
        referenceImageId: "family_o-owner_img_req-bbbbbbbb", createdAtMs: 1,
      } } };
    } },
  });
  env.setApp(true);
  context.after(() => { env.restore(); clearAiConsent(); clearIllustrationReferenceConsent(); });

  await assert.rejects(storyImageApi.submitChapterImage({
    memberId: "owner", chapterId: "chapter-a", purpose: "illustration", requestId: "req-test-00000004",
    referenceImageId: "family_o-owner_img_req-aaaaaaaa",
  }), (error: unknown) => error instanceof StoryImageServiceError && error.code === "REFERENCE_UNAVAILABLE");
  assert.deepEqual(actions, ["capabilities", "submit"]);
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

test("文字 AI 已开放但图片 AI 未发布时仍可调用看图写文字", async context => {
  clearPhotoAiConsent();
  const calls: Array<{ name: string; data: Record<string, unknown> }> = [];
  const env = installWx({
    cloud: {
      callFunction: async ({ name, data }: { name: string; data: Record<string, unknown> }) => {
        calls.push({ name, data });
        if (name === "getOpenId") return { result: { openid: "o-owner" } };
        assert.equal(name, "storyImages");
        assert.equal(data.action, "caption");
        return { result: { status: "ok", caption: "院子里晒着被子", message: "", aiGenerated: true } };
      },
    },
  });
  env.setApp(true, false, true);
  context.after(() => { env.restore(); clearPhotoAiConsent(); });

  const result = await storyImageApi.captionPhotos({ photoIds: ["photo-a"], requestId: "req-caption-text1" });

  assert.equal(result.caption, "院子里晒着被子");
  assert.ok(calls.some(({ name, data }) => name === "storyImages" && data.action === "caption"));
});

test("图片 AI 开放但文字 AI 关闭时，看图写文字不会询问授权或调用云函数", async context => {
  clearPhotoAiConsent();
  let modalCount = 0;
  const calls: unknown[] = [];
  const env = installWx({
    showModal: () => { modalCount += 1; },
    cloud: { callFunction: async (options: unknown) => { calls.push(options); return { result: {} }; } },
  });
  env.setApp(true, true, false);
  context.after(() => { env.restore(); clearPhotoAiConsent(); });

  await assert.rejects(
    storyImageApi.captionPhotos({ photoIds: ["photo-a"] }),
    (error: unknown) => error instanceof StoryImageServiceError
      && error.code === "TEXT_AI_NOT_READY"
      && /自己写一句/.test(error.message),
  );
  assert.equal(modalCount, 0);
  assert.deepEqual(calls, []);
});

test("云函数的明确错误、没部署和超时分别给出能看懂的提示", async context => {
  const env = installWx();
  env.setApp(true);
  context.after(env.restore);
  const wxMock = wx as unknown as { cloud: { callFunction: (options: { name: string }) => Promise<unknown> } };

  wxMock.cloud = { callFunction: async ({ name }) => name === "getOpenId" ? { result: { openid: "o-owner" } } : { result: { error: { code: "PROVIDER_QUOTA", message: "供应商账号额度不足，请稍后再试" } } } };
  await assert.rejects(storyImageApi.listStoryImages("owner"),
    (error: unknown) => error instanceof StoryImageServiceError && error.code === "PROVIDER_QUOTA" && error.message === "供应商账号额度不足，请稍后再试");

  wxMock.cloud = { callFunction: async ({ name }) => { if (name === "getOpenId") return { result: { openid: "o-owner" } }; throw { errMsg: "cloud.callFunction:fail -501000 FUNCTION_NOT_FOUND" }; } };
  await assert.rejects(storyImageApi.removeStoryImage("x"), (error: unknown) => error instanceof StoryImageServiceError && error.code === "FUNCTION_MISSING");

  wxMock.cloud = { callFunction: async ({ name }) => { if (name === "getOpenId") return { result: { openid: "o-owner" } }; throw { errMsg: "cloud.callFunction:fail -504003 Invoking task timed out after 3 seconds" }; } };
  await assert.rejects(storyImageApi.checkImageJob("x"), (error: unknown) => error instanceof StoryImageServiceError && error.code === "TIMEOUT");
});

test("云开发没连上时直接说明，不去调用云函数", async context => {
  let cloudCalls = 0;
  const env = installWx({ cloud: { callFunction: async () => { cloudCalls += 1; throw new Error("should not be called"); } } });
  env.setApp(false);
  context.after(env.restore);
  await assert.rejects(storyImageApi.listStoryImages("owner"), (error: unknown) => error instanceof StoryImageServiceError && error.code === "CLOUD_NOT_READY");
  assert.equal(cloudCalls, 0);
});

test("云数据库已连接但图片 AI 尚未发布时不调用配图云函数", async context => {
  let cloudCalls = 0;
  const env = installWx({ cloud: { callFunction: async () => { cloudCalls += 1; throw new Error("should not be called"); } } });
  env.setApp(true, false);
  context.after(env.restore);
  await assert.rejects(storyImageApi.listStoryImages("owner"), (error: unknown) => error instanceof StoryImageServiceError && error.code === "CLOUD_NOT_READY");
  assert.equal(cloudCalls, 0);
});

test("文字音频 AI 关闭但图片 AI 已发布时仍可调用配图云函数", async context => {
  const calls: Array<{ name: string; data?: Record<string, unknown> }> = [];
  const env = installWx({ cloud: { callFunction: async (options: { name: string; data?: Record<string, unknown> }) => {
    calls.push(options);
    if (options.name === "getOpenId") return { result: { openid: "o-owner" } };
    return { result: { images: [], pending: [], usage: { count: 0, bytes: 0 }, limits: { daily: 10, book: 30 } } };
  } } });
  env.setApp(true, true, false);
  context.after(env.restore);

  const result = await storyImageApi.listStoryImages("owner");
  assert.deepEqual(result.images, []);
  assert.equal(calls.some(item => item.name === "storyImages" && item.data?.action === "list"), true);
});

// ---------- 页面 ----------

test("这本书的图：按章节分组，显示占用空间和正在画的图，并在前台轮询", async context => {
  const env = installWx({}, stateWithBook());
  env.setApp(false);
  const timers = captureTimers();
  const restoreApi = withApi({ listStoryImages: async () => listWith() });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  call(page, "onLoad", { chapterId: encodeURIComponent("chapter-a"), purpose: "backdrop" });
  await call(page, "refresh");

  const groups = page.data.groups as Array<{ id: string; title: string; images: Array<{ sizeLabel: string; moderationLabel: string; qualityLabel: string; purposeLabel: string; isBackdrop: boolean; inUse: boolean }>; pending: Array<{ active: boolean; purposeLabel: string }> }>;
  assert.equal(page.data.focusChapterId, "chapter-a");
  assert.equal(page.data.focusPurpose, "backdrop");
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
    listStoryImages: async () => { listCalls++; return listCalls === 1 ? listWith() : listWith({ pending: [], images: [] }); },
    checkImageJob: async jobId => { checked.push(jobId); return { job: { ...listWith().pending[0], status: "stored", message: "画好了" } }; },
  });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  call(page, "onLoad", {});
  await call(page, "refresh");
  assert.equal(timers.scheduled.length, 1);
  page.setData({ noticeChapterId: "chapter-b", notice: "正在画" });
  await call(page, "pollOnce");
  assert.deepEqual(checked, ["family_o-owner_req-b"]);
  assert.equal(listCalls, 2);
  assert.equal(timers.scheduled.length, 1, "图画好后不再安排下一次轮询");
  assert.equal(page.data.notice, "画好了", "完成后不能继续显示正在画");

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
  call(page, "onArtDirectionInput", { currentTarget: { dataset: { id: "chapter-a" } }, detail: { value: "暖黄彩铅" } });
  await call(page, "generate", { currentTarget: { dataset: { id: "chapter-a", purpose: "illustration" } } });
  await call(page, "generate", { currentTarget: { dataset: { id: "chapter-b", purpose: "backdrop" } } });
  await call(page, "generate", { currentTarget: { dataset: {
    id: "chapter-a", purpose: "illustration", reference: "family_o-owner_img_req-aaaaaaaa",
  } } });
  assert.deepEqual(submitted, [
    { memberId: "owner", chapterId: "chapter-a", purpose: "illustration", artDirection: "暖黄彩铅" },
    { memberId: "owner", chapterId: "chapter-b", purpose: "backdrop" },
    { memberId: "owner", chapterId: "chapter-a", purpose: "illustration", referenceImageId: "family_o-owner_img_req-aaaaaaaa", artDirection: "暖黄彩铅" },
  ]);
  assert.equal(page.data.notice, "正在画，大约 20–60 秒。可以先离开，回来接着看");
  assert.equal(page.data.submitting, "");

  await call(page, "remove", { currentTarget: { dataset: { id: "family_o-owner_img_req-aaaaaaaa" } } });
  assert.deepEqual(removed, ["family_o-owner_img_req-aaaaaaaa"]);
  assert.equal(page.data.notice, "已删除");

  call(page, "previewImage", { currentTarget: { dataset: { url: "https://tmp.example/a.png" } } });
  assert.deepEqual(env.previews, []);
  assert.equal((page.data.preview as any).imageId, "family_o-owner_img_req-aaaaaaaa");
  assert.equal((page.data.placementOptions as any[])[1].after.text, "院子里晒着被子。");
  call(page, "closePreview");
  assert.equal(page.data.preview, null, "setData uses explicit null to close the native sheet");
});

test("本章照片可选，默认只按文字生成，选择和取消参考都生效", async context => {
  const state = stateWithBook();
  state.manuscriptRevisions![0].draft.chapters![0].content.push(
    { photoId: "photo-cat" },
    { photoId: "photo-ai-req-aaaaaaaa" },
  );
  const env = installWx({}, state);
  env.setApp(false);
  const submitted: unknown[] = [];
  const restoreApi = withApi({
    listStoryImages: async () => listWith({ images: [], pending: [] }),
    submitChapterImage: async input => { submitted.push(input); return { ...listWith().pending[0], chapterId: input.chapterId, purpose: input.purpose }; },
  });
  context.after(() => { restoreApi(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  context.after(() => call(page, "onUnload"));
  call(page, "onLoad", {});
  await call(page, "refresh");
  const groups = page.data.groups as Array<{ referencePhotoIds: string[] }>;
  assert.deepEqual(groups[0].referencePhotoIds, ["photo-cat"]);
  await call(page, "generate", { currentTarget: { dataset: { id: "chapter-a", purpose: "backdrop" } } });
  assert.deepEqual(submitted.pop(), { memberId: "owner", chapterId: "chapter-a", purpose: "backdrop" });
  call(page, "onReferenceModeChange", { currentTarget: { dataset: { id: "chapter-a" } }, detail: { value: true } });
  await call(page, "refresh"); // Polling/refresh must preserve the explicit choice.

  await call(page, "generate", { currentTarget: { dataset: { id: "chapter-a", purpose: "illustration" } } });
  await call(page, "generate", { currentTarget: { dataset: { id: "chapter-a", purpose: "backdrop" } } });
  await call(page, "generate", { currentTarget: { dataset: {
    id: "chapter-a", purpose: "illustration", reference: "family_o-owner_img_req-aaaaaaaa",
  } } });
  assert.deepEqual(submitted, [
    { memberId: "owner", chapterId: "chapter-a", purpose: "illustration", referencePhotoIds: ["photo-cat"] },
    { memberId: "owner", chapterId: "chapter-a", purpose: "backdrop", referencePhotoIds: ["photo-cat"] },
    { memberId: "owner", chapterId: "chapter-a", purpose: "illustration", referenceImageId: "family_o-owner_img_req-aaaaaaaa" },
  ]);
  call(page, "onReferenceModeChange", { currentTarget: { dataset: { id: "chapter-a" } }, detail: { value: false } });
  await call(page, "generate", { currentTarget: { dataset: { id: "chapter-a", purpose: "illustration" } } });
  assert.deepEqual(submitted[submitted.length - 1], { memberId: "owner", chapterId: "chapter-a", purpose: "illustration" });
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

test("配图等待和失败反馈留在点击的章节，等待期间重复点击不重复提交", async context => {
  const env = installWx({}, stateWithBook());
  env.setApp(false);
  let rejectRequest!: (error: Error) => void;
  let submitted = 0;
  const restoreApi = withApi({
    submitChapterImage: () => {
      submitted++;
      return new Promise((_resolve, reject) => { rejectRequest = reject; });
    },
  });
  context.after(() => { restoreApi(); env.restore(); });
  const page = instantiate(await pageDefinition("story-images"));
  const event = { currentTarget: { dataset: { id: "chapter-b", purpose: "illustration" } } };
  const pending = call(page, "generate", event);
  assert.equal(page.data.noticeChapterId, "chapter-b");
  assert.match(String(page.data.notice), /正在读取/);
  await call(page, "generate", event);
  assert.equal(submitted, 1);
  rejectRequest(new StoryImageServiceError("CLOUD_FAILED", "配图服务暂时出错，请稍后再试"));
  await pending;
  assert.equal(page.data.noticeChapterId, "chapter-b");
  assert.equal(page.data.notice, "配图服务暂时出错，请稍后再试");
  assert.equal(page.data.submitting, "");
});

test("提交配图失败时把原因显示出来，按钮恢复可点", async context => {
  const env = installWx({}, stateWithBook());
  env.setApp(false);
  const timers = captureTimers();
  const restoreApi = withApi({
    listStoryImages: async () => listWith({ pending: [] }),
    submitChapterImage: async () => { throw new StoryImageServiceError("PROVIDER_QUOTA", "供应商账号额度不足，请稍后再试"); },
  });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });

  const page = instantiate(await pageDefinition("story-images"));
  call(page, "onLoad", {});
  await call(page, "refresh");
  await call(page, "generate", { currentTarget: { dataset: { id: "chapter-a" } } });
  assert.equal(page.data.notice, "供应商账号额度不足，请稍后再试");
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

test("书稿照片菜单把插图、底图和封面入口路由到对应后端页面", async context => {
  const env = installWx({ hideKeyboard: () => undefined }, stateWithBook());
  env.setApp(false);
  context.after(env.restore);

  const page = instantiate(await pageDefinition("book"));
  const draft: BiographyDraft = { title: "外婆的书", paragraphs: [], sourceCount: 0, generatedAt: "", generationMode: "local-demo" };
  page.chapters = [
    { id: "chapter-a", title: "老院子", memoryIds: [], content: [{ text: "院子里晒着被子。\n" }] },
    { id: "chapter-b", title: "渡口", memoryIds: [], content: [{ text: "渡口的风吹过来。\n" }] },
  ];
  page.activeChapterId = "chapter-a";
  page.setData({
    draft, view: "contents", storyId: "story special/一", savedRevisionId: "revision-a",
    chapterRows: [
      { id: "chapter-a", label: "第一章", title: "老院子", memoryCount: 0, photoCount: 0 },
      { id: "chapter-b", label: "第二章", title: "渡口", memoryCount: 0, photoCount: 0 },
    ],
  });
  page.finishEditing = async () => true;
  const opened: string[] = [];
  page.openChapter = async (event: { currentTarget: { dataset: { id: string } } }) => {
    opened.push(event.currentTarget.dataset.id);
    page.activeChapterId = event.currentTarget.dataset.id;
    page.setData({ view: "chapter" });
  };

  await call(page, "choosePhotoAction", { currentTarget: { dataset: { action: "illustration" } } });
  assert.equal(page.data.photoMenu, "chapters");
  assert.equal(page.data.photoAction, "illustration");
  await call(page, "choosePhotoChapter", { currentTarget: { dataset: { id: "chapter-b" } } });
  assert.deepEqual(opened, ["chapter-b"]);
  assert.equal(env.navigations[0], "/pages/story-images/story-images?storyId=story%20special%2F%E4%B8%80&chapterId=chapter-b&purpose=illustration");
  assert.equal(page.data.preparingPhoto, false);

  page.setData({ view: "chapter", photoMenu: "generate" });
  page.activeChapterId = "chapter-b";
  await call(page, "choosePhotoAction", { currentTarget: { dataset: { action: "backdrop" } } });
  assert.equal(env.navigations[1], "/pages/story-images/story-images?storyId=story%20special%2F%E4%B8%80&chapterId=chapter-b&purpose=backdrop");

  page.setData({ view: "contents", photoMenu: "generate" });
  await call(page, "choosePhotoAction", { currentTarget: { dataset: { action: "cover" } } });
  assert.equal(env.navigations[2], "/pages/story-cover/story-cover?storyId=story%20special%2F%E4%B8%80");
});

test("目录照片导入先切到目标章节，等编辑器准备好后才打开相册", async context => {
  const env = installWx({ hideKeyboard: () => undefined }, stateWithBook());
  env.setApp(false);
  context.after(env.restore);

  const page = instantiate(await pageDefinition("book"));
  const draft: BiographyDraft = { title: "外婆的书", paragraphs: [], sourceCount: 0, generatedAt: "", generationMode: "local-demo" };
  page.chapters = [
    { id: "chapter-a", title: "老院子", memoryIds: [], content: [{ text: "院子里晒着被子。\n" }] },
    { id: "chapter-b", title: "渡口", memoryIds: [], content: [{ text: "渡口的风吹过来。\n" }] },
  ];
  page.activeChapterId = "chapter-a";
  page.setData({
    draft, view: "contents",
    chapterRows: [
      { id: "chapter-a", label: "第一章", title: "老院子", memoryCount: 0, photoCount: 0 },
      { id: "chapter-b", label: "第二章", title: "渡口", memoryCount: 0, photoCount: 0 },
    ],
  });
  let imports = 0;
  let finishCalls = 0;
  let editorReady!: () => void;
  page.finishEditing = async () => { finishCalls++; return true; };
  page.addPhoto = async () => { imports++; };
  page.editorContext = {
    setContents: ({ success }: { success: () => void }) => { editorReady = success; },
  };

  await call(page, "choosePhotoAction", { currentTarget: { dataset: { action: "import" } } });
  await call(page, "choosePhotoChapter", { currentTarget: { dataset: { id: "chapter-b" } } });
  assert.equal(page.data.view, "chapter");
  assert.equal(page.activeChapterId, "chapter-b");
  assert.equal(page.pendingPhotoImportChapter, "chapter-b");
  assert.equal(imports, 0);
  assert.equal(finishCalls, 1);
  assert.match(String(page.data.saveNotice), /编辑器准备好后/);

  editorReady();
  assert.equal(page.pendingPhotoImportChapter, "");
  assert.equal(imports, 1);
});

test("照片菜单不会在保存失败、离页或受保护副本时启动图片流程", async context => {
  const env = installWx({ hideKeyboard: () => undefined }, stateWithBook());
  env.setApp(false);
  context.after(env.restore);

  const page = instantiate(await pageDefinition("book"));
  const draft: BiographyDraft = { title: "外婆的书", paragraphs: [], sourceCount: 0, generatedAt: "", generationMode: "local-demo" };
  page.chapters = [{ id: "chapter-a", title: "老院子", memoryIds: [], content: [{ text: "院子里晒着被子。\n" }] }];
  page.activeChapterId = "chapter-a";
  page.setData({ draft, view: "chapter", storyId: "story-a", savedRevisionId: "revision-a" });
  let finishCalls = 0;
  page.finishEditing = async () => { finishCalls++; return false; };
  await call(page, "runPhotoAction", "illustration", "chapter-a");
  assert.deepEqual(env.navigations, []);
  assert.equal(page.data.preparingPhoto, false);

  page.finishEditing = async () => { finishCalls++; return true; };
  page.setData({ protectedCopy: true });
  await call(page, "runPhotoAction", "backdrop", "chapter-a");
  await call(page, "choosePhotoAction", { currentTarget: { dataset: { action: "cover" } } });
  assert.equal(finishCalls, 1);
  assert.deepEqual(env.navigations, []);
});

test("目录页用封面背景和正文摘录展示书的简介，不再显示制作封面小书壳", async () => {
  const page = instantiate(await pageDefinition("book"));
  const longText = Array.from({ length: 180 }, (_, index) => index % 2 ? "春" : "🌿").join("");
  page.chapters = [
    { id: "chapter-a", title: "老院子", memoryIds: [], content: [{ text: `  ${longText}  ` }, { photoId: "photo-secret" }] },
    { id: "chapter-b", title: "渡口", memoryIds: [], content: [{ text: "第二章会继续写下去。\n" }] },
  ];

  const data = call(page, "chapterData") as { bookIntroduction: string };
  assert.equal(Array.from(data.bookIntroduction).length, 161);
  assert.ok(data.bookIntroduction.endsWith("…"));
  assert.equal(data.bookIntroduction.includes("photo-secret"), false);

  const markup = readFileSync("miniprogram/pages/book/book.wxml", "utf8");
  assert.match(markup, /class="contents-cover-background"/);
  assert.match(markup, /内容简介/);
  assert.match(markup, /图片导入/);
  assert.match(markup, /生成插图/);
  assert.match(markup, /生成底图/);
  assert.match(markup, /生成封面/);
  assert.doesNotMatch(markup, /contents-cover-button|contents-cover-caption|story-book-cover\.png|制作封面/);
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
  assert.match(markup, /class="chapter-backdrop"[^>]*mode="aspectFill"/);
  assert.doesNotMatch(markup, /chapter-backdrop-echo|chapter-edge-ornament/);
  const styles = readFileSync("miniprogram/pages/book/book.wxss", "utf8");
  assert.match(styles, /\.chapter-backdrop[^{]*{[^}]*width: 100%;[^}]*height: 100%/);
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

test("封面参考支持照片与插图混选，最多三张，等待期间重复点击不重复生成", async context => {
  const env=installWx();env.setApp(false);
  const original={...storyCoverApi};
  const selected:Array<{referencePhotoIds:string[];referenceImageIds:string[];artDirection?:string}>=[];
  let resolveJob!: (value: {jobId:string;status:'failed';message:string;chapterId:string;purpose:string;imageId:string;createdAtMs:number}) => void;
  storyCoverApi.submit=async input=>{selected.push(input);return new Promise(resolve=>{resolveJob=resolve;});};
  context.after(()=>{Object.assign(storyCoverApi,original);env.restore();});
  const page=instantiate(await pageDefinition('story-cover'));
  page.refresh=async()=>undefined;
  page.setData({storyId:'story-one',loading:false,references:[
    {id:'photo-a',kind:'photo',selected:false},{id:'image-a',kind:'image',selected:false},
    {id:'image-b',kind:'image',selected:false},{id:'image-c',kind:'image',selected:false},
  ]});
  for(const id of ['photo-a','image-a','image-b','image-c']) call(page,'toggleReference',{currentTarget:{dataset:{id}}});
  call(page,'onArtDirectionInput',{detail:{value:'粗纸上的淡墨'}});
  assert.equal(page.data.selectedCount,3);
  const pending=call(page,'generate');
  await call(page,'generate');
  assert.equal(selected.length,1);
  assert.deepEqual(selected[0].referencePhotoIds,['photo-a']);
  assert.deepEqual(selected[0].referenceImageIds,['image-a','image-b']);
  assert.equal(selected[0].artDirection,'粗纸上的淡墨');
  resolveJob({jobId:'job',status:'failed',message:'读取超时',chapterId:'book-cover',purpose:'cover',imageId:'',createdAtMs:1});
  await pending;
  assert.equal(page.data.submitting,false);
  assert.equal(page.data.notice,'读取超时');
});

test("分享封面候选只暴露已审核封面图，并保留封面任务", async context => {
  const restoreApi = withApi({ listStoryImages: async bookId => {
    assert.equal(bookId, 'story-one');
    return listWith({
      images: [
        { imageId: 'cover-pass', chapterId: 'book-cover', purpose: 'cover', url: 'https://tmp.example/cover-pass.png', bytes: 10, moderation: 'pass', quality: 'pass', qualityIssues: [], aiGenerated: true, createdAtMs: 9 },
        { imageId: 'cover-review', chapterId: 'book-cover', purpose: 'cover', url: 'https://tmp.example/cover-review.png', bytes: 10, moderation: 'review', quality: 'pass', qualityIssues: [], aiGenerated: true, createdAtMs: 8 },
        { imageId: 'cover-empty-url', chapterId: 'book-cover', purpose: 'cover', url: '', bytes: 10, moderation: 'pass', quality: 'pass', qualityIssues: [], aiGenerated: true, createdAtMs: 7 },
        { imageId: 'illustration-pass', chapterId: 'chapter-a', purpose: 'illustration', url: 'https://tmp.example/illustration.png', bytes: 10, moderation: 'pass', quality: 'pass', qualityIssues: [], aiGenerated: true, createdAtMs: 6 },
      ],
      pending: [
        { jobId: 'job-cover', status: 'queued', message: '正在画封面', chapterId: 'book-cover', purpose: 'cover', imageId: '', createdAtMs: 5 },
        { jobId: 'job-illustration', status: 'queued', message: '正在画插图', chapterId: 'chapter-a', purpose: 'illustration', imageId: '', createdAtMs: 4 },
      ],
    });
  } });
  context.after(restoreApi);

  const result = await storyCoverApi.listShareCoverCandidates('story-one');

  assert.deepEqual(result.candidates, [{ imageId: 'cover-pass', url: 'https://tmp.example/cover-pass.png', createdAtMs: 9 }]);
  assert.deepEqual(result.pendingJobs.map(job => job.jobId), ['job-cover']);
});

test("分享封面任务查询只接受 cover job", async context => {
  const calls: Array<{ jobId: string; bookId?: string }> = [];
  const restoreApi = withApi({ checkImageJob: async (jobId, bookId) => {
    calls.push({ jobId, bookId });
    const purpose = jobId === 'job-cover' || jobId === 'job-cover-bad-image' ? 'cover' : 'illustration';
    const imagePurpose = jobId === 'job-cover-bad-image' ? 'illustration' : purpose;
    return {
      job: { jobId, status: 'stored', message: '画好了', chapterId: purpose === 'cover' ? 'book-cover' : 'chapter-a', purpose, imageId: 'image-one', createdAtMs: 1 },
      image: { imageId: 'image-one', chapterId: purpose === 'cover' ? 'book-cover' : 'chapter-a', purpose: imagePurpose, url: 'https://tmp.example/image.png', bytes: 10, moderation: 'pass', quality: 'pass', qualityIssues: [], aiGenerated: true, createdAtMs: 2 },
    };
  } });
  context.after(restoreApi);

  const job = await storyCoverApi.checkShareCoverJob('story-one', 'job-cover');

  assert.equal(job.purpose, 'cover');
  assert.deepEqual(calls[0], { jobId: 'job-cover', bookId: 'story-one' });
  await assert.rejects(storyCoverApi.checkShareCoverJob('story-one', 'job-illustration'), { code: 'JOB_NOT_FOUND' });
  await assert.rejects(storyCoverApi.checkShareCoverJob('story-one', 'job-cover-bad-image'), { code: 'JOB_NOT_FOUND' });
});

test("封面的美术想法也要求云端确认已采用", async context=>{
  const calls:Array<{name:string;data?:Record<string,unknown>}>=[];
  const env=installWx({cloud:{callFunction:async({name,data}:{name:string;data?:Record<string,unknown>})=>{
    calls.push({name,data});
    if(name==='getOpenId')return {result:{openid:'o-owner'}};
    if(data?.action==='capabilities')return {result:{apiVersion:4,guidedGeneration:true}};
    return {result:{job:{jobId:'family_o-owner_req-cover',status:'queued',message:'正在画',chapterId:'book-cover',purpose:'cover',imageId:'',ideaApplied:true,createdAtMs:1}}};
  }}});
  context.after(()=>env.restore());env.setApp(true);
  await storyCoverApi.submit({storyId:'story-one',referenceImageIds:[],referencePhotoIds:[],artDirection:'粗纸上的淡墨',requestId:'req-cover-fixed'});
  assert.deepEqual(calls.filter(item=>item.name==='storyImages').map(item=>item.data?.action),['capabilities','submit']);
  assert.equal(calls.find(item=>item.data?.action==='submit')?.data?.artDirection,'粗纸上的淡墨');
  assert.equal(calls.find(item=>item.data?.action==='submit')?.data?.requestId,'req-cover-fixed');
});

test("封面生成授权拒绝后不调用云函数，不擅自使用用户图片",async context=>{
  let cloudCalls=0;
  const env=installWx({showModal:({success}:{success:(r:{confirm:boolean})=>void})=>success({confirm:false}),cloud:{callFunction:()=>{cloudCalls++;}}});
  context.after(env.restore);env.setApp(true);
  await assert.rejects(storyCoverApi.submit({storyId:'story-one',referenceImageIds:[],referencePhotoIds:['photo-a']}),{code:'CONSENT_DECLINED'});
  assert.equal(cloudCalls,0);
});

test("封面选用需审核通过且携带故事版本，刷新后同步显示选用结果",async context=>{
  const env=installWx();env.setApp(false);
  const original={...storyCoverApi};
  const calls:unknown[]=[];
  storyCoverApi.select=async(...args)=>{calls.push(args);return {ok:true};};
  context.after(()=>{Object.assign(storyCoverApi,original);env.restore();});
  const page=instantiate(await pageDefinition('story-cover'));
  page.setData({storyId:'story-one',version:7,covers:[{imageId:'pending',ready:false,selected:false},{imageId:'cover-a',ready:true,selected:false}]});
  page.refresh=async()=>{page.setData({coverImageId:'cover-a',version:8});};
  await call(page,'choose',{currentTarget:{dataset:{id:'pending'}}});
  assert.deepEqual(calls,[]);
  await call(page,'choose',{currentTarget:{dataset:{id:'cover-a'}}});
  assert.deepEqual(calls,[['story-one','cover-a',7]]);
  assert.equal(page.data.coverImageId,'cover-a');
  assert.match(String(page.data.notice),/首页.*同步/);
  assert.equal(page.data.selecting,false);
});

test('配图提交后直接进入启动轮询，不先重读整房与列表', async context => {
  const env = installWx({}, stateWithBook()); env.setApp(false);
  const timers = captureTimers();
  let listCalls = 0;
  const job = listWith().pending[0];
  const restoreApi = withApi({
    listStoryImages: async () => { listCalls++; return listWith({ pending: [] }); },
    submitChapterImage: async () => job,
  });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });
  const page = instantiate(await pageDefinition('story-images'));
  await call(page, 'refresh');
  await call(page, 'generate', {currentTarget:{dataset:{id:'chapter-b'}}});
  assert.equal(listCalls, 1, 'submit already returned the authoritative job');
  assert.deepEqual(page.activeJobIds, [job.jobId]);
  assert.equal(timers.scheduled[timers.scheduled.length - 1]?.delay, 0, 'start generation on the next event-loop turn');
});

test('封面提交后直接进入启动轮询，不重新读取封面来源', async context => {
  const env = installWx(); env.setApp(false);
  const timers = captureTimers();
  const original = {...storyCoverApi};
  const job = {...listWith().pending[0], purpose:'cover', chapterId:'book-cover'};
  storyCoverApi.submit = async () => job;
  context.after(() => { Object.assign(storyCoverApi, original); timers.restore(); env.restore(); });
  const page = instantiate(await pageDefinition('story-cover'));
  page.setData({storyId:'story-one', loading:false});
  let refreshes = 0; page.refresh = async () => { refreshes++; };
  await call(page, 'generate');
  assert.equal(refreshes, 0);
  assert.deepEqual(page.data.jobs, [job]);
  assert.equal(timers.scheduled[timers.scheduled.length - 1]?.delay, 0);
});

test('图片轮询最多两路，重复进入不重发，离开后不再启动剩余任务', async context => {
  const env = installWx(); env.setApp(false);
  const timers = captureTimers();
  const requested: string[] = [];
  let stopped = false;
  const finishers: Array<() => void> = [];
  const restoreApi = withApi({checkImageJob: jobId => {
    requested.push(jobId);
    if (stopped) return Promise.resolve({job:{...listWith().pending[0], jobId}});
    return new Promise(resolve => finishers.push(() => resolve({job:{...listWith().pending[0], jobId}})));
  }});
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });
  const page = instantiate(await pageDefinition('story-images'));
  page.activeJobIds = ['a','b','c'];
  const polling = call(page,'pollOnce');
  await new Promise(resolve => setImmediate(resolve));
  const second = call(page,'pollOnce');
  const started = [...requested];
  stopped = true;
  call(page,'onHide');
  finishers.forEach(finish => finish());
  await Promise.all([polling,second]);
  assert.deepEqual(started,['a','b']);
  assert.deepEqual(requested,['a','b']);
  assert.equal(timers.scheduled.length,0);
});


test('图片生成完成后继续轻量更新审核与美观检查，完成后停止', async context => {
  const env = installWx({}, stateWithBook()); env.setApp(false);
  const timers = captureTimers();
  let lists = 0;
  const restoreApi = withApi({listStoryImages:async() => {
    lists++;
    return listWith({pending:[],images:[{...listWith().images[1], quality:lists === 1 ? 'pending':'pass'}]});
  },checkImageJob:async() => {throw new Error('no generation job should be polled');}});
  context.after(() => {restoreApi();timers.restore();env.restore();});
  const page = instantiate(await pageDefinition('story-images'));
  await call(page,'refresh');
  assert.equal(page.pendingImageChecks,true);
  await call(page,'pollOnce');
  assert.equal(lists,2);
  assert.equal(page.pendingImageChecks,false);
  assert.equal(timers.scheduled.length,1);
});

test('配图结束后列表加载失败仍停止生成反馈，重试后显示图片', async context => {
  const env = installWx({}, stateWithBook()); env.setApp(false);
  const timers = captureTimers();
  let lists = 0;
  let status: 'stored' | 'failed' | 'unknown' = 'stored';
  const job = listWith().pending[0];
  const restoreApi = withApi({
    listStoryImages: async () => {
      if (++lists === 1) return listWith({images:[], pending:[job]});
      if (lists === 2) throw new Error('图片列表暂时断线');
      return listWith({pending:[], images:[]});
    },
    checkImageJob: async () => ({job:{...job, status, message:'任务已结束'}}),
  });
  context.after(() => { restoreApi(); timers.restore(); env.restore(); });
  for (status of ['stored', 'failed', 'unknown'] as const) {
    lists = 0;
    const page = instantiate(await pageDefinition('story-images'));
    await call(page, 'refresh');
    await call(page, 'pollOnce');
    const rows = page.data.groups as Array<{pending:Array<{active:boolean;message:string}>}>;
    assert.equal(rows[1].pending[0].active, false, status);
    assert.equal(rows[1].pending[0].message, '任务已结束');
    assert.match(String(page.data.notice), /断线/);
    assert.ok(page.pollTimer !== undefined, 'reload is retried without keeping the animation active');
    await call(page, 'pollOnce');
    assert.deepEqual(page.activeJobIds, []);
    assert.equal(page.pollTimer, undefined);
  }
});

test('封面结束后列表加载失败停止动画并只重试列表，不再请求生成状态', async context => {
  const env = installWx(); env.setApp(false);
  const timers = captureTimers();
  let lists = 0, checks = 0;
  let status: 'stored' | 'failed' | 'unknown' = 'stored';
  const job = {...listWith().pending[0], purpose:'cover', chapterId:'book-cover'};
  const restoreApi = withApi({
    listStoryImages: async () => {
      if (++lists === 1) throw new Error('封面列表暂时断线');
      return listWith({pending:[], images:[]});
    },
    checkImageJob: async () => { checks++; return {job:{...job, status, message:'任务已结束'}}; },
  });
  const originalSources = storyCoverApi.sources;
  storyCoverApi.sources = async () => { throw new Error('completion must not reload the manuscript'); };
  context.after(() => { storyCoverApi.sources = originalSources; restoreApi(); timers.restore(); env.restore(); });
  for (status of ['stored', 'failed', 'unknown'] as const) {
    lists = 0; checks = 0;
    const page = instantiate(await pageDefinition('story-cover'));
    page.setData({storyId:'story-one', jobs:[job], activeJob:true, loading:false});
    await call(page, 'poll');
    assert.equal(page.data.activeJob, false);
    assert.equal((page.data.jobs as Array<{status:string}>)[0].status, status);
    assert.match(String(page.data.notice), /断线/);
    assert.ok(page.timer !== undefined, 'retry survives a terminal job');
    await call(page, 'poll');
    assert.equal(checks, 1);
    assert.equal(lists, 2);
    assert.deepEqual(page.data.jobs, []);
    assert.equal(page.timer, undefined);
  }
});

test('故事里的插图返回正文后按故事查询，旧档案回退仍可用', async context => {
  const env = installWx(); env.setApp(false);
  const books: string[] = [];
  const selected = {imageId:'family_o-owner_img_req-abcdefgh', chapterId:'chapter-a', url:'https://tmp.example/old.png'};
  const restoreApi = withApi({listStoryImages:async bookId => {
    books.push(bookId);
    return listWith({images:bookId === 'story-one' || bookId === 'legacy-owner' ? [{...listWith().images[0], imageId:selected.imageId, url:'https://tmp.example/fresh.png'}] : []});
  }});
  context.after(() => { restoreApi(); env.restore(); });
  for (const storyId of ['story-one', '']) {
    const page = instantiate(await pageDefinition('book'));
    page.setData({storyId, memberId:storyId ? 'owner':'legacy-owner', storyImageSelected:true, refreshingStoryImage:true});
    page.pendingStoryImage = {...selected};
    await call(page,'refreshSelectedStoryImageUrl');
    assert.equal((page.pendingStoryImage as typeof selected)?.url, 'https://tmp.example/fresh.png');
    assert.equal(page.data.storyImageSelected,true);
    assert.equal(page.data.refreshingStoryImage,false);
  }
  assert.deepEqual(books,['story-one','legacy-owner']);
});

test('读取书稿与确认草稿账号并行，二者都成功前不读本机草稿', async context => {
  const state = {...stateWithBook(), roomStateVersion:1, deletedStories:[], stories:[], personalDrafts:{}, personalDraftSourceFingerprints:{}};
  let warmed = false, identityCalls = 0;
  let releaseState!: () => void, releaseIdentity!: () => void;
  const stateResponse = new Promise(resolve => { releaseState = () => resolve({result:state}); });
  const identityResponse = new Promise(resolve => { releaseIdentity = () => resolve({result:{openid:'o-owner'}}); });
  const draftReads: string[] = [];
  const env = installWx({getStorageSync:(key:string) => { if (key.startsWith('shiguang-chapter-draft-v1:')) draftReads.push(key); return undefined; },
    cloud:{callFunction:async ({name}: {name:string}) => {
      if (name === 'getOpenId') { if (!warmed) return {result:{openid:'o-owner'}}; identityCalls++; return identityResponse; }
      if (name === 'storyBooks') return stateResponse;
      throw new Error('unexpected function');
    }},
  });
  env.setApp(true);
  context.after(() => { releaseState(); releaseIdentity(); env.restore(); });
  const {currentFamilyId} = await import('../miniprogram/services/cloudRoomStorage');
  await currentFamilyId(); warmed = true;
  const page = instantiate(await pageDefinition('book'));
  const loading = call(page,'refresh');
  await new Promise(resolve => setImmediate(resolve));
  const startedConcurrently = identityCalls;
  assert.deepEqual(draftReads, []);
  releaseState();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(draftReads, [], 'unconfirmed account must not read local drafts');
  releaseIdentity(); await loading;
  assert.equal(startedConcurrently,1,'draft identity starts before the room response');
  assert.equal(draftReads.length,1);
  assert.equal(page.data.loading,false);
});

test('declining cover consent stops busy feedback without refreshing; uncertain failures still reconcile jobs', async context => {
  const original = storyCoverApi.submit;
  context.after(() => { storyCoverApi.submit = original; });
  const page = instantiate(await pageDefinition('story-cover'));
  page.setData({ storyId: 'story-test', loading: false });
  let refreshes = 0;
  page.refresh = async () => { refreshes++; };
  storyCoverApi.submit = async () => { throw new StoryImageServiceError('CONSENT_DECLINED', '本次没有生成封面'); };
  await call(page, 'generate');
  assert.equal(refreshes, 0, 'cancelled consent never submitted a paid task to reconcile');
  assert.equal(page.data.submitting, false);
  assert.equal(page.data.notice, '本次没有生成封面');
  storyCoverApi.submit = async () => { throw new StoryImageServiceError('TIMEOUT', '状态未确认'); };
  await call(page, 'generate');
  assert.equal(refreshes, 1, 'a lost acknowledgement may hide a queued paid task');
  assert.equal(page.data.submitting, false);
});

test('大图下选择段落、保存、重新打开和移除都保留历史与其他章节', async context => {
  const state = stateWithBook(BACKDROP_ID);
  state.manuscriptRevisions![0].draft.chapters![0].content = [{ text: '第一段。\n第二段。\n' }, { photoId: 'photo-original' }];
  const env = installWx({}, state); env.setApp(false);
  const images = listWith({ pending: [] }).images.map(image => ({ ...image, moderation: 'pass' as const, quality: 'pass' as const }));
  context.after(() => env.restore());
  context.after(withApi({ listStoryImages: async () => listWith({ images, pending: [] }) }));
  const page = instantiate(await pageDefinition('story-images'));
  await call(page, 'refresh');
  call(page, 'previewImage', { currentTarget: { dataset: { url: images[0].url } } });
  call(page, 'onPlacementChange', { detail: { value: '1' } });
  await call(page, 'savePlacement');
  assert.match(String(page.data.previewNotice), /位置已保存/);
  const saved = await loadRoomStateRemoteFirst();
  const chapters = currentManuscript(saved, 'owner').draft!.chapters!;
  assert.deepEqual(chapters[0].content, [{ text: '第一段。\n' }, { photoId: 'photo-ai-req-aaaaaaaa' }, { text: '第二段。\n' }, { photoId: 'photo-original' }]);
  assert.equal(chapters[0].backdropImageId, BACKDROP_ID);
  assert.equal(chapters[1].content[0].text, '第二章的文字。\n');
  assert.equal(saved.manuscriptRevisions!.length, 2);
  await call(page, 'savePlacement');
  assert.equal((await loadRoomStateRemoteFirst()).manuscriptRevisions!.length, 2, '同位置保存幂等');
  call(page, 'closePreview');
  call(page, 'previewImage', { currentTarget: { dataset: { url: images[0].url } } });
  assert.equal(page.data.placementIndex, 1);
  assert.equal((page.data.preview as any).inText, true);
  await call(page, 'savePlacement', { currentTarget: { dataset: { remove: true } } });
  const after = await loadRoomStateRemoteFirst();
  assert.deepEqual(currentManuscript(after, 'owner').draft!.chapters![0].content, state.manuscriptRevisions![0].draft.chapters![0].content);
  assert.equal(after.manuscriptRevisions!.length, 3);
  assert.equal((page.data.preview as any).inText, false);
  assert.equal((page.data.groups as any[])[0].images.length, 2, '从正文移除仍保留原图');
});

test('段落在其他页面更新后不按旧序号插入，刷新选项等待重选', async context => {
  const env = installWx({}, stateWithBook()); env.setApp(false);
  context.after(() => env.restore());
  const images = listWith({ pending: [] }).images.map(image => ({ ...image, moderation: 'pass' as const, quality: 'pass' as const }));
  context.after(withApi({ listStoryImages: async () => listWith({ images, pending: [] }) }));
  const page = instantiate(await pageDefinition('story-images'));
  await call(page, 'refresh');
  call(page, 'previewImage', { currentTarget: { dataset: { url: images[0].url } } });
  call(page, 'onPlacementChange', { detail: { value: '1' } });
  const updated = stateWithBook();
  updated.manuscriptRevisions![0].draft.chapters![0].content = [{ text: '已经改成新段落。\n' }];
  wx.setStorageSync(ROOM_KEY, updated);
  await call(page, 'savePlacement');
  assert.match(String(page.data.previewNotice), /目标段落已修改/);
  assert.equal(page.data.placementIndex, -1);
  assert.equal((page.data.placementOptions as any[])[1].after.text, '已经改成新段落。');
  assert.equal((await loadRoomStateRemoteFirst()).manuscriptRevisions!.length, 1);
  call(page, 'onPlacementChange', { detail: { value: '1' } });
  await call(page, 'savePlacement');
  assert.match(String(page.data.previewNotice), /位置已保存/);
});

test('插图保存中不能删图、换图、改位置或重画，轮询只更新状态', async context => {
  const env = installWx({}, stateWithBook()); env.setApp(false);
  context.after(() => env.restore());
  let unlock!: () => void;
  let checking = false;
  const images = listWith({ pending: [] }).images.map(image => ({ ...image, moderation: 'pass' as const, quality: 'pass' as const }));
  context.after(withApi({ listStoryImages: async () => {
    if (checking) await new Promise<void>(resolve => { unlock = resolve; });
    return listWith({ images, pending: [] });
  }, removeStoryImage: async () => { assert.fail('保存时不能删除'); }, submitChapterImage: async () => { throw new Error('保存时不能重新出图'); } }));
  const page = instantiate(await pageDefinition('story-images'));
  await call(page, 'refresh');
  call(page, 'previewImage', { currentTarget: { dataset: { url: images[0].url } } });
  checking = true;
  const saving = call(page, 'savePlacement');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.savingPlacement, true);
  await call(page, 'refresh', true); // A poll cannot supersede the full refresh after saving.
  call(page, 'closePreview');
  call(page, 'previewImage', { currentTarget: { dataset: { url: images[1].url } } });
  call(page, 'onPlacementChange', { detail: { value: '1' } });
  await call(page, 'deletePreview');
  await call(page, 'redrawPreview');
  assert.equal((page.data.preview as any).imageId, images[0].imageId);
  assert.equal(page.data.placementIndex, 0);
  checking = false; unlock(); await saving;
  assert.equal(page.data.savingPlacement, false);
  assert.match(String(page.data.previewNotice), /位置已保存/);
});

test('封面大图跟随选用结果更新，关闭发送 null 且选用期间不能换图', async context => {
  const env = installWx(); context.after(() => env.restore());
  const page = instantiate(await pageDefinition('story-cover'));
  const first = { ...listWith().images[0], purpose: 'cover', ready: true, selected: false };
  page.setData({ covers: [first] });
  call(page, 'preview', { currentTarget: { dataset: { url: first.url } } });
  assert.equal((page.data.previewCover as any).imageId, first.imageId);
  page.setData({ selecting: true });
  call(page, 'preview', { currentTarget: { dataset: { url: 'missing' } } });
  call(page, 'closePreview');
  assert.equal((page.data.previewCover as any).imageId, first.imageId);
  page.setData({ selecting: false });
  call(page, 'closePreview');
  assert.equal(page.data.previewCover, null);
});
