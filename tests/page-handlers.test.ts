import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import {
  appendAiRevision,
  memoryAiRevisions,
  memoryOriginalSpokenText,
  createContribution,
  FamilyRoomState,
} from "../miniprogram/domain/biography";
import { makeRevision } from "../miniprogram/services/manuscript";
import { storyImageApi } from "../miniprogram/services/storyImageService";
import { storySharing } from "../miniprogram/services/storySharing";
import { createDemoRoomStateForTests as createInitialRoomState } from "./fixtures";

const ROOM_KEY = "shiguang-family-room-v5";
const CURRENT_MEMBER_KEY = "shiguang-current-member-v1";

interface TestPageDefinition {
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

interface TestPageInstance extends TestPageDefinition {
  data: Record<string, unknown>;
  setData(update: Record<string, unknown>): void;
}

const definitions = new Map<string, TestPageDefinition>();

async function pageDefinition(name: "index" | "interview" | "room" | "book" | "profiles" | "archive" | "me" | "stories" | "recall" | "invite" | "personal-memory"): Promise<TestPageDefinition> {
  const cached = definitions.get(name);
  if (cached) return cached;

  const previous = Object.getOwnPropertyDescriptor(globalThis, "Page");
  let captured: TestPageDefinition | undefined;
  Object.defineProperty(globalThis, "Page", {
    configurable: true,
    writable: true,
    value: (definition: TestPageDefinition) => {
      captured = definition;
    },
  });

  try {
    if (name === "personal-memory") {
      await import("../miniprogram/pages/personal-memory/personal-memory");
    } else if (name === "index") {
      await import("../miniprogram/pages/index/index");
    } else if (name === "interview") {
      await import("../miniprogram/pages/interview/interview");
    } else if (name === "room") {
      await import("../miniprogram/pages/room/room");
    } else if (name === "book") {
      await import("../miniprogram/pages/book/book");
    } else if (name === "profiles") {
      await import("../miniprogram/pages/profiles/profiles");
    } else if (name === "archive") {
      await import("../miniprogram/pages/archive/archive");
    } else if (name === "stories") {
      await import("../miniprogram/pages/stories/stories");
    } else if (name === "recall") {
      await import("../miniprogram/pages/recall/recall");
    } else if (name === "invite") {
      await import("../miniprogram/pages/invite/invite");
    } else {
      await import("../miniprogram/pages/me/me");
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "Page", previous);
    else delete (globalThis as Record<string, unknown>).Page;
  }

  assert.ok(captured);
  definitions.set(name, captured);
  return captured;
}

function instantiate(definition: TestPageDefinition): TestPageInstance {
  const instance = {
    ...definition,
    data: structuredClone(definition.data ?? {}),
  } as TestPageInstance;
  instance.setData = (update) => Object.assign(instance.data, update);
  return instance;
}

function callPage(
  page: TestPageInstance,
  methodName: string,
  ...args: unknown[]
): unknown {
  const method = page[methodName];
  assert.equal(typeof method, "function", `missing Page method ${methodName}`);
  return (method as (...methodArgs: unknown[]) => unknown).apply(page, args);
}

function installWxMock(initialState: FamilyRoomState, currentMemberId = "owner") {
  const stored = new Map<string, unknown>([
    [ROOM_KEY, initialState],
    [CURRENT_MEMBER_KEY, currentMemberId],
  ]);
  const toasts: string[] = [];
  const navigations: string[] = [];
  const relaunches: string[] = [];
  let backCount = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "wx");

  Object.defineProperty(globalThis, "wx", {
    configurable: true,
    writable: true,
    value: {
      getStorageSync: (key: string) => stored.get(key),
      setStorageSync: (key: string, value: unknown) => stored.set(key, value),
      enableAlertBeforeUnload: () => undefined,
      disableAlertBeforeUnload: () => undefined,
      showToast: ({ title }: { title: string }) => toasts.push(title),
      showModal: ({ success }: { success?: (result: { confirm: boolean; cancel: boolean }) => void }) =>
        success?.({ confirm: true, cancel: false }),
      showActionSheet: ({ success }: { success?: (result: { tapIndex: number }) => void }) => success?.({ tapIndex: 0 }),
      navigateBack: () => {
        backCount += 1;
      },
      navigateTo: ({ url }: { url: string }) => navigations.push(url),
      redirectTo: ({ url }: { url: string }) => navigations.push(url),
      switchTab: () => undefined,
      reLaunch: ({ url }: { url: string }) => relaunches.push(url),
    },
  });

  return {
    currentMemberId: () => stored.get(CURRENT_MEMBER_KEY),
    currentStoryTitle: () => (stored.get("shiguang-current-story-v1") as { title?: string } | undefined)?.title,
    roomState: () => stored.get(ROOM_KEY) as FamilyRoomState,
    toasts,
    navigations,
    relaunches,
    backCount: () => backCount,
    restore: () => {
      if (previous) Object.defineProperty(globalThis, "wx", previous);
      else delete (globalThis as Record<string, unknown>).wx;
    },
  };
}

async function withImmediateTimeouts(action: () => unknown | Promise<unknown>): Promise<void> {
  const previous = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    callback();
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    await action();
  } finally {
    globalThis.setTimeout = previous;
  }
}

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

test("every registered page enables WeChat friend sharing without exposing story text", () => {
  const app = JSON.parse(readFileSync("miniprogram/app.json", "utf8")) as { pages: string[] };
  app.pages.forEach((pagePath) => {
    const source = readFileSync(`miniprogram/${pagePath}.ts`, "utf8");
    assert.match(source, /onShareAppMessage\s*\(/, `${pagePath} must implement onShareAppMessage`);
    if (pagePath !== "pages/invite/invite") {
      assert.match(source, /path:\s*["']\/pages\/index\/index["']/, `${pagePath} must share the safe home path`);
    }
  });
});

test("the invitation poster draws packaged assets and exports a scannable-size code", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const drawImages: unknown[][] = [];
  const canvas = {
    setFillStyle: () => undefined,
    fillRect: () => undefined,
    drawImage: (...args: unknown[]) => drawImages.push(args),
    setGlobalAlpha: () => undefined,
    setStrokeStyle: () => undefined,
    setLineWidth: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    quadraticCurveTo: () => undefined,
    lineTo: () => undefined,
    closePath: () => undefined,
    fill: () => undefined,
    stroke: () => undefined,
    setTextAlign: () => undefined,
    setFontSize: () => undefined,
    fillText: () => undefined,
    arc: () => undefined,
    draw: (_reserve: boolean, callback: () => void) => callback(),
  };
  let exportOptions: Record<string, unknown> | undefined;
  Object.assign(wx as any, {
    createCanvasContext: () => canvas,
    canvasToTempFilePath: (options: Record<string, unknown> & { success: (result: { tempFilePath: string }) => void }) => {
      exportOptions = options;
      options.success({ tempFilePath: "/tmp/invite.jpg" });
    },
  });
  const page = instantiate(await pageDefinition("invite"));
  const result = await callPage(page, "drawPoster", {
    token: "token", inviterName: "岱", inviteeName: "如", relation: "胎教朋友",
    roomName: "我的拾光房间", familyId: "family", memberId: "member",
    status: "pending", acceptedByMe: false, expiresAt: "2026-09-20T00:00:00.000Z",
  }, "/tmp/code.png");

  assert.equal(result, "/tmp/invite.jpg");
  const packaged = drawImages.map(args => String(args[0])).filter(path => path.startsWith("/assets/"));
  packaged.forEach(path => assert.ok(existsSync("miniprogram" + path), `missing poster asset ${path}`));
  assert.ok(drawImages.some(args => args[0] === "/tmp/code.png" && args[3] === 260 && args[4] === 260));
  assert.equal(exportOptions?.fileType, "jpg");
  assert.equal(exportOptions?.quality, 0.95);
});

test("an invitation poster can be saved to the photo album after it is rendered", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const saved: string[] = [];
  Object.assign(wx as any, {
    saveImageToPhotosAlbum: ({ filePath, success }: { filePath: string; success: () => void }) => {
      saved.push(filePath); success();
    },
  });
  const page = instantiate(await pageDefinition("invite"));
  page.setData({ posterPath: "/tmp/invite.jpg" });
  await callPage(page, "savePoster");
  assert.deepEqual(saved, ["/tmp/invite.jpg"]);
  assert.equal(page.data.albumSaving, false);
  assert.deepEqual(storage.toasts, ["已保存到相册"]);
});

test("an invited WeChat member enters only the shared family room", async (context) => {
  const sharedState = createInitialRoomState();
  const storage = installWxMock(sharedState, "owner");
  context.after(storage.restore);
  const wxMock = wx as any;
  wxMock.cloud = {
    callFunction: async ({ name, data }: any) => {
      assert.equal(name, "familyInvite");
      assert.equal(data.action, "loadRoom");
      assert.equal(data.familyId, "family-shared");
      return { result: { familyId: "family-shared", viewerMemberId: "member-1", viewerRole: "contributor", state: sharedState } };
    },
  };

  const room = instantiate(await pageDefinition("room"));
  callPage(room, "onLoad", { familyId: encodeURIComponent("family-shared") });
  await callPage(room, "refresh");
  assert.equal(room.data.viewerId, "member-1");
  assert.equal(room.data.canInvite, false);
  callPage(room, "startInterview");
  assert.equal(last(storage.navigations), "/pages/interview/interview?familyId=family-shared");
});

test("a shared-room interview submits a pending family story as the invited member", async (context) => {
  const sharedState = createInitialRoomState();
  const storage = installWxMock(sharedState, "owner");
  context.after(storage.restore);
  let submitted: ReturnType<typeof createContribution> | undefined;
  const wxMock = wx as any;
  wxMock.cloud = {
    callFunction: async ({ name, data }: any) => {
      assert.equal(name, "familyInvite");
      if (data.action === "loadRoom") {
        return { result: { familyId: "family-shared", viewerMemberId: "member-1", viewerRole: "contributor", state: sharedState } };
      }
      assert.equal(data.action, "submitContribution");
      submitted = data.contribution;
      return { result: { ok: true, contributionId: submitted?.id, reviewStatus: "pending" } };
    },
  };

  const interview = instantiate(await pageDefinition("interview"));
  await callPage(interview, "onLoad", { familyId: "family-shared", memoryType: "note" });
  interview.setData({ stage: "save", answers: ["妈妈以前总在窗边等我回家。"], draftText: "妈妈以前总在窗边等我回家。", draftTitle: "窗边的灯", storyTitle: "回家的路" });
  await callPage(interview, "save");
  assert.equal(submitted?.authorMemberId, "member-1");
  assert.equal(submitted?.scope, "family");
  assert.equal(interview.data.saved, true);
  assert.match(String(interview.data.saveMessage), /主人确认/);
});

test("one interview can stay a fragment or join a named story with independent people and readers", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const definition = await pageDefinition("interview");
  const page = instantiate(definition);
  await callPage(page, "onLoad");

  page.setData({
    stage: "save",
    answers: ["今天忽然很想念小时候放学回家的路。"],
    draftText: "今天忽然很想念小时候放学回家的路。",
    draftTitle: "放学回家的路",
    storyTitle: "外公接我放学",
    relatedMemberIds: ["elder", "member-1"],
    audienceMemberIds: ["elder", "member-2"],
  });
  await withImmediateTimeouts(() => callPage(page, "save"));

  const savedPersonal = last(storage.roomState().contributions);
  assert.equal(savedPersonal?.scope, "personal");
  assert.equal(savedPersonal?.authorMemberId, "owner");
  assert.equal(savedPersonal?.storyTitle, "外公接我放学");
  assert.deepEqual(savedPersonal?.relatedMemberIds, ["elder", "member-1"]);
  assert.deepEqual(savedPersonal?.sharedWithMemberIds, ["elder", "member-2"]);
  const countAfterFirstSave = storage.roomState().contributions.length;
  await callPage(page, "save");
  assert.equal(storage.roomState().contributions.length, countAfterFirstSave);

  const fragmentPage = instantiate(definition);
  await callPage(fragmentPage, "onLoad");
  fragmentPage.setData({
    stage: "save",
    answers: ["只是突然想到一句话，还不知道属于哪个故事。"],
    draftText: "只是突然想到一句话，还不知道属于哪个故事。",
    draftTitle: "突然想到一句话",
    storyTitle: "",
    relatedMemberIds: [],
    audienceMemberIds: [],
  });
  await withImmediateTimeouts(() => callPage(fragmentPage, "save"));

  const savedFragment = last(storage.roomState().contributions);
  assert.equal(savedFragment?.scope, "personal");
  assert.equal(savedFragment?.storyTitle, undefined);
  assert.equal(savedFragment?.relatedMemberIds, undefined);
  assert.equal(savedFragment?.sharedWithMemberIds, undefined);
  assert.equal(savedFragment?.reviewStatus, "confirmed");
});

test("a story in recently deleted is not offered again while saving a new memory", async (context) => {
  const initial = createInitialRoomState();
  initial.deletedStories = [{
    key: "story:外公接我放学",
    title: "外公接我放学",
    deletedAt: "2026-09-13T00:00:00.000Z",
  }];
  const storage = installWxMock(initial);
  context.after(storage.restore);

  const interview = instantiate(await pageDefinition("interview"));
  await callPage(interview, "onLoad");

  assert.ok(!(interview.data.storyOptions as Array<{ title: string }>).some(option => option.title === "外公接我放学"));
});

test("a save with an uncertain acknowledgement retries the same record without unload duplicates", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad");
  page.setData({ stage: "save", draftText: "测试保存回执丢失。", answers: ["测试保存回执丢失。"] });
  const before = storage.roomState().contributions.length;
  const originalSet = wx.setStorageSync;
  wx.setStorageSync = (key, value) => {
    originalSet(key, value);
    if (key === ROOM_KEY) throw new Error("测试回执中断");
  };
  await callPage(page, "save");
  assert.equal(page.data.saved, false);
  wx.setStorageSync = originalSet;
  await callPage(page, "save");
  assert.equal(page.data.saved, true);
  assert.equal(storage.roomState().contributions.length, before + 1);
  callPage(page, "onUnload");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(storage.roomState().contributions.length, before + 1);
});

test("continuing a recent story opens the interview with its existing context", async (context) => {
  const initial = createInitialRoomState();
  const storage = installWxMock(initial);
  context.after(storage.restore);

  const home = instantiate(await pageDefinition("index"));
  await callPage(home, "refresh", initial);
  const story = (home.data.recentStories as Array<{
    id: string;
    storyTitle: string;
  }>)[0];
  assert.ok(story);

  callPage(home, "continueStory", {
    currentTarget: { dataset: { id: story.id, title: story.storyTitle } },
  });
  const url = last(storage.navigations);
  assert.ok(url);
  assert.match(url, /sourceId=demo-personal-rain/);
  assert.match(url, /storyTitle=/);

  const interview = instantiate(await pageDefinition("interview"));
  const query = new URLSearchParams(url.split("?")[1]);
  await callPage(interview, "onLoad", {
    sourceId: query.get("sourceId") ?? "",
    storyTitle: query.get("storyTitle") ?? "",
  });
  assert.equal(interview.data.stage, "chat");
  assert.equal(interview.data.storyTitle, "外公接我放学");
  assert.match(
    (interview.data.messages as Array<{ text: string }>)[0]?.text ?? "",
    /继续聊「外公接我放学」/,
  );
});

test("a new conversation chooses a telling style before chat", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);

  const interview = instantiate(await pageDefinition("interview"));
  await callPage(interview, "onLoad");
  assert.equal(interview.data.stage, "choose");
  assert.equal(interview.data.memoryType, "note");

  callPage(interview, "chooseType", {
    currentTarget: { dataset: { type: "memoir" } },
  });
  assert.equal(interview.data.memoryType, "memoir");

  callPage(interview, "beginInterview");
  assert.equal(interview.data.stage, "chat");

  const selectedInterview = instantiate(await pageDefinition("interview"));
  await callPage(selectedInterview, "onLoad", { memoryType: "memoir" });
  assert.equal(selectedInterview.data.stage, "chat");
  assert.equal(selectedInterview.data.memoryType, "memoir");
});

test("each content branch exits back home", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);

  const book = instantiate(await pageDefinition("book"));
  callPage(book, "goHome");
  const room = instantiate(await pageDefinition("room"));
  callPage(room, "goHome");
  assert.deepEqual(storage.relaunches, [
    "/pages/index/index",
    "/pages/index/index",
  ]);
});

test("interview rejects related people or readers removed before save", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const definition = await pageDefinition("interview");
  const page = instantiate(definition);
  await callPage(page, "onLoad");

  const beforeCount = storage.roomState().contributions.length;
  page.setData({
    stage: "save",
    answers: ["这段不能分享给已经离开空间的成员。"],
    draftText: "这段不能分享给已经离开空间的成员。",
    draftTitle: "权限校验",
    audienceMemberIds: ["removed-member"],
  });
  await callPage(page, "save");

  assert.equal(storage.roomState().contributions.length, beforeCount);
  assert.equal(page.data.saving, false);
  assert.match(last(storage.toasts) ?? "", /选的人有变动/);
});

test("leaving chat preserves unsent text as a private unorganized fragment", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad");

  callPage(page, "onInput", {
    detail: { value: "这句话还没有按发送，但也不应该丢失。" },
  });
  await callPage(page, "saveRecoverableAnswers", ["这句话还没有按发送，但也不应该丢失。"]);

  const saved = last(storage.roomState().contributions);
  assert.equal(saved?.text, "这句话还没有按发送，但也不应该丢失。");
  assert.equal(saved?.scope, "personal");
  assert.equal(saved?.storyTitle, undefined);
  assert.equal(saved?.sharedWithMemberIds, undefined);
});

test("tidying includes text still sitting in the composer", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad");
  page.setData({
    answers: ["我已经发送了第一句话。"],
    inputText: "这一句还在输入框里。",
  });

  await callPage(page, "finish");
  assert.equal(page.data.stage, "save");
  assert.equal(page.data.inputText, "");
  assert.equal(page.data.draftText, "我已经发送了第一句话。 这一句还在输入框里。");
  await withImmediateTimeouts(() => callPage(page, "save"));
  assert.equal(
    last(storage.roomState().contributions)?.text,
    "我已经发送了第一句话。 这一句还在输入框里。",
  );
});

test("returning from organize and continuing chat unloads the newest transcript", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad");
  page.setData({ answers: ["第一段已经讲完。"] });
  await callPage(page, "finish");
  callPage(page, "backToChat");
  page.setData({ inputText: "回到聊天后又想起的一句。" });
  await callPage(page, "saveRecoverableAnswers", ["第一段已经讲完。", "回到聊天后又想起的一句。"]);

  assert.equal(
    last(storage.roomState().contributions)?.text,
    "第一段已经讲完。 回到聊天后又想起的一句。",
  );
});

test("unload splits a long transcript into private fragments without truncation", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad");
  const longText = "光".repeat(620);
  page.setData({ inputText: longText });
  const beforeCount = storage.roomState().contributions.length;
  await callPage(page, "saveRecoverableAnswers", [longText]);

  const saved = storage.roomState().contributions.slice(beforeCount);
  assert.equal(saved.length, 2);
  assert.equal(saved.map((memory) => memory.text).join(""), longText);
  assert.ok(saved.every((memory) => memory.scope === "personal"));
  assert.ok(saved.every((memory) => memory.sharedWithMemberIds === undefined));
});

test("unload never cuts an emoji into invalid surrogate fragments", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad");
  const longText = `${"光".repeat(499)}🌧️雨天`;
  page.setData({ inputText: longText });
  const beforeCount = storage.roomState().contributions.length;
  await callPage(page, "saveRecoverableAnswers", [longText]);

  const saved = storage.roomState().contributions.slice(beforeCount);
  assert.equal(saved.map((memory) => memory.text).join(""), longText);
  assert.ok(saved.every((memory) => memory.text.length <= 500));
  assert.ok(saved.every((memory) => !/[\uD800-\uDFFF]/u.test(
    memory.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ""),
  )));
});

test("unload preserves a normalized space that lands on a fragment boundary", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad");
  const longText = `${"光".repeat(499)} 雨天`;
  page.setData({ inputText: longText });
  const beforeCount = storage.roomState().contributions.length;
  await callPage(page, "saveRecoverableAnswers", [longText]);

  const saved = storage.roomState().contributions.slice(beforeCount);
  assert.equal(saved.map((memory) => memory.text).join(""), longText);
  assert.equal(saved[0]?.text.endsWith(" "), true);
});

test("malformed cached story names do not block the home or interview", async (context) => {
  const initial = createInitialRoomState();
  const corrupted = {
    ...initial,
    contributions: initial.contributions.map((memory, index) =>
      index === 0
        ? { ...memory, storyTitle: { broken: true } }
        : memory,
    ),
  } as unknown as FamilyRoomState;
  const storage = installWxMock(corrupted);
  context.after(storage.restore);

  const interview = instantiate(await pageDefinition("interview"));
  await assert.doesNotReject(async () => callPage(interview, "onLoad"));
  const home = instantiate(await pageDefinition("index"));
  await assert.doesNotReject(async () => callPage(home, "refresh", corrupted));
  assert.equal((home.data.recentStories as unknown[]).length, 1);
  assert.equal(
    (home.data.recentStories as Array<{ title: string }>)[0]?.title,
    "还没取名的片段",
  );
});

test("home groups a story into one recent row and keeps the newest excerpt", async (context) => {
  const initial = createInitialRoomState();
  const laterMemory = createContribution({
    id: "demo-personal-rain-later",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "后来我才知道，外公总会提前十分钟出门。",
    storyTitle: "外公接我放学",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-08-28T08:00:00.000Z"),
  });
  const state = {
    ...initial,
    contributions: initial.contributions.concat(laterMemory),
  };
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("index"));
  await callPage(page, "refresh", state);

  const stories = page.data.recentStories as Array<{
    id: string;
    excerpt: string;
    countLabel: string;
  }>;
  assert.equal(stories.length, 1);
  assert.equal(stories[0]?.id, laterMemory.id);
  assert.equal(stories[0]?.excerpt, laterMemory.text);
  assert.equal(stories[0]?.countLabel, "已聊 2 段");
});

test("an incomplete account can browse home and start recording without filling a name", async (context) => {
  const initial = createInitialRoomState();
  initial.contributions = [];
  const storage = installWxMock(initial);
  context.after(storage.restore);
  (wx as any).cloud = {
    callFunction: async () => ({ result: {
      accountLinked: true,
      account: { accountId: "new-account", primaryFamilyId: "new-family", displayName: "", profileComplete: false },
    } }),
  };
  const page = instantiate(await pageDefinition("index"));
  await callPage(page, "refresh", initial);
  assert.notEqual(page.data.accountPromptOpen, true, "first visit must not block browsing with a name prompt");
  assert.equal(page.data.hasRecentStories, false);
  callPage(page, "startInterview");
  assert.equal(last(storage.navigations), "/pages/interview/interview");
  await callPage(page, "refresh", initial);
  assert.notEqual(page.data.accountPromptOpen, true, "returning home must not reopen a profile prompt");

  delete (wx as any).cloud;
  const me = instantiate(await pageDefinition("me"));
  await callPage(me, "refresh", initial);
  assert.equal(me.data.editingAccount, false);
  callPage(me, "editAccountProfile");
  assert.equal(me.data.editingAccount, true);
  callPage(me, "cancelAccountProfile");
  assert.equal(me.data.editingAccount, false);
});

test("home is about the story you are on: the cover is that story, and the avatar is the account owner", async (context) => {
  const initial = createInitialRoomState();
  const ownerStory = initial.contributions.find(
    (memory) => memory.id === "demo-personal-rain",
  );
  assert.ok(ownerStory);
  const memberStory = createContribution({
    id: "member-one-personal",
    authorMemberId: "member-1",
    authorName: "林秋",
    relation: "母亲",
    text: "这是林秋自己亲历的一段故事。",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-08-28T06:00:00.000Z"),
  });
  const state = {
    ...initial,
    contributions: initial.contributions.map((memory) =>
      memory.id === ownerStory.id
        ? { ...memory, sharedWithMemberIds: ["member-1"] }
        : memory,
    ).concat(memberStory),
  };
  const storage = installWxMock(state, "member-1");
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("index"));
  await callPage(page, "refresh", state);

  // Everyone's memories are in one pool, so home shows them all, whoever told them.
  assert.deepEqual(
    (page.data.recentStories as Array<{ id: string }>).map((story) => story.id),
    [memberStory.id, ownerStory.id],
  );
  // The newest memory is an unfiled one, so the cover shows that, not the whole shelf.
  assert.equal(page.data.coverTitle, "先随便聊聊");
  assert.equal(page.data.coverSubtitle, "还没放进故事的记忆");
  assert.equal(page.data.storyMemoryCount, 1);
  assert.equal(page.data.storyChapterCount, 0);
  assert.equal(page.data.ownerAvatarText, "岚", "the avatar is the owner even when another profile is current");
  assert.equal(storage.currentMemberId(), "member-1", "home never switches profiles");
});

test("switching the story on home changes what it asks next, and a new story opens chat", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("index"));
  const titles = () => (page.data.storyOptions as Array<{ title: string }>).map((option) => option.title);

  await callPage(page, "refresh");
  assert.equal(page.data.currentStoryTitle, "外公接我放学", "starts at the story told most recently");
  assert.equal(page.data.recommendedSourceId, "demo-personal-rain");
  callPage(page, "toggleStoryChooser");
  assert.equal(page.data.storyChooserOpen, true);
  assert.deepEqual(titles(), ["外公接我放学"]);

  await callPage(page, "chooseNoStory");
  assert.equal(page.data.storyChooserOpen, false);
  assert.equal(page.data.currentStoryLabel, "先随便聊聊");
  assert.equal(page.data.hasRecommendedQuestion, false, "no untitled memory to follow up on");
  callPage(page, "startCurrentStory");
  assert.equal(
    last(storage.navigations),
    `/pages/interview/interview?memoryType=memoir&question=${encodeURIComponent(String(page.data.dailyQuestion))}`,
    "the daily question on home is the first thing chat asks",
  );

  callPage(page, "startNewStory");
  assert.equal(last(storage.navigations), "/pages/stories/stories?create=1");

  await callPage(page, "chooseStory", { currentTarget: { dataset: { title: "外公接我放学" } } });
  assert.equal(page.data.recommendedSourceId, "demo-personal-rain");
  assert.deepEqual(titles(), ["外公接我放学"]);
});

test("the home my entry opens the personal home page", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("index"));

  callPage(page, "openMyHome");

  assert.equal(last(storage.navigations), "/pages/me/me");
});

test("the home page recommends a follow-up from the latest memory", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("index"));

  await callPage(page, "refresh");

  assert.equal(page.data.hasRecommendedQuestion, true);
  assert.equal(page.data.recommendedSourceId, "demo-personal-rain");
  assert.match(String(page.data.recommendedQuestionContext), /^关于/);
  assert.ok(String(page.data.recommendedQuestionContext).length <= 21);
  assert.match(String(page.data.recommendedQuestion), /[？?]$/);

  callPage(page, "continueRecommendedQuestion");

  const url = last(storage.navigations);
  assert.ok(url);
  const query = new URLSearchParams(url.split("?")[1]);
  assert.equal(query.get("sourceId"), "demo-personal-rain");
  assert.equal(query.get("storyTitle"), String(page.data.recommendedStoryTitle));
  assert.equal(query.get("question"), String(page.data.recommendedQuestion));

  // 点推荐问进来：不先闪一下「选择讲述方式」，小忆第一句就是刚才点的那个问题。
  const interview = instantiate(await pageDefinition("interview"));
  assert.equal(interview.data.stage, "loading");
  await callPage(interview, "onLoad", {
    sourceId: query.get("sourceId") ?? "",
    storyTitle: query.get("storyTitle") ?? "",
    question: query.get("question") ?? "",
    dimension: query.get("dimension") ?? "",
  });
  assert.equal(interview.data.stage, "chat");
  const opening = (interview.data.messages as Array<{ text: string }>)[0]?.text ?? "";
  assert.ok(opening.endsWith(String(page.data.recommendedQuestion)), opening);
  assert.deepEqual(interview.data.askedDimensions, [query.get("dimension")]);
});

test("a recommended question from a quick note opens chat with that exact question", async (context) => {
  const initial = createInitialRoomState();
  const note = createContribution({
    id: "quick-note-dress",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "我喜欢和一样喜欢漂亮衣服的小姑娘在一起。当然有啦。 已经是很小的时候的事情了 学校。",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-09-11T08:00:00.000Z"),
  });
  const storage = installWxMock({
    ...initial,
    contributions: initial.contributions.concat(note),
  });
  context.after(storage.restore);

  const home = instantiate(await pageDefinition("index"));
  await callPage(home, "refresh");
  assert.equal(home.data.recommendedSourceId, "quick-note-dress");
  const question = String(home.data.recommendedQuestion);
  assert.doesNotMatch(question, /哪一年|多大/, "已经说过“很小的时候”，不该再问时间");

  callPage(home, "continueRecommendedQuestion");
  const url = last(storage.navigations);
  assert.ok(url);
  // 真机上 onLoad 拿到的可能还是编码过的原始值，这里不先解码。
  const rawOptions = Object.fromEntries(
    url.split("?")[1].split("&").map((pair) => pair.split("=") as [string, string]),
  );

  const interview = instantiate(await pageDefinition("interview"));
  await callPage(interview, "onLoad", rawOptions);
  assert.equal(interview.data.stage, "chat");
  const opening = (interview.data.messages as Array<{ text: string }>)[0]?.text ?? "";
  assert.ok(opening.endsWith(question), opening);
});

test("the personal home page summarizes the active profile", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("me"));

  await callPage(page, "refresh");

  assert.equal(page.data.memberName, "林岚");
  assert.equal(page.data.memoryCount, 1);
  assert.equal(page.data.familyCount, 2);
});

test("聊天页导入长文字文件，按顺序分段但只保存成一条未归类记忆", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const wxMock = (globalThis as unknown as { wx: Record<string, unknown> }).wx;
  wxMock.showLoading = () => undefined;
  wxMock.hideLoading = () => undefined;
  wxMock.getFileSystemManager = () => ({
    readFile: ({ success }: { success: (result: { data: string }) => void }) => success({
      data: `第一自然段。\n${"很久以前的往事".repeat(80)}。`,
    }),
  });
  const page = instantiate(await pageDefinition("interview"));

  await callPage(page, "saveImportedFiles", [{ name: "外婆的故事.txt", path: "wxfile://memory.txt", size: 800 }]);

  const imported = last(storage.roomState().contributions);
  assert.equal(imported?.title, "外婆的故事");
  assert.equal(imported?.storyTitle, undefined);
  assert.equal(imported?.scope, "personal");
  assert.ok((imported?.segments?.length || 0) > 1);
  assert.ok(imported?.segments?.every(segment => segment.source === "import" && Array.from(segment.text).length <= 500));
  assert.equal(page.data.saved, false, "导入不应结束或覆盖正在进行的聊天");
  assert.equal(page.data.importing, false);

  const wxml = readFileSync("miniprogram/pages/interview/interview.wxml", "utf8");
  assert.match(wxml, /bindtap="importMemory"/);
  assert.doesNotMatch(wxml, /照片 · 赛后接入|语音 · 赛后接入/);
});

test("聊天页导入照片时可以跳过写字，原图留在本机并进入云上传队列", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const wxMock = (globalThis as unknown as { wx: Record<string, unknown> }).wx;
  wxMock.env = { USER_DATA_PATH: "/user" };
  wxMock.showLoading = () => undefined;
  wxMock.hideLoading = () => undefined;
  wxMock.getFileSystemManager = () => ({
    saveFile: ({ filePath, success }: { filePath: string; success: (result: { savedFilePath: string }) => void }) =>
      success({ savedFilePath: filePath }),
    accessSync: () => undefined,
  });
  const page = instantiate(await pageDefinition("interview"));

  await callPage(page, "saveImportedFiles", [{ name: "合影.jpg", path: "wxfile://photo.jpg", size: 1200, type: "image" }]);
  assert.equal(page.data.importDraftOpen, true);
  assert.equal((page.data.importPhotoPaths as string[])[0].startsWith("/user/photo-"), true);
  await callPage(page, "savePhotoImport");

  const imported = last(storage.roomState().contributions);
  assert.equal(imported?.text, "");
  assert.equal(imported?.photoIds?.length, 1);
  assert.match(imported?.title || "", /^照片 · \d+月\d+日$/);
  const queue = (wxMock.getStorageSync as (key: string) => unknown)("shiguang-photo-upload-queue-v1") as unknown[];
  assert.equal(queue.length, 1);
});

test("照片导入可以取得 AI 草稿，用户改过后以 AI 已修改标识保存", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const previousCaption = storyImageApi.captionPhotos;
  context.after(() => { storyImageApi.captionPhotos = previousCaption; });
  storyImageApi.captionPhotos = async () => ({
    status: "ok", caption: "院子里晒着被子", message: "", aiGenerated: true,
  });
  const wxMock = (globalThis as unknown as { wx: Record<string, unknown> }).wx;
  wxMock.showLoading = () => undefined;
  wxMock.hideLoading = () => undefined;
  const page = instantiate(await pageDefinition("interview"));
  page.setData({ importDraftOpen: true, importPhotoIds: ["photo-test-ai"], importPhotoPaths: ["/user/test.jpg"] });

  await callPage(page, "generateImportCaption");
  assert.equal(page.data.importCaption, "院子里晒着被子");
  assert.equal(page.data.importAiLabel, "文字 AI 生成");
  callPage(page, "onImportCaptionInput", { detail: { value: "院子里晒着外婆洗好的被子" } });
  assert.equal(page.data.importAiLabel, "文字 AI 生成 · 已由你修改");
  await callPage(page, "savePhotoImport");

  const imported = last(storage.roomState().contributions);
  assert.equal(imported?.text, "院子里晒着外婆洗好的被子");
  assert.equal(imported?.organizationMode, "cloud-ai");
});

test("文字 AI 发布闸门关闭时照片导入页不显示看图写文字入口", async () => {
  const interview = instantiate(await pageDefinition("interview"));
  assert.equal(interview.data.importCaptionAiReady, false, "当前生产配置不能开放照片文字 AI");

  const wxml = readFileSync("miniprogram/pages/interview/interview.wxml", "utf8");
  assert.match(wxml, /wx:if="\{\{importCaptionAiReady\}\}"[^>]*bindtap="generateImportCaption"/);
});

test("the home cover and its three counts are about the story you are on", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("index"));
  await callPage(page, "refresh");

  assert.equal(page.data.coverTitle, "外公接我放学");
  assert.equal(page.data.coverSubtitle, "还没整理成章节");
  assert.equal(page.data.storyMemoryCount, 1, "only this story's memories");
  assert.equal(page.data.storyChapterCount, 0);
  assert.equal(page.data.storyPeopleCount, 0);

  const storyUrl = `/pages/stories/stories?key=${encodeURIComponent("story:外公接我放学")}`;
  await withImmediateTimeouts(() => callPage(page, "openMemoryArchive"));
  assert.equal(page.data.bookOpening, false);
  assert.equal(last(storage.navigations), storyUrl, "the cover opens that story, not the whole shelf");

  callPage(page, "openStoryMemories");
  callPage(page, "openStoryChapters");
  callPage(page, "openPeople");
  assert.deepEqual(storage.navigations.slice(-3), [
    storyUrl,
    storyUrl, // nothing organized yet, so chapters open the story itself
    "/pages/room/room",
  ]);

  // 先随便聊聊: the counts and the taps fall back to the unfiled memories.
  await callPage(page, "chooseNoStory");
  assert.equal(page.data.coverTitle, "先随便聊聊");
  assert.equal(page.data.storyMemoryCount, 0);
  callPage(page, "openStoryMemories");
  assert.equal(last(storage.navigations), "/pages/archive/archive");
});

test("a story with chapters opens them from the cover, for the profile that holds them", async (context) => {
  const initial = createInitialRoomState();
  const state = {
    ...initial,
    manuscriptRevisions: [makeRevision("member-1", {
      title: "林秋的书", paragraphs: ["虚构正文"], sourceCount: 1, generatedAt: "", generationMode: "local-demo",
    }, "", "version", "第一版")],
  };
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("index"));
  await callPage(page, "refresh");
  await callPage(page, "chooseStory", { currentTarget: { dataset: { title: "林秋的书" } } });

  assert.equal(page.data.coverTitle, "林秋的书");
  assert.equal(page.data.coverSubtitle, "已整理 1 章");
  assert.equal(page.data.storyChapterCount, 1);

  callPage(page, "openStoryChapters");
  assert.equal(storage.currentMemberId(), "member-1");
  assert.equal(last(storage.navigations), "/pages/book/book");
});

test("opening 人生之书 with a story key lands on that story", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("stories"));

  callPage(page, "onLoad", { key: encodeURIComponent("story:外公接我放学") });
  await callPage(page, "refresh");

  assert.equal(page.data.selectedTitle, "外公接我放学");
  assert.deepEqual((page.data.memories as Array<{ id: string }>).map((memory) => memory.id), ["demo-personal-rain"]);

  const broken = instantiate(await pageDefinition("stories"));
  callPage(broken, "onLoad", { key: "%E0%A4%A" });
  await callPage(broken, "refresh");
  assert.equal(broken.data.selectedTitle, "", "a broken link just shows every story");
});

test("人生之书 exposes delete and restore controls while keeping original memories", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  (wx as any).setStorageSync("shiguang-current-story-v1", { title: "外公接我放学" });
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("stories"));
  callPage(page, "onLoad", { key: encodeURIComponent("story:外公接我放学") });
  await callPage(page, "refresh");

  await callPage(page, "deleteSelectedStory");
  assert.equal(page.data.selectedKey, "");
  assert.ok(!(page.data.stories as Array<{ key: string }>).some((story) => story.key === "story:外公接我放学"));
  assert.equal(storage.roomState().contributions.some((memory) => memory.id === "demo-personal-rain"), true);
  assert.equal(storage.currentStoryTitle(), "", "home no longer points at the deleted story");
  assert.equal((page.data.deletedStories as Array<{ key: string }>)[0]?.key, "story:外公接我放学");

  const home = instantiate(await pageDefinition("index"));
  await callPage(home, "refresh");
  assert.ok(!(home.data.recentStories as Array<{ title: string }>).some((story) => story.title === "外公接我放学"));

  await callPage(page, "restoreStory", { currentTarget: { dataset: { key: "story:外公接我放学" } } });
  assert.ok((page.data.stories as Array<{ key: string }>).some((story) => story.key === "story:外公接我放学"));
});

test("人生之书 lists every story; a book-only story opens its chapters for that profile", async (context) => {
  const initial = createInitialRoomState();
  const state = {
    ...initial,
    manuscriptRevisions: [makeRevision("member-1", {
      title: "林秋的书", paragraphs: ["虚构正文"], sourceCount: 1, generatedAt: "", generationMode: "local-demo",
    }, "", "version", "第一版")],
  };
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("stories"));
  await callPage(page, "refresh");

  const rows = page.data.stories as Array<{ key: string; title: string; label: string }>;
  assert.deepEqual(rows.map((row) => row.title).sort(), ["外公接我放学", "林秋的书"].sort());
  assert.equal(rows.find((row) => row.key === "manuscript:member-1")?.label, "已整理 1 章");

  await callPage(page, "openStory", { currentTarget: { dataset: { key: "story:外公接我放学" } } });
  assert.equal(page.data.selectedTitle, "外公接我放学");
  assert.deepEqual((page.data.memories as Array<{ id: string }>).map((memory) => memory.id), ["demo-personal-rain"]);
  callPage(page, "continueStory");
  assert.match(String(last(storage.navigations)), new RegExp(`storyTitle=${encodeURIComponent("外公接我放学")}`));

  callPage(page, "backToStories");
  await callPage(page, "openStory", { currentTarget: { dataset: { key: "manuscript:member-1" } } });
  assert.equal(storage.currentMemberId(), "member-1", "the book page still reads the profile it belongs to");
  assert.equal(last(storage.navigations), "/pages/book/book");
  assert.equal(storage.roomState().manuscriptRevisions?.length, 1, "opening the list writes nothing");
});

test("人生之书 creates an empty book or opens selected memories in the new book organizer", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("stories"));
  page.setData({
    createTitle: "雨天的新讲法",
    createMode: "creative",
    createMemories: [{ ...createInitialRoomState().contributions[0], checked: true }],
  });

  await callPage(page, "createBook");
  const created = storage.roomState().stories?.find(story => story.title === "雨天的新讲法");
  assert.ok(created);
  assert.equal(created.writingMode, "creative");
  assert.deepEqual(created.memoryIds, ["demo-personal-rain"]);
  const url = String(last(storage.navigations));
  const query = new URLSearchParams(url.split("?")[1]);
  assert.equal(query.get("storyId"), created.id);
  assert.equal(query.get("memoryIds"), "demo-personal-rain");
});

test("chat always saves under the account owner, whichever book was open last", async (context) => {
  const storage = installWxMock(createInitialRoomState(), "member-1");
  context.after(storage.restore);
  const interview = instantiate(await pageDefinition("interview"));
  await callPage(interview, "onLoad", { storyTitle: "外公接我放学" });

  assert.equal(interview.data.memberName, "林岚");
  assert.ok(!("narratorOptions" in interview.data), "there is no narrator to pick");
  const related = (interview.data.relatedOptions as Array<{ id: string }>).map((option) => option.id);
  assert.ok(!related.includes("owner"));
  assert.ok(related.includes("member-1"), "every other person can be picked, whatever kind of record they were");

  interview.setData({ stage: "save", draftTitle: "测试", draftText: "在这台手机上讲的一段虚构记忆。" });
  await callPage(interview, "save");
  const saved = storage.roomState().contributions.find((memory) => memory.text === "在这台手机上讲的一段虚构记忆。");
  assert.equal(saved?.authorMemberId, "owner");
  assert.equal(saved?.storyTitle, "外公接我放学");
  assert.equal(storage.currentMemberId(), "member-1", "chatting switches nothing else");
});

test("objective story keeps asking local follow-ups when online AI is unavailable", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const previousApp = (globalThis as any).getApp;
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: true } });
  context.after(() => { (globalThis as any).getApp = previousApp; });
  let aiCalls = 0;
  (wx as any).cloud = { callFunction: async () => { aiCalls += 1; throw new Error("AI must not run"); } };
  const page = instantiate(await pageDefinition("interview"));
  page.setData({ inputText: "只记录这句事实。", writingMode: "objective", storyId: "story-a", answers: [], messages: [] });

  await callPage(page, "send");
  assert.equal(aiCalls, 0);
  assert.deepEqual(page.data.answers, ["只记录这句事实。"]);
  assert.equal(page.data.asking, false);
  assert.equal((page.data.messages as Array<{ kind: string }>).filter(message => message.kind === "followup").length, 1);
});

test("daily question keeps guiding the next two answers even in an objective book", async context => {
  const state = createInitialRoomState();
  state.stories = [{ id: "story-daily", familyId: "local", title: "日常", writingMode: "objective", memoryIds: [], protagonistMemberIds: [], createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z", version: 0 }];
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad", { storyId: "story-daily", question: "最近哪个小瞬间让你放松下来？" });
  const previousApp = (globalThis as any).getApp;
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: true, aiReady: true } });
  context.after(() => { (globalThis as any).getApp = previousApp; });
  const calls: any[] = [];
  (wx as any).cloud = { callFunction: async ({ name, data }: any) => {
    if (name === "recordAiConsent") return { result: { success: true } };
    assert.equal(name, "chatInterview"); calls.push(data);
    return { result: { dimension: "feeling", text: calls.length === 1 ? "阳台上的哪一点让你放松？" : "这份自在和以前有什么不同？" } };
  } };
  page.setData({ inputText: "傍晚坐在阳台上，终于能歇一会儿。" });
  await callPage(page, "send");
  page.setData({ inputText: "我不用赶着去做下一件事。" });
  await callPage(page, "send");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !call.storyId), "objective book text is not used for AI rewriting");
  assert.ok(calls[1].conversation.some((turn: any) => turn.text === "阳台上的哪一点让你放松？"));
  assert.equal((page.data.messages as any[]).filter(message => message.kind === "followup").length, 2);
  assert.equal(page.data.writingMode, "objective");
});

test("continue chatting in an objective book keeps all three turns without modifying the book", async context => {
  const state = createInitialRoomState();
  state.stories = [{ id: "story-daily", familyId: "local", title: "日常", writingMode: "objective", memoryIds: [], protagonistMemberIds: [], createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z", version: 0 }];
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad", { storyId: "story-daily" });
  const previousApp = (globalThis as any).getApp;
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: true, aiReady: true } });
  context.after(() => { (globalThis as any).getApp = previousApp; });
  const calls: any[] = [];
  (wx as any).cloud = { callFunction: async ({ name, data }: any) => {
    if (name === "recordAiConsent") return { result: { success: true } };
    assert.equal(name, "chatInterview"); calls.push(data);
    return { result: { dimension: "feeling", text: calls.length === 1 ? "阳台上的哪一点让你放松？" : "这份自在和以前有什么不同？" } };
  } };
  page.setData({ inputText: "傍晚坐在阳台上，终于能歇一会儿。" });
  await callPage(page, "send");
  page.setData({ inputText: "我不用赶着去做下一件事。" });
  await callPage(page, "send");
  page.setData({ inputText: "我想给自己留一点慢下来的时间。" });
  await callPage(page, "send");
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !call.storyId), "objective book text is not used for AI rewriting");
  assert.ok(calls[1].conversation.some((turn: any) => turn.text === "阳台上的哪一点让你放松？"));
  assert.equal((page.data.messages as any[]).filter(message => message.kind === "followup").length, 3);
  assert.equal(page.data.writingMode, "objective");
  assert.equal(page.data.asking, false);
  assert.equal(calls[2].previousAnswers.length, 2);
  assert.equal(calls[2].conversation.filter((turn: any) => turn.role === "user").length, 2);
  assert.deepEqual(storage.roomState(), state, "chatting must not rewrite or save the existing book");
});

test("organizing an unlinked memory survives choosing an empty story and writes only after preview confirmation", async context => {
  const state = createInitialRoomState();
  state.storyMigration = { version: 1, status: "active", pending: [] };
  state.stories = ["a", "b"].map(id => ({ id: `story-${id}`, familyId: "local", title: id === "a" ? "旧篇" : "新篇", writingMode: "objective" as const, memoryIds: id === "a" ? ["demo-personal-rain"] : [], protagonistMemberIds: [], createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z", version: 0 }));
  state.contributions.push(createContribution({ id: "new-fragment", authorMemberId: "owner", authorName: "林岚", relation: "自己", text: "我在阳台上坐了一会儿，终于不用赶时间。", scope: "personal", visibility: "private" }));
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  page.requestedStoryKey = "story-a";
  page.requestedMemoryIds = ["new-fragment"];
  page.openOrganizeOnLoad = true;
  await callPage(page, "refresh");
  assert.equal(page.data.panel, "organize");
  assert.deepEqual(page.organizeSelection, ["new-fragment"]);
  await callPage(page, "onOrganizeBook", { detail: { value: "story-b" } });
  assert.equal(page.data.storyId, "story-b");
  assert.equal(page.data.organizeBookKey, "story-b");
  assert.equal(page.data.panel, "organize");
  assert.deepEqual(page.organizeSelection, ["new-fragment"]);
  assert.deepEqual((page.data.organizeRows as any[]).filter(row => row.checked).map(row => row.id), ["new-fragment"]);
  assert.equal(storage.roomState().manuscriptRevisions, undefined);
  await callPage(page, "runOrganize");
  assert.equal(page.data.panel, "organize-preview", String(page.data.saveNotice));
  assert.match(String(page.data.previewText), /阳台/);
  assert.equal(storage.roomState().manuscriptRevisions, undefined, "preview never writes chapter text");
  await callPage(page, "confirmOrganize");
  assert.equal(page.data.panel, "", String(page.data.saveNotice));
  const saved = storage.roomState();
  const revision = saved.manuscriptRevisions?.find(item => item.storyId === "story-b");
  assert.deepEqual(revision?.draft.chapters?.[0].memoryIds, ["new-fragment"]);
  assert.match(JSON.stringify(revision?.draft.chapters?.[0].content), /阳台/);
  assert.deepEqual(saved.stories?.find(story => story.id === "story-a")?.memoryIds, ["demo-personal-rain"]);
  assert.equal(saved.contributions.find(memory => memory.id === "new-fragment")?.text, "我在阳台上坐了一会儿，终于不用赶时间。");
});

test("全部回忆 lists every memory and continues the chat from the one you pick", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("recall"));
  await callPage(page, "refresh");

  const items = page.data.items as Array<{ id: string; title: string; storyLabel: string; storyTitle: string }>;
  assert.deepEqual(items.map((item) => item.id), ["demo-personal-rain"], "family-review posts are not memories to continue");
  assert.equal(items[0].storyLabel, "外公接我放学");

  callPage(page, "continueMemory", { currentTarget: { dataset: { id: items[0].id, title: items[0].storyTitle } } });
  const url = String(last(storage.navigations));
  assert.match(url, /^\/pages\/interview\/interview\?/);
  const query = new URLSearchParams(url.split("?")[1]);
  assert.equal(query.get("sourceId"), "demo-personal-rain");
  assert.equal(query.get("storyTitle"), "外公接我放学");
  assert.equal(query.get("memoryType"), "memoir");
  assert.equal(storage.roomState().contributions.length, createInitialRoomState().contributions.length, "picking one changes nothing");
});

test("全部回忆 uses the current or unique story id and never guesses between several books", async (context) => {
  const state = createInitialRoomState();
  state.storyMigration = { version: 1, status: "active", pending: [] };
  state.stories = [
    { id: "story-rain-a", familyId: "local", title: "雨天 A", bookTitle: "雨天 A", writingMode: "objective", memoryIds: ["demo-personal-rain"], protagonistMemberIds: [], createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z", version: 0, currentRevisionId: "" },
    { id: "story-rain-b", familyId: "local", title: "雨天 B", bookTitle: "雨天 B", writingMode: "creative", memoryIds: ["demo-personal-rain"], protagonistMemberIds: [], createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z", version: 0, currentRevisionId: "" },
  ];
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("recall"));

  await callPage(page, "refresh");
  let item = (page.data.items as Array<{ id: string; storyId: string; needsStoryChoice: boolean }>).find(row => row.id === "demo-personal-rain")!;
  assert.equal(item.needsStoryChoice, true);
  callPage(page, "continueMemory", { currentTarget: { dataset: { id: item.id, title: "外公接我放学", story: "", choice: true } } });
  let query = new URLSearchParams(String(last(storage.navigations)).split("?")[1]);
  assert.equal(query.get("storyId"), "story-rain-a");
  assert.equal(query.get("sourceId"), "demo-personal-rain");

  wx.setStorageSync("shiguang-current-story-id-v1", "story-rain-b");
  await callPage(page, "refresh");
  item = (page.data.items as Array<{ id: string; storyId: string; needsStoryChoice: boolean }>).find(row => row.id === "demo-personal-rain")!;
  assert.equal(item.storyId, "story-rain-b");
  assert.equal(item.needsStoryChoice, false);
  callPage(page, "continueMemory", { currentTarget: { dataset: { id: item.id, title: "外公接我放学", story: item.storyId, choice: false } } });
  query = new URLSearchParams(String(last(storage.navigations)).split("?")[1]);
  assert.equal(query.get("storyId"), "story-rain-b");
  assert.equal(query.get("sourceId"), "demo-personal-rain");
});

test("the memory archive lists quick notes from the shared memory pool", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("archive"));

  await callPage(page, "refresh");

  assert.equal(page.data.memberName, "林岚");
  assert.deepEqual(
    (page.data.notes as Array<{ id: string }>).map((note) => note.id),
    ["demo-personal-rain"],
  );
  assert.equal(page.data.hasNotes, true);
});

test("the memory archive never offers a deleted story while editing a memory", async (context) => {
  const state = createInitialRoomState();
  state.deletedStories = [{
    key: "story:外公接我放学",
    title: "外公接我放学",
    deletedAt: "2026-09-16T00:00:00.000Z",
  }];
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("archive"));

  await callPage(page, "refresh");

  assert.deepEqual(page.data.storyOptions, []);
});

test("the memory archive supports swipe reveal and deleting a quick note", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("archive"));

  await callPage(page, "refresh");
  callPage(page, "onNoteTouchStart", {
    currentTarget: { dataset: { id: "demo-personal-rain" } },
    touches: [{ clientX: 260, clientY: 120 }],
  });
  callPage(page, "onNoteTouchEnd", {
    currentTarget: { dataset: { id: "demo-personal-rain" } },
    changedTouches: [{ clientX: 170, clientY: 124 }],
  });

  assert.equal(page.data.swipedItemId, "demo-personal-rain");

  await callPage(page, "confirmDeleteMemory", "demo-personal-rain");

  assert.ok(
    storage.roomState().contributions.some((memory) => memory.id === "demo-personal-rain" && memory.deletedAt),
    "everyday delete moves the memory into recently deleted instead of erasing it",
  );
  assert.equal(page.data.noteCount, 0);
  assert.equal(page.data.hasItems, false);
  assert.equal(last(storage.toasts), "已放进最近删除");

  const shelf = instantiate(await pageDefinition("stories"));
  await callPage(shelf, "refresh");
  const deleted = shelf.data.deletedItems as Array<{ type: string; id: string }>;
  assert.deepEqual(deleted.map((item) => [item.type, item.id]), [["memory", "demo-personal-rain"]]);
  assert.equal(shelf.data.deletedMemoryCount, 1);
  await callPage(shelf, "restoreItem", { currentTarget: { dataset: { type: "memory", id: "demo-personal-rain" } } });
  assert.equal((shelf.data.deletedItems as unknown[]).length, 0);
  assert.ok(storage.roomState().contributions.some((memory) => memory.id === "demo-personal-rain" && !memory.deletedAt));
});

test("the memory archive retains both telling styles as original records", async (context) => {
  const state = createInitialRoomState();
  state.contributions.push(createContribution({
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "自己",
    text: "我慢慢讲起那年夏天的故事。",
    memoryType: "memoir",
    scope: "personal",
    visibility: "private",
  }));
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("archive"));

  callPage(page, "onLoad", { tab: "memoir" });
  await callPage(page, "refresh", state);

  assert.equal(page.data.activeTab, "memoir");
  assert.equal(page.data.memoirCount, 1);
  assert.equal((page.data.archiveItems as Array<{ text: string }>).length, 2);
});

test("memory edits and story assignment preserve originals and independent readership", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("archive"));
  await callPage(page, "refresh");
  await callPage(page, "openMemory", { currentTarget: { dataset: { id: "demo-personal-rain" } } });
  const original = storage.roomState().contributions.find(item => item.id === "demo-personal-rain")!;
  const count = storage.roomState().contributions.length;
  page.setData({ editTitle: "测试修改", editText: "这是修改后的虚构记忆。", editStory: "新的故事" });
  await callPage(page, "saveEdit");
  assert.equal(storage.roomState().contributions.length, count);
  const updated = storage.roomState().contributions.find(item => item.id === original.id)!;
  assert.equal(updated.storyTitle, "新的故事");
  assert.deepEqual(updated.sharedWithMemberIds, original.sharedWithMemberIds);
  const stories = instantiate(await pageDefinition("stories"));
  await callPage(stories, "refresh");
  assert.ok((stories.data.stories as Array<{ title: string }>).some(item => item.title === "新的故事"));
  page.setData({ editStory: "" });
  await callPage(page, "saveEdit");
  assert.equal(storage.roomState().contributions.find(item => item.id === original.id)?.storyTitle, undefined);
});

test("creating a book and adding a person are separate operations", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const books = instantiate(await pageDefinition("profiles"));
  callPage(books, "onLoad", { mode: "new-book" });
  books.setData({ nameInput: "新的记录档案" });
  await callPage(books, "createBook");
  const profileId = storage.currentMemberId();
  assert.equal(storage.roomState().members.find(item => item.id === profileId)?.kind, "recording-profile");
  const people = instantiate(await pageDefinition("profiles"));
  callPage(people, "onLoad", { mode: "people" });
  people.setData({ nameInput: "测试朋友", relationInput: "朋友" });
  await callPage(people, "addPerson");
  assert.equal(storage.currentMemberId(), profileId);
  const person = storage.roomState().members.find(item => item.name === "测试朋友")!;
  assert.equal(person.kind, "person");
  await callPage(people, "refresh");
  assert.ok((people.data.people as Array<{id: string}>).some(item => item.id === person.id));
  assert.ok(!(people.data.people as Array<{id: string}>).some(item => item.id === profileId), "the author's own book is not a listed person");
  const home = instantiate(await pageDefinition("index"));
  await callPage(home, "refresh");
  assert.ok(!(home.data.storyOptions as Array<{title: string}>).some(item => item.title === person.name), "people are not stories");
});

test("AI organizing starts a book; edits, saved versions and source changes preserve history", async context => {
  const previousApp = (globalThis as any).getApp;
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: false } });
  context.after(() => { (globalThis as any).getApp = previousApp; });
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  callPage(page, "selectTool", { currentTarget: { dataset: { action: "generate" } } });
  assert.equal(page.data.panel, "organize");
  assert.equal(page.data.organizeTarget, "new");
  assert.deepEqual((page.data.organizeRows as any[]).map(row => [row.id, row.checked, row.where]), [["demo-personal-rain", true, "还没放进"]]);
  assert.equal(storage.roomState().manuscriptRevisions, undefined);
  const beforePreview = JSON.stringify(storage.roomState().manuscriptRevisions);
  await callPage(page, "runOrganize");
  assert.equal(page.data.panel, "organize-preview");
  assert.equal(JSON.stringify(storage.roomState().manuscriptRevisions), beforePreview, "preview must not save");
  await callPage(page, "confirmOrganize");
  const organized = page.data.draft as any;
  assert.equal(organized.title, "林岚的人生之书", "the AI never names the book");
  assert.equal(organized.chapters[0].title, "外公接我放学");
  assert.deepEqual(organized.chapters[0].memoryIds, ["demo-personal-rain"]);
  assert.doesNotMatch(JSON.stringify(organized.chapters[0].content), /认真地收在这里|“/, "no template filler or quotes");
  assert.equal(page.data.view, "chapter");
  assert.equal(page.data.panel, "");
  assert.equal(page.data.canUndo, false, "nothing to undo into for a brand-new book");
  const first = (page.data.history as Array<{ id: string }>)[0].id;
  callPage(page, "onEditTitle", { detail: { value: "我亲手改的标题" } });
  callPage(page, "onEditorInput", { detail: { delta: { ops: [{ insert: "我自己改写的正文。" }] }, text: "我自己改写的正文。" } });
  await callPage(page, "saveEdits");
  assert.equal((page.data.draft as { title: string }).title, "我亲手改的标题");
  await callPage(page, "saveVersion");
  assert.ok((page.data.history as Array<{ id: string }>).some(item => item.id === first));
  const count = storage.roomState().manuscriptRevisions!.length;
  const revision = storage.roomState().manuscriptRevisions!.find(item => item.id === first)!;
  await callPage(page, "persist", revision.draft, revision.sourceFingerprint, "restore", "恢复测试版");
  assert.equal(storage.roomState().manuscriptRevisions!.length, count + 1);
  assert.ok(storage.roomState().manuscriptRevisions!.some(item => item.draft.title === "我亲手改的标题"));
  const { appendContribution } = await import("../miniprogram/services/roomStorage");
  appendContribution(createContribution({ authorMemberId: "owner", authorName: "测试者", relation: "自己", text: "新增的虚构记忆。", scope: "personal", visibility: "private" }));
  await callPage(page, "refresh");
  assert.ok(page.data.draft);
  assert.equal(page.data.stale, true);
});

test("book candidates hide memories from deleted stories and include a newly saved fragment", async context => {
  const state = createInitialRoomState();
  state.deletedStories = [{
    key: "story:外公接我放学",
    title: "外公接我放学",
    deletedAt: "2026-09-13T00:00:00.000Z",
  }];
  state.contributions.push(createContribution({
    id: "just-saved",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "自己",
    text: "这是刚刚保存、还没有放进故事的新记忆。",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-09-13T02:39:00.000Z"),
  }));
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));

  await callPage(page, "refresh");

  assert.deepEqual((page.data.unassigned as Array<{ id: string }>).map(item => item.id), ["just-saved"]);
  assert.equal(page.data.sourceCount, 1);
});

test("AI organizing lists every story instead of treating recording profiles as books", async context => {
  const state = createInitialRoomState();
  state.members = state.members.map(member => member.id === "owner"
    ? { ...member, kind: "recording-profile" as const }
    : { ...member, kind: "person" as const });
  state.contributions.push(createContribution({
    id: "another-story",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "自己",
    text: "后来我又想起了第一次离开家去远方的那一天。",
    storyTitle: "第一次去远方",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-09-12T00:00:00.000Z"),
  }));
  state.manuscriptRevisions = [makeRevision("owner", {
    title: "我",
    paragraphs: ["已经整理好的正文。"],
    sourceCount: 1,
    generatedAt: "2026-09-10T00:00:00.000Z",
    generationMode: "local-demo",
  }, "", "draft", "当前稿")];
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));

  await callPage(page, "refresh");
  callPage(page, "showOrganize");

  assert.deepEqual(
    (page.data.organizeBooks as Array<{ title: string }>).map(item => item.title),
    ["我", "第一次去远方", "外公接我放学"],
  );
  const other = (page.data.organizeBooks as Array<{ id: string; title: string; memberId: string }>).find(item => item.title === "第一次去远方")!;
  assert.equal(other.memberId, "owner", "a story without chapters can still be selected in the current life book");

  callPage(page, "onOrganizeMemories", { detail: { value: ["demo-personal-rain"] } });
  await callPage(page, "onOrganizeBook", { detail: { value: other.id } });
  assert.equal(page.data.organizeBookKey, other.id);
  assert.equal(page.data.organizeTarget, "new");
  assert.deepEqual(
    (page.data.organizeRows as Array<{ id: string; checked: boolean }>).filter(item => item.checked).map(item => item.id),
    ["demo-personal-rain"],
    "choosing a destination preserves the memories the user selected",
  );
});

test("choosing a story only shows chapters associated with that story", async context => {
  const state = createInitialRoomState();
  state.contributions.push(createContribution({
    id: "another-story",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "自己",
    text: "第一次离开家去远方。",
    storyTitle: "第一次去远方",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-09-12T00:00:00.000Z"),
  }));
  state.manuscriptRevisions = [makeRevision("owner", {
    title: "林岚的人生之书",
    paragraphs: [],
    sourceCount: 2,
    generatedAt: "2026-09-12T00:00:00.000Z",
    generationMode: "local-demo",
    chapters: [
      { id: "chapter-old", title: "外公接我放学", memoryIds: ["demo-personal-rain"], content: [{ text: "外公的故事。\n" }] },
      { id: "chapter-away", title: "第一次去远方", memoryIds: ["another-story"], content: [{ text: "远方的故事。\n" }] },
    ],
  }, "", "draft", "当前稿")];
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));

  await callPage(page, "refresh");
  const story = (page.data.organizeBooks as Array<{ id: string; title: string }>).find(item => item.title === "第一次去远方")!;
  await callPage(page, "onOrganizeBook", { detail: { value: story.id } });

  assert.deepEqual(
    (page.data.chapterRows as Array<{ id: string }>).map(item => item.id),
    ["chapter-away"],
  );
  assert.deepEqual(
    (page.data.organizeRows as Array<{ id: string }>).map(item => item.id),
    ["demo-personal-rain", "another-story"],
    "source picker offers the whole personal library while chapter targets remain scoped",
  );
});

test("AI organizing a chapter keeps the book title and every photo, and can be undone", async context => {
  const previousApp = (globalThis as any).getApp;
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: false } });
  context.after(() => { (globalThis as any).getApp = previousApp; });
  const state = createInitialRoomState();
  const original = {
    title: "外公和雨天", paragraphs: ["前文", "中段"], sourceCount: 1, generatedAt: "", generationMode: "local-demo" as const,
    content: [{ text: "前文\n" }, { photoId: "photo-first" }, { text: "中段\n" }, { photoId: "photo-second" }],
  };
  state.personalDrafts = { owner: original };
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  callPage(page, "showOrganize");
  assert.equal(page.data.organizeTarget, "chapter-1", "organizing from a chapter targets that chapter");
  callPage(page, "onOrganizeMethod", { detail: { value: "blend" } });
  const beforePreview = JSON.stringify(storage.roomState().manuscriptRevisions);
  await callPage(page, "runOrganize");
  assert.equal(page.data.panel, "organize-preview");
  assert.equal(JSON.stringify(storage.roomState().manuscriptRevisions), beforePreview, "preview must not save");
  await callPage(page, "confirmOrganize");
  const organized = page.data.draft as any;
  assert.equal(organized.title, "外公和雨天");
  const content = organized.chapters[0].content;
  assert.deepEqual(content.filter((item: any) => item.photoId).map((item: any) => item.photoId), ["photo-first", "photo-second"]);
  assert.match(content[0].text, /前文/, "the local fallback keeps the chapter's existing text");
  assert.match(content[0].text, /外公带着两把伞/);
  assert.match(page.data.saveNotice as string, /微信云开发还没连上/);
  assert.match(page.data.saveNotice as string, /2 张照片/);
  assert.equal(page.data.canUndo, true);
  await callPage(page, "undoOrganize");
  assert.deepEqual((page.data.draft as any).content, original.content, "undo restores the book as it was");
  assert.equal(page.data.canUndo, false);
  const revisions = storage.roomState().manuscriptRevisions!;
  assert.ok(revisions.some(item => item.label === "AI 整理第一章"), "the organized version stays in history");
  assert.deepEqual(revisions.find(item => item.id === "legacy-owner")!.draft, original);
});

test("chapters: an older book becomes chapter one and chapter changes leave other chapters untouched", async context => {
  const state = createInitialRoomState();
  const original = { title: "外公和雨天", paragraphs: ["原文"], content: [{ text: "原文\n" }, { photoId: "photo-keep" }], sourceCount: 1, generatedAt: "", generationMode: "local-demo" as const };
  state.personalDrafts = { owner: original };
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  assert.equal(page.data.view, "chapter", "a single-chapter book opens straight into its text");
  assert.equal(page.data.chapterLabelText, "第一章");
  assert.deepEqual((page.data.unassigned as any[]).map(item => item.id), ["demo-personal-rain"]);
  callPage(page, "onBack");
  assert.equal(page.data.view, "contents");

  await callPage(page, "createChapter", { currentTarget: { dataset: { story: "外公接我放学" } } });
  let draft = page.data.draft as any;
  assert.equal(draft.chapters.length, 2);
  assert.equal(page.data.view, "chapter");
  assert.equal(page.data.chapterLabelText, "第二章");
  assert.deepEqual(draft.chapters[1].memoryIds, ["demo-personal-rain"]);
  assert.match(draft.chapters[1].content.map((item: any) => item.text || "").join(""), /我小时候最喜欢下雨天/,
    "starting a chapter from a story also writes its memory into the chapter body");
  assert.equal((page.data.unassigned as any[]).length, 0);
  const firstChapter = structuredClone(draft.chapters[0]);
  assert.ok(firstChapter.content.some((item: any) => item.photoId === "photo-keep"));

  callPage(page, "onEditChapterTitle", { detail: { value: "雨天的巷口" } });
  callPage(page, "onEditorInput", { detail: { delta: { ops: [{ insert: "新的一章正文\n" }] }, text: "新的一章正文\n" } });
  await callPage(page, "saveEdits");
  draft = page.data.draft as any;
  assert.equal(draft.title, "外公和雨天", "the book title is separate from chapter titles");
  assert.equal(draft.chapters[1].title, "雨天的巷口");
  assert.equal(draft.chapters[1].handEdited, true);
  assert.deepEqual(draft.chapters[0], firstChapter, "editing chapter two leaves chapter one and its photo untouched");
  assert.equal(draft.paragraphs[0], "第一章");

  await callPage(page, "removeFromChapter", { currentTarget: { dataset: { id: "demo-personal-rain" } } });
  await callPage(page, "addToChapter", { currentTarget: { dataset: { id: "demo-personal-rain" } } });
  draft = page.data.draft as any;
  assert.deepEqual(draft.chapters[1].memoryIds, ["demo-personal-rain"]);
  assert.match(draft.chapters[1].content.map((item: any) => item.text || "").join(""), /新的一章正文[\s\S]*我小时候最喜欢下雨天/,
    "placing a memory from inside a chapter updates that chapter body");
  await callPage(page, "removeFromChapter", { currentTarget: { dataset: { id: "demo-personal-rain" } } });
  callPage(page, "backToContents");
  callPage(page, "chooseChapterFor", { currentTarget: { dataset: { id: "demo-personal-rain" } } });
  assert.equal(page.data.panel, "assign");
  await callPage(page, "assignTo", { currentTarget: { dataset: { id: "chapter-1" } } });
  draft = page.data.draft as any;
  assert.deepEqual(draft.chapters[0].memoryIds, ["demo-personal-rain"]);
  assert.match(draft.chapters[0].content.map((item: any) => item.text || "").join(""), /我小时候最喜欢下雨天/,
    "placing a memory appends its original text to the selected chapter");
  assert.deepEqual(draft.chapters[0].content.filter((item: any) => item.photoId), firstChapter.content.filter((item: any) => item.photoId),
    "placing a memory preserves existing photos");

  callPage(page, "openChapter", { currentTarget: { dataset: { id: draft.chapters[1].id } } });
  await callPage(page, "deleteActiveChapter");
  draft = page.data.draft as any;
  assert.equal(draft.chapters.length, 1);
  assert.equal(page.data.view, "contents");
  const revisions = storage.roomState().manuscriptRevisions!;
  assert.ok(revisions.some(item => item.draft.chapters?.some(chapter => chapter.title === "雨天的巷口")), "the deleted chapter stays in history");
  assert.deepEqual(revisions.find(item => item.id === "legacy-owner")!.draft, original, "the older book version is never rewritten");
});

test("an empty book can start with a first chapter from a story", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  assert.equal(page.data.draft, null);
  assert.deepEqual(page.data.storyOptions, [{ title: "外公接我放学", count: 1 }]);
  await callPage(page, "createChapter", { currentTarget: { dataset: { story: "外公接我放学" } } });
  const draft = page.data.draft as any;
  assert.equal(draft.title, "林岚的人生之书");
  assert.equal(draft.chapters[0].title, "外公接我放学");
  assert.match(draft.chapters[0].content.map((item: any) => item.text || "").join(""), /我小时候最喜欢下雨天/);
  assert.equal(page.data.view, "chapter");
});

test("manuscript typing keeps native text and cursor ownership instead of echoing the document", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  page.setData({ draft: { title: "测试", paragraphs: ["原文"] }, editTitle: "测试", editBody: "原文" });
  const updates: Record<string, unknown>[] = [];
  page.setData = update => { updates.push(update); Object.assign(page.data, update); };
  const text = "开头的修改\n\n" + "长文中段。".repeat(600);
  callPage(page, "onEditorInput", { detail: { delta: { ops: [{ insert: text }] }, text } });
  callPage(page, "onEditorInput", { detail: { delta: { ops: [{ insert: text + "结尾" }] }, text: text + "结尾" } });
  callPage(page, "onEditTitle", { detail: { value: "新标题" } });
  assert.equal(page.data.editing, true);
  assert.equal(page.bodyBuffer, text + "结尾");
  assert.equal(page.titleBuffer, "新标题");
  assert.ok(updates.every(update => !("editBody" in update) && !("editTitle" in update)));
  assert.equal(updates.length, 1, "only the first edit changes the dirty indicator");
});

test("keyboard resizes only the editor area and dirty manuscripts cannot be replaced by history", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  callPage(page, "onKeyboardHeight", { detail: { height: 300 } });
  assert.equal(page.data.keyboardHeight, 300);
  callPage(page, "onKeyboardHeight", { detail: { height: 0 } });
  assert.equal(page.data.keyboardHeight, 0);
  page.setData({ editing: true, showHistory: false });
  callPage(page, "toggleHistory");
  assert.equal(page.data.showHistory, false);
  assert.ok(storage.toasts.some(text => text.includes("保存")));
});

test("keyboard layout subtracts height once even when Android shrinks its window", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const wxMock = (globalThis as any).wx;
  let height = 760;
  wxMock.getWindowInfo = () => ({ windowHeight: height, windowWidth: 390 });
  wxMock.onKeyboardHeightChange = () => {};
  wxMock.offKeyboardHeightChange = () => {};
  const page = instantiate(await pageDefinition("book"));
  callPage(page, "onLoad");
  height = 460;
  callPage(page, "onResize", { size: { windowHeight: height, windowWidth: 390 } });
  callPage(page, "onKeyboardHeight", { detail: { height: 300 } });
  assert.equal(page.data.viewportHeight, 460, "760 - 300, not shrunk viewport 460 - 300");
  callPage(page, "onResize", { size: { windowHeight: height, windowWidth: 390 } });
  assert.equal(page.data.viewportHeight, 460);
  callPage(page, "onKeyboardHeight", { detail: { height: 0 } });
  assert.equal(page.data.viewportHeight, 760);
  callPage(page, "onUnload");
});

test("writing UI uses native fields without an expanding textarea or bottom navigation", () => {
  const template = readFileSync("miniprogram/pages/book/book.wxml", "utf8");
  assert.match(template, /<input[^>]*bindinput="onEditTitle"/);
  assert.match(template, /<editor[^>]*bindinput="onEditorInput"/);
  assert.doesNotMatch(template, /writing-heading|writing-status/);
  assert.match(template, /bindtap="togglePhotoMenu"/);
  assert.match(template, /data-action="import"[^>]*bindtap="choosePhotoAction"/);
  assert.match(template, /viewportHeight/);
  assert.doesNotMatch(template, /100vh\s*-/, "do not subtract a keyboard from a shrinking CSS viewport");
  const styles = readFileSync("miniprogram/pages/book/book.wxss", "utf8");
  assert.match(styles, /\.writing-toolbar > \.tool-button[^}]*width: 20%/);
  assert.match(styles, /\.tool-button[^}]*white-space: nowrap/);
  assert.ok(template.indexOf('bindtap="saveEdits"') < template.indexOf('class="writing-fields"'));
  assert.doesNotMatch(template, /<story-switcher|bindtap="editManuscript"/);
});

test("a selected manuscript excerpt is shared only with the chosen family members", async context => {
  const state = createInitialRoomState();
  state.personalDrafts = { owner: { title: "林岚的人生之书", paragraphs: ["外公撑着伞在巷口等我。"], sourceCount: 1, generatedAt: "", generationMode: "local-demo" } };
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  page.editorContext = {
    getSelectionText: ({ success }: any) => success({ text: "外公撑着伞在巷口等我。" }),
    setContents: ({ success }: any) => success(),
  };
  page.setData({ editorReady: true });

  callPage(page, "openShareSelection");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.panel, "share-excerpt");
  assert.equal(page.data.shareText, "外公撑着伞在巷口等我。");
  callPage(page, "onShareRecipients", { detail: { value: ["member-1"] } });
  await callPage(page, "sendExcerpt");

  const excerpt = storage.roomState().contributions.find(item => item.title?.includes("摘录"));
  assert.ok(excerpt);
  assert.equal(excerpt.text, "外公撑着伞在巷口等我。");
  assert.deepEqual(excerpt.relatedMemberIds, ["member-1"]);
  assert.deepEqual(excerpt.sharedWithMemberIds, ["member-1"]);
  assert.equal(page.data.panel, "");
  assert.match(String(page.data.saveNotice), /已发送给林秋/);
});

test("a migrated story sends only its saved revision reference through the trusted excerpt service",async context=>{
  const state=createInitialRoomState();
  const chapter={id:"chapter-a",title:"巷口",memoryIds:[],content:[{text:"外公撑着伞在巷口等我。"}]};
  state.storyMigration={version:1,status:"active",pending:[]};
  state.stories=[{id:"story-a",familyId:"family_owner",title:"旧城",bookTitle:"旧城",writingMode:"objective",version:2,
    currentRevisionId:"revision-a",protagonistMemberIds:[],memoryIds:[],createdAt:"2026-09-18T00:00:00Z",updatedAt:"2026-09-18T00:00:00Z"}];
  state.manuscriptRevisions=[{id:"revision-a",storyId:"story-a",memberId:"owner",kind:"version",label:"保存",savedAt:"2026-09-18T00:00:00Z",
    sourceFingerprint:"",draft:{title:"旧城",chapters:[chapter],content:[{text:"第一章　巷口\n\n"},{text:chapter.content[0].text},{text:"\n"}],
      paragraphs:["第一章　巷口","外公撑着伞在巷口等我。"],sourceCount:0,generatedAt:"2026-09-18T00:00:00Z",generationMode:"local-demo"}}];
  const storage=installWxMock(state);context.after(storage.restore);
  const original=storySharing.shareExcerpt,calls:any[]=[];
  storySharing.shareExcerpt=async input=>{calls.push(input);return {ok:true,contributionId:"excerpt-one",recipientMemberIds:input.recipientMemberIds};};
  context.after(()=>{storySharing.shareExcerpt=original;});
  const page=instantiate(await pageDefinition("book"));
  page.requestedStoryKey="story-a";page.activeChapterId="chapter-a";page.data.view="chapter";
  await callPage(page,"refresh");
  await callPage(page,"prepareExcerptShare","外公撑着伞在巷口等我。");
  callPage(page,"onShareRecipients",{detail:{value:["member-1"]}});
  await callPage(page,"sendExcerpt");
  assert.equal(calls.length,1);
  assert.deepEqual({...calls[0],requestId:"stable"},{
    storyId:"story-a",revisionId:"revision-a",expectedVersion:2,chapterId:"chapter-a",text:"外公撑着伞在巷口等我。",
    recipientMemberIds:["member-1"],requestId:"stable",
  });
  assert.equal(storage.roomState().contributions.some(item=>item.title?.includes("摘录")),false);
  assert.match(String(page.data.saveNotice),/已发送给林秋/);
});

test("sharing a manuscript excerpt requires an actual selection and a recipient", async context => {
  const state = createInitialRoomState();
  state.personalDrafts = { owner: { title: "书", paragraphs: ["正文"], sourceCount: 1, generatedAt: "", generationMode: "local-demo" } };
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  page.editorContext = { getSelectionText: ({ success }: any) => success({ text: "" }) };
  page.setData({ editorReady: true });
  callPage(page, "openShareSelection");
  assert.equal(last(storage.toasts), "请先在正文里选中一段文字");
  await callPage(page, "prepareExcerptShare", "正文");
  await callPage(page, "sendExcerpt");
  assert.equal(last(storage.toasts), "请选择要发送给谁");
  assert.equal(storage.roomState().contributions.filter(item => item.title?.includes("摘录")).length, 0);
});

test("discard restores native field seeds while a failed validation retains the typed draft", async context => {
  const state = createInitialRoomState();
  state.personalDrafts = { owner: { title: "原稿", paragraphs: ["原文"], sourceCount: 1, generatedAt: "", generationMode: "local-demo" } };
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  callPage(page, "onEditorInput", { detail: { delta: { ops: [{ insert: "还没保存的正文" }] }, text: "还没保存的正文" } });
  callPage(page, "onEditTitle", { detail: { value: "" } });
  await callPage(page, "saveEdits");
  assert.equal(page.data.editing, true);
  assert.equal(page.bodyBuffer, "还没保存的正文");
  const editorKey = (page.data.editorKeys as number[])[0];
  callPage(page, "cancelEdit");
  assert.equal(page.data.editing, false);
  assert.equal(page.bodyBuffer, "原文");
  assert.equal(page.data.editTitle, "原稿");
  assert.equal((page.data.editorKeys as number[])[0], editorKey + 1);
});

test("native photo picker inserts into the manuscript and saved local photo ordering survives reopen", async context => {
  const state = createInitialRoomState();
  state.personalDrafts = { owner: { title: "图文测试", paragraphs: ["前文", "后文"], sourceCount: 1, generatedAt: "", generationMode: "local-demo" } };
  const storage = installWxMock(state);
  context.after(storage.restore);
  const photoRecords = new Map<string, unknown>();
  const wxMock = (globalThis as any).wx;
  const getStorage = wxMock.getStorageSync;
  const setStorage = wxMock.setStorageSync;
  wxMock.env = { USER_DATA_PATH: "wxfile://usr" };
  wxMock.getStorageSync = (key: string) => photoRecords.has(key) ? photoRecords.get(key) : getStorage(key);
  wxMock.setStorageSync = (key: string, value: unknown) => key.startsWith("shiguang-local-photo-") ? photoRecords.set(key, value) : setStorage(key, value);
  wxMock.chooseMedia = ({ success, mediaType }: any) => {
    assert.deepEqual(mediaType, ["image"]);
    success({ tempFiles: [{ tempFilePath: "wxfile://tmp/photo.jpg", size: 123 }] });
  };
  wxMock.getFileSystemManager = () => ({ saveFile: ({ success }: any) => success({ savedFilePath: "wxfile://usr/photo.jpg" }), accessSync: () => {} });
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  let delta: any = { ops: [{ insert: "前文\n" }, { insert: "后文\n" }] };
  page.editorContext = {
    getContents: ({ success }: any) => success({ delta, text: "前文\n后文\n" }),
    insertImage: ({ src, success }: any) => { delta.ops.splice(1, 0, { insert: { image: src } }); success(); },
    setContents: ({ delta: next, success }: any) => { delta = next; success(); },
  };
  page.setData({ editorReady: true });
  await callPage(page, "addPhoto");
  assert.equal(page.data.editing, true);
  assert.equal(page.data.pickingPhoto, false);
  await callPage(page, "saveEdits");
  assert.equal(page.data.saveNotice, "修改已保存");
  const saved = (page.data.draft as any).chapters[0].content;
  assert.ok(saved[1].photoId);
  assert.ok(!JSON.stringify(page.data.draft).includes("wxfile"));
  const reopened = instantiate(await pageDefinition("book"));
  await callPage(reopened, "refresh");
  assert.deepEqual((reopened.data.draft as any).chapters[0].content, saved);
  assert.equal((reopened.photoPaths as any)[saved[1].photoId], "wxfile://usr/photo.jpg");
});

test("reopening an old cached photo seeds an actual editor image, not its identifier", async context => {
  const state = createInitialRoomState();
  const id = "photo-old-cache";
  const path = "wxfile://store_existing.jpg";
  state.personalDrafts = { owner: { title: "旧照片", paragraphs: ["前文【本机照片：photo-old-cache】后文"], sourceCount: 1, generatedAt: "", generationMode: "local-demo" } };
  const storage = installWxMock(state);
  context.after(storage.restore);
  const wxMock = (globalThis as any).wx;
  wxMock.env = { USER_DATA_PATH: "wxfile://usr" };
  wxMock.setStorageSync("shiguang-local-" + id, path);
  wxMock.getFileSystemManager = () => ({
    getSavedFileList: ({ success }: any) => success({ fileList: [{ filePath: path }] }),
    accessSync: (value: string) => assert.equal(value, path),
  });
  const page = instantiate(await pageDefinition("book"));
  let shown: any;
  page.editorContext = { setContents: ({ delta, success }: any) => { shown = delta; success(); } };
  await callPage(page, "refresh");
  assert.deepEqual(shown.ops[1].insert, { image: path });
  assert.ok(!JSON.stringify(shown).includes(id));
  assert.equal(page.data.editorReady, true);
  assert.equal(page.data.editing, false);
});

test("slow photo lookup never replaces text typed while a refresh was loading", async context => {
  const state = createInitialRoomState();
  state.personalDrafts = { owner: { title: "图文测试", paragraphs: ["原文"], content: [{ text: "原文" }, { photoId: "photo-old-cache" }], sourceCount: 1, generatedAt: "", generationMode: "local-demo" } };
  const storage = installWxMock(state);
  context.after(storage.restore);
  const wxMock = (globalThis as any).wx;
  wxMock.env = { USER_DATA_PATH: "wxfile://usr" };
  wxMock.setStorageSync("shiguang-local-photo-old-cache", "wxfile://store_existing.jpg");
  let finishLookup: any;
  let started: () => void;
  const lookupStarted = new Promise<void>(resolve => { started = resolve; });
  wxMock.getFileSystemManager = () => ({ getSavedFileList: ({ success }: any) => { finishLookup = success; started(); }, accessSync: () => {} });
  const page = instantiate(await pageDefinition("book"));
  page.setData({ draft: state.personalDrafts.owner });
  const loading = callPage(page, "refresh");
  await lookupStarted;
  callPage(page, "onEditorInput", { detail: { delta: { ops: [{ insert: "新输入的正文" }] }, text: "新输入的正文" } });
  finishLookup({ fileList: [{ filePath: "wxfile://store_existing.jpg" }] });
  await loading;
  assert.equal(page.bodyBuffer, "新输入的正文");
  assert.deepEqual(page.contentBuffer, [{ text: "新输入的正文" }]);
  assert.equal(page.data.editing, true);
});

test("organize preview can be cancelled without writing and rejects changed sources", async context => {
  const previousApp = (globalThis as any).getApp;
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: false } });
  context.after(() => { (globalThis as any).getApp = previousApp; });
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  callPage(page, "showOrganize");
  await callPage(page, "runOrganize");
  callPage(page, "closePanel");
  await callPage(page, "confirmOrganize");
  assert.equal(storage.roomState().manuscriptRevisions, undefined);
  callPage(page, "showOrganize");
  await callPage(page, "runOrganize");
  const { appendContribution } = await import("../miniprogram/services/roomStorage");
  appendContribution(createContribution({ authorMemberId: "owner", authorName: "测试", relation: "自己", text: "素材发生了变化", scope: "personal", visibility: "private" }));
  await callPage(page, "confirmOrganize");
  assert.match(String(page.data.saveNotice), /已有更新/);
  assert.equal(storage.roomState().manuscriptRevisions, undefined);
});

test("memory entry preselects its source and preview edits become the saved chapter", async context => {
  const previousApp = (globalThis as any).getApp;
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: false } });
  context.after(() => { (globalThis as any).getApp = previousApp; });
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  page.requestedMemoryIds = ["demo-personal-rain"];
  await callPage(page, "refresh");
  assert.equal(page.data.panel, "organize");
  assert.deepEqual(page.organizeSelection, ["demo-personal-rain"]);
  await callPage(page, "runOrganize");
  callPage(page, "onPreviewText", { detail: { value: "我确认的正文。" } });
  callPage(page, "onPreviewTitle", { detail: { value: "雨中的陪伴" } });
  await callPage(page, "confirmOrganize");
  assert.equal((page.data.draft as any).chapters[0].title, "雨中的陪伴");
  assert.equal((page.data.draft as any).chapters[0].content[0].text, "我确认的正文。\n");
  assert.equal(storage.roomState().contributions[0].text, createInitialRoomState().contributions[0].text);
});

test("editing only an AI organize-preview title updates the disclosure immediately", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  page.setData({ previewAiLabel: "文字 AI 生成", previewTitle: "AI 原标题" });
  callPage(page, "onPreviewTitle", { detail: { value: "我改过的标题" } });
  assert.equal(page.data.previewAiLabel, "文字 AI 生成 · 已由你修改");

  page.setData({ previewAiLabel: "", previewTitle: "普通标题" });
  callPage(page, "onPreviewTitle", { detail: { value: "普通标题改过了" } });
  assert.equal(page.data.previewAiLabel, "", "non-AI previews are never mislabeled");
});


test("interview persist-first, manual save and archive restore keep the same memory and original speech", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad");
  page.setData({ answers: ["小时候我喜欢在院子里听雨。"], writingMode: "objective" });
  await callPage(page, "finish");
  const spoken = page.pendingContribution as import("../miniprogram/domain/biography").MemoryContribution;
  assert.equal(storage.roomState().contributions.find(item => item.id === spoken.id)?.text, spoken.text);
  const count = storage.roomState().contributions.length;
  // Model output enters through the same revision boundary as finish().
  page.pendingContribution = appendAiRevision(spoken, "ai", "童年的院子里，我常静静听雨。", "听雨", "cloud-ai");
  page.setData({ draftText: "童年的院子里，我常静静听雨。", draftOrganizationMode: "cloud-ai" });
  callPage(page, "onDraftInput", { detail: { value: "我和外婆在院子里听雨。" } });
  await callPage(page, "save");
  assert.equal(page.data.saved, true);
  assert.equal(storage.roomState().contributions.length, count);
  const saved = storage.roomState().contributions.find(item => item.id === spoken.id)!;
  assert.deepEqual(memoryAiRevisions(saved).map(item => item.kind), ["spoken", "ai", "manual"]);
  assert.equal(memoryOriginalSpokenText(saved), spoken.text);

  const archive = instantiate(await pageDefinition("archive"));
  await callPage(archive, "openMemory", { currentTarget: { dataset: { id: spoken.id } } });
  assert.equal(archive.data.originalText, spoken.text);
  assert.equal(archive.data.canRevertToSpoken, true);
  callPage(archive, "onEditText", { detail: { value: "我和外婆坐在门边听雨。" } });
  await callPage(archive, "saveEdit");
  assert.equal((archive.data.historyItems as unknown[]).length, 4);
  await callPage(archive, "confirmRevertToSpoken");
  const restored = storage.roomState().contributions.find(item => item.id === spoken.id)!;
  assert.equal(restored.text, spoken.text);
  assert.deepEqual(memoryAiRevisions(restored).map(item => item.kind), ["spoken", "ai", "manual", "manual", "restore"]);
  assert.equal(archive.data.canRevertToSpoken, false);
  assert.equal(archive.data.reverting, false);
});

test("interview local fallback preserves persisted speech without inventing AI revisions", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad");
  callPage(page, "onInput", { detail: { value: "今天想起了老家的院子。" } });
  await callPage(page, "finish");
  const id = (page.pendingContribution as { id: string }).id;
  await callPage(page, "save");
  const saved = storage.roomState().contributions.find(item => item.id === id)!;
  assert.equal(saved.text, "今天想起了老家的院子。");
  assert.equal(memoryAiRevisions(saved).some(item => item.kind === "ai"), false);
  assert.equal(page.data.draftAiLabel, "");
});

test("continuous keyboard input never echoes bound values; send clears once and preserves intentional repetition", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  page.setData({ storyId: "story-keyboard", writingMode: "objective" });
  const updates: Record<string, unknown>[] = [];
  page.setData = update => { updates.push(update); Object.assign(page.data, update); };
  const values = ["今天", "今天阳光很好。", "今天阳光很好。准备去公园散步。", "删改后：慢慢来，慢慢来。" + "很长的文字。".repeat(200)];
  for (const value of values) callPage(page, "onInput", { detail: { value } });
  callPage(page, "onKeyboardHeightChange", { detail: { height: 300 } });
  callPage(page, "onKeyboardHeightChange", { detail: { height: 0 } });
  assert.equal(page.data.inputText, values[values.length - 1]);
  assert.ok(updates.every(update => !("inputText" in update)));
  await callPage(page, "send");
  assert.deepEqual(page.data.answers, [values[values.length - 1]]);
  assert.equal((page.data.messages as Array<{ text: string }>)[0].text, values[values.length - 1]);
  assert.deepEqual(updates.filter(update => "inputText" in update).map(update => update.inputText), [""]);
  assert.equal(page.data.inputText, "");
  for (const [handler, field] of [["onTitleInput", "draftTitle"], ["onDraftInput", "draftText"], ["onImportCaptionInput", "importCaption"], ["onStoryTitleInput", "storyTitle"]]) {
    updates.length = 0;
    callPage(page, handler, { detail: { value: "新的" } });
    callPage(page, handler, { detail: { value: "新的文字" } });
    assert.equal(page.data[field], "新的文字");
    assert.ok(updates.every(update => !(field in update)), handler + " must not echo native input");
  }
});


test("personal memory is reachable from Me, forget waits for success, and failed settings remain unchanged", async context => {
  const storage = installWxMock(createInitialRoomState()); context.after(storage.restore);
  const { personalMemory } = await import("../miniprogram/services/personalMemory");
  const original = { ...personalMemory }; context.after(() => Object.assign(personalMemory, original));
  const item = { lineageKey: "lineage-one", text: "喜欢安静地阅读。", origin: "inferred" as const, allowProactiveMention: true };
  let forgotten = false;
  personalMemory.list = async () => ({ enabled: true, insights: forgotten ? [] : [item] });
  personalMemory.forget = async key => { assert.equal(key, item.lineageKey); forgotten = true; };
  personalMemory.configure = async () => { throw new Error("offline"); };
  const me = instantiate(await pageDefinition("me")); callPage(me, "openPersonalMemory");
  assert.equal(storage.navigations[0], "/pages/personal-memory/personal-memory");
  const page = instantiate(await pageDefinition("personal-memory")); await callPage(page, "refresh");
  assert.equal((page.data.insights as Array<{ originLabel: string }>)[0].originLabel, "小忆的暂定理解");
  await callPage(page, "confirmEnabled", false);
  assert.equal(page.data.enabled, true); assert.equal(page.data.busy, false);
  await callPage(page, "confirmForget", item.lineageKey);
  assert.deepEqual(page.data.insights, []); assert.equal(page.data.busy, false);
});

test("saved-memory learning is nonblocking, sends only an id and respects local consent denial", async context => {
  const storage = installWxMock(createInitialRoomState()); context.after(storage.restore);
  const previousApp = Object.getOwnPropertyDescriptor(globalThis, "getApp");
  Object.defineProperty(globalThis, "getApp", {configurable:true,value:()=>({globalData:{cloudReady:true,aiReady:true}})});
  context.after(()=>{if(previousApp)Object.defineProperty(globalThis,"getApp",previousApp);else delete (globalThis as any).getApp;});
  const calls: unknown[] = []; let finish: ((value: unknown) => void) | undefined;
  (globalThis as any).wx.cloud = {callFunction:(value: unknown)=>{calls.push(value);return new Promise(resolve=>{finish=resolve;});}};
  const { learnFromSavedMemory } = await import("../miniprogram/services/personalMemory");
  const memory = createContribution({authorMemberId:"owner",authorName:"我",relation:"自己",text:"私密原话",scope:"personal",visibility:"private"});
  learnFromSavedMemory(memory); assert.equal(calls.length,0);
  wx.setStorageSync("aiConsentDecision",{granted:true,version:1});
  assert.equal(learnFromSavedMemory(memory),undefined);
  assert.deepEqual(calls,[{name:"personalMemory",data:{action:"extract",memoryId:memory.id}}]);
  finish?.({result:{status:"complete"}});
});

test("saving memory offers empty existing books and saved legacy manuscripts, and carries its stable id to chapters", async context => {
  const state = createInitialRoomState();
  state.stories = [{ id: "story-existing", familyId: "local", title: "既有故事", writingMode: "objective", memoryIds: [], protagonistMemberIds: [], createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z", version: 0 }];
  state.personalDrafts = { owner: { title: "旧书稿", paragraphs: ["原文"], sourceCount: 0, generatedAt: "", generationMode: "local-demo" } };
  const storage = installWxMock(state); context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad");
  assert.ok((page.data.storyOptions as any[]).some(item => item.key === "story-existing" && item.count === 0));
  assert.ok((page.data.storyOptions as any[]).some(item => item.key === "manuscript:owner"));
  wx.setStorageSync(ROOM_KEY, { ...storage.roomState(), storyMigration: { version: 1, status: "active", pending: [] } });
  callPage(page, "chooseStory", { currentTarget: { dataset: { key: "story-existing" } } });
  page.setData({ stage: "save", draftText: "新的虚构记忆。", draftTitle: "午后" });
  const before = storage.roomState().contributions.length;
  await callPage(page, "save");
  const memory = storage.roomState().contributions.find(item => item.text === "新的虚构记忆。");
  assert.ok(memory);
  assert.equal(page.data.saved, true, String(page.data.saveError) + storage.toasts.join(";"));
  assert.deepEqual(storage.roomState().stories![0].memoryIds, [memory.id]);
  const query = new URLSearchParams(last(storage.navigations)!.split("?")[1]);
  assert.equal(query.get("storyId"), "story-existing");
  assert.equal(query.get("memoryIds"), memory.id);
  assert.equal(storage.roomState().manuscriptRevisions, undefined, "save does not write chapter contents");
  await callPage(page, "save");
  callPage(page, "continueToChapter");
  assert.equal(storage.roomState().contributions.length, before + 1, "retry navigation must not duplicate the memory");
});

test("changing the destination to fragment or a typed title clears the previously selected story id", async context => {
  const state = createInitialRoomState();
  state.stories = [{ id: "story-existing", familyId: "local", title: "同名故事", writingMode: "objective", memoryIds: [], protagonistMemberIds: [], createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z", version: 0 }];
  const storage = installWxMock(state); context.after(storage.restore);
  const page = instantiate(await pageDefinition("interview"));
  await callPage(page, "onLoad", { storyId: "story-existing" });
  callPage(page, "chooseFragment");
  assert.equal(page.data.storyId, "");
  assert.equal(page.data.selectedStoryKey, "");
  callPage(page, "chooseStory", { currentTarget: { dataset: { key: "story-existing" } } });
  callPage(page, "onStoryTitleInput", { detail: { value: "新的故事名" } });
  assert.equal(page.data.storyId, "");
  assert.equal(page.data.selectedStoryKey, "");
  page.setData({ stage: "save", draftText: "新记忆。" });
  await callPage(page, "save");
  assert.deepEqual(storage.roomState().stories![0].memoryIds, []);
  assert.equal(storage.navigations.length, 0);
});

test("chapter insertion previews original context, edits only added text, and preserves old memory links and photos", async context => {
  const state = createInitialRoomState();
  const original = [{ text: "第一段。\n\n第二段。\n" }, { photoId: "photo-middle" }, { text: "第三段。" }];
  state.personalDrafts = { owner: { title: "已有文章", paragraphs: ["第一段。", "第二段。", "第三段。"], sourceCount: 1, generatedAt: "", generationMode: "local-demo", chapters: [
    { id: "chapter-kept", title: "已有章节", memoryIds: ["old-source"], content: original, handEdited: true },
    { id: "chapter-other", title: "其他章节", memoryIds: ["demo-personal-rain"], content: [{ text: "另一章保留。" }] },
  ] } };
  const storage = installWxMock(state); context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  callPage(page, "showOrganize");
  callPage(page, "onOrganizeTarget", { detail: { value: "chapter-kept" } });
  assert.match(String(page.data.organizeOriginal), /第一段。[\s\S]*第二段。[\s\S]*第三段。/);
  assert.equal(page.data.organizeMethod, "insert");
  callPage(page, "onOrganizeMemories", { detail: { value: ["demo-personal-rain"] } });
  callPage(page, "onInsertionPoint", { detail: { value: "1" } });
  await callPage(page, "runOrganize");
  assert.equal(page.data.panel, "organize-preview", String(page.data.saveNotice));
  assert.equal(page.data.previewInsertion, true);
  assert.equal(storage.roomState().manuscriptRevisions, undefined);
  callPage(page, "onInsertionText", { detail: { value: "由我确认的新增记忆。" } });
  assert.match(String(page.data.previewText), /第一段。[\s\S]*由我确认的新增记忆。[\s\S]*第二段。/);
  await callPage(page, "confirmOrganize");
  const chapters = (page.data.draft as any).chapters;
  assert.deepEqual(chapters[0].content, [{ text: "第一段。\n\n" }, { text: "由我确认的新增记忆。\n\n" }, { text: "第二段。\n" }, { photoId: "photo-middle" }, { text: "第三段。" }]);
  assert.deepEqual(chapters[0].memoryIds, ["old-source", "demo-personal-rain"]);
  assert.deepEqual(chapters[1], state.personalDrafts.owner.chapters![1]);
  assert.equal(storage.roomState().contributions[0].text, createInitialRoomState().contributions[0].text);
});

test("insertion refuses a changed saved chapter instead of overwriting newer text", async context => {
  const state = createInitialRoomState();
  state.personalDrafts = { owner: { title: "旧稿", paragraphs: ["原文"], sourceCount: 0, generatedAt: "", generationMode: "local-demo" } };
  const storage = installWxMock(state); context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  callPage(page, "showOrganize");
  await callPage(page, "runOrganize");
  assert.equal(page.data.previewInsertion, true);
  const updated = makeRevision("owner", { ...state.personalDrafts.owner, paragraphs: ["别处已修改"] }, "", "version", "更新");
  const { saveManuscriptRevision } = await import("../miniprogram/services/manuscript");
  await saveManuscriptRevision(updated, String(page.revisionId));
  await callPage(page, "confirmOrganize");
  assert.match(String(page.data.saveNotice), /已有更新/);
  const { currentManuscript } = await import("../miniprogram/services/manuscript");
  assert.equal(currentManuscript(storage.roomState(), "owner").revisionId, updated.id);
});

test("opening insertion does not preselect memories already written into a chapter", async context => {
  const state = createInitialRoomState();
  state.personalDrafts = { owner: { title: "已有书", paragraphs: ["已写入的文字"], sourceCount: 1, generatedAt: "", generationMode: "local-demo", chapters: [
    { id: "chapter-existing", title: "已有章", memoryIds: ["demo-personal-rain"], content: [{ text: "已写入的文字" }] },
  ] } };
  const storage = installWxMock(state); context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  callPage(page, "showOrganize");
  assert.equal(page.data.organizeMethod, "insert");
  assert.deepEqual(page.organizeSelection, []);
  assert.equal(page.data.organizeCount, 0);
});

test("an independent story shows every saved chapter even when some have no linked memory", async context => {
  const state = createInitialRoomState();
  const chapters = [
    { id: "chapter-linked", title: "有记忆", memoryIds: ["demo-personal-rain"], content: [{ text: "已关联的章节。" }] },
    { id: "chapter-unlinked", title: "亲手写的章节", memoryIds: [], content: [{ text: "没有关联记忆的正文。" }] },
    { id: "chapter-other", title: "原有章节", memoryIds: ["old-source"], content: [{ text: "迁移前留下的正文。" }] },
  ];
  const draft = { title: "完整的书", paragraphs: [], sourceCount: 1, generatedAt: "2026-09-24T00:00:00Z", generationMode: "local-demo" as const, chapters };
  state.storyMigration = { version: 1, status: "active", pending: [] };
  state.stories = [{ id: "story-complete", familyId: "local", title: "完整的书", writingMode: "objective", memoryIds: ["demo-personal-rain"], protagonistMemberIds: [], createdAt: "2026-09-24T00:00:00Z", updatedAt: "2026-09-24T00:00:00Z", version: 1, currentRevisionId: "revision-complete" }];
  state.manuscriptRevisions = [{ ...makeRevision("owner", draft, "", "draft", "原稿"), id: "revision-complete", storyId: "story-complete" }];
  const storage = installWxMock(state); context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  page.requestedStoryKey = "story-complete";
  await callPage(page, "refresh");
  assert.deepEqual((page.data.chapterRows as any[]).map(row => [row.id, row.label]), [
    ["chapter-linked", "第一章"], ["chapter-unlinked", "第二章"], ["chapter-other", "第三章"],
  ]);
  await callPage(page, "openChapter", {currentTarget:{dataset:{id:"chapter-unlinked"}}});
  assert.equal(page.data.view, "chapter");
  assert.equal(page.bodyBuffer, "没有关联记忆的正文。");
  assert.equal(storage.roomState().manuscriptRevisions?.[0].draft.chapters?.length, 3, "opening is read-only");
  state.stories![0].sourcePolicyRequired = true;
  await callPage(page, "refresh");
  assert.equal(page.data.protectedCopy, true);
  assert.equal((page.data.chapterRows as any[]).length, 3, "protected copies also show every chapter in their own revision");
});

test("inserting into a scoped chapter uses the chapter number displayed in its picker", async context => {
  const state = createInitialRoomState();
  state.personalDrafts = { owner: { title: "测试书", paragraphs: ["另一故事", "目标章节"], sourceCount: 1, generatedAt: "", generationMode: "local-demo", chapters: [
    { id: "chapter-hidden", title: "其他故事", memoryIds: [], content: [{ text: "不属于当前故事的原文。" }] },
    { id: "chapter-target", title: "目标章节", memoryIds: ["demo-personal-rain"], content: [{ text: "当前故事的原文。" }] },
  ] } };
  const storage = installWxMock(state); context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  page.requestedStoryKey = "story:外公接我放学";
  await callPage(page, "refresh");
  assert.deepEqual((page.data.chapterRows as any[]).map(row => [row.id, row.label]), [["chapter-target", "第一章"]]);
  callPage(page, "showOrganize");
  callPage(page, "onOrganizeTarget", { detail: { value: "chapter-target" } });
  callPage(page, "onOrganizeMemories", { detail: { value: ["demo-personal-rain"] } });
  await callPage(page, "runOrganize");
  assert.equal((page.organizeCandidate as any).label, "第一章");
  await callPage(page, "confirmOrganize");
  assert.match(String(page.data.saveNotice), /^已写入第一章/);
  assert.equal(page.data.chapterLabelText, "第一章");
  assert.deepEqual((page.data.draft as any).chapters[0], state.personalDrafts.owner.chapters![0]);
});
