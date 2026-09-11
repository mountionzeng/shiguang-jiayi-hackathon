import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  createContribution,
  FamilyRoomState,
} from "../miniprogram/domain/biography";
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

async function pageDefinition(name: "index" | "interview" | "room" | "book" | "profiles" | "archive" | "me" | "stories"): Promise<TestPageDefinition> {
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
    if (name === "index") {
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
  assert.match(last(storage.toasts) ?? "", /亲友档案已变更/);
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

test("Memory Home shows only permissioned stories and revocation removes them", async (context) => {
  const initial = createInitialRoomState();
  const sharedStory = createContribution({
    id: "permissioned-story",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "这是只让外公和陈野看到的一段记忆。",
    storyTitle: "雨天与老屋",
    relatedMemberIds: ["member-1"],
    sharedWithMemberIds: ["elder", "member-2"],
    scope: "personal",
    visibility: "private",
    now: new Date("2026-08-28T08:00:00.000Z"),
  });
  const state = {
    ...initial,
    contributions: initial.contributions.concat(sharedStory),
  };
  const storage = installWxMock(state, "member-2");
  context.after(storage.restore);
  const room = instantiate(await pageDefinition("room"));
  await callPage(room, "refresh", state);

  assert.ok(
    (room.data.timeline as Array<{ id: string }>).some(
      (memory) => memory.id === sharedStory.id,
    ),
  );
  const relatedFilter = (room.data.filters as Array<{ id: string; count: number }>).find(
    (filter) => filter.id === "member-1",
  );
  assert.equal(relatedFilter?.count, 1);

  const unauthorized = instantiate(await pageDefinition("room"));
  const unauthorizedStorage = installWxMock(state, "member-1");
  context.after(unauthorizedStorage.restore);
  await callPage(unauthorized, "refresh", state);
  assert.ok(
    !(unauthorized.data.timeline as Array<{ id: string }>).some(
      (memory) => memory.id === sharedStory.id,
    ),
  );

  const authorStorage = installWxMock(state, "owner");
  context.after(authorStorage.restore);
  const authorRoom = instantiate(await pageDefinition("room"));
  await callPage(authorRoom, "refresh", state);
  const detail = (authorRoom.data.timeline as Array<{ id: string }>).find(
    (memory) => memory.id === sharedStory.id,
  );
  assert.ok(detail);
  authorRoom.setData({ detail });
  await callPage(authorRoom, "revokeSharing");
  assert.equal(
    authorStorage.roomState().contributions.find(
      (memory) => memory.id === sharedStory.id,
    )?.sharedWithMemberIds,
    undefined,
  );
  assert.ok(
    !(authorRoom.data.timeline as Array<{ id: string }>).some(
      (memory) => memory.id === sharedStory.id,
    ),
  );
});

test("home shows only the current member's own recent stories", async (context) => {
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

  assert.deepEqual(
    (page.data.recentStories as Array<{ id: string }>).map((story) => story.id),
    [memberStory.id],
  );
  assert.equal(page.data.bookTitle, "林秋的人生之书");
  assert.equal(storage.currentMemberId(), "member-1");
});

test("the home profile switch expands and changes the active archive profile", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("index"));

  await callPage(page, "refresh");
  callPage(page, "openProfiles");
  assert.equal(page.data.profileChooserOpen, true);
  assert.equal((page.data.profileOptions as Array<{ id: string }>).length, 5);

  await callPage(page, "chooseProfile", {
    currentTarget: { dataset: { id: "member-1" } },
  });

  assert.equal(storage.currentMemberId(), "member-1");
  assert.equal(page.data.profileChooserOpen, false);
  assert.equal(page.data.memberName, "林秋");
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

  assert.equal(
    last(storage.navigations),
    `/pages/interview/interview?sourceId=demo-personal-rain&storyTitle=${encodeURIComponent(
      String(page.data.recommendedStoryTitle),
    )}`,
  );
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

test("the home cover opens the editable manuscript after its animation", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("index"));

  await withImmediateTimeouts(() => callPage(page, "openMemoryArchive"));

  assert.equal(page.data.bookOpening, false);
  assert.equal(last(storage.navigations), "/pages/book/book");
});

test("the home book shortcuts open their matching memory spaces", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("index"));

  callPage(page, "openArchiveTab", { currentTarget: { dataset: { tab: "note" } } });
  callPage(page, "openArchiveTab", { currentTarget: { dataset: { tab: "memoir" } } });
  callPage(page, "openPeople");

  assert.deepEqual(storage.navigations.slice(-3), [
    "/pages/archive/archive",
    "/pages/stories/stories",
    "/pages/profiles/profiles?mode=people",
  ]);
});

test("the memory archive shows only the current profile's quick notes", async (context) => {
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
    !storage.roomState().contributions.some((memory) => memory.id === "demo-personal-rain"),
  );
  assert.equal(page.data.noteCount, 0);
  assert.equal(page.data.hasItems, false);
  assert.equal(last(storage.toasts), "已删除");
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

test("creating a recording profile and adding a person are separate operations", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const profiles = instantiate(await pageDefinition("profiles"));
  callPage(profiles, "onLoad");
  profiles.setData({ memberNameInput: "新的记录档案" });
  await callPage(profiles, "addProfile");
  const profileId = storage.currentMemberId();
  assert.equal(storage.roomState().members.find(item => item.id === profileId)?.kind, "recording-profile");
  const people = instantiate(await pageDefinition("profiles"));
  callPage(people, "onLoad", { mode: "people" });
  people.setData({ memberNameInput: "测试朋友", relationInput: "朋友" });
  await callPage(people, "addProfile");
  assert.equal(storage.currentMemberId(), profileId);
  const person = storage.roomState().members.find(item => item.name === "测试朋友")!;
  assert.equal(person.kind, "person");
  await callPage(profiles, "refresh");
  assert.ok(!(profiles.data.profiles as Array<{id: string}>).some(item => item.id === person.id));
  await callPage(people, "refresh");
  assert.ok(!(people.data.profiles as Array<{id: string}>).some(item => item.id === profileId));
  const home = instantiate(await pageDefinition("index"));
  await callPage(home, "refresh");
  assert.ok(!(home.data.profileOptions as Array<{id: string}>).some(item => item.id === person.id));
});

test("people management never impersonates a person and changes only the selected record readership", async context => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("profiles"));
  callPage(page, "onLoad", { mode: "people" });
  await callPage(page, "refresh");
  await callPage(page, "chooseProfile", { currentTarget: { dataset: { id: "member-1" } } });
  assert.equal(storage.currentMemberId(), "owner");
  const before = storage.roomState().contributions.find(item => item.id === "demo-personal-rain")!;
  const hadRead = before.sharedWithMemberIds?.includes("member-1") ?? false;
  await callPage(page, "toggleReading", { currentTarget: { dataset: { id: before.id } } });
  const after = storage.roomState().contributions.find(item => item.id === before.id)!;
  assert.equal(after.sharedWithMemberIds?.includes("member-1") ?? false, !hadRead);
  assert.deepEqual(after.relatedMemberIds, before.relatedMemberIds);
  assert.equal(storage.currentMemberId(), "owner");
});

test("AI manuscript requires adoption; edits, saved versions and source changes preserve history", async context => {
  const previousApp = (globalThis as any).getApp;
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: false } });
  context.after(() => { (globalThis as any).getApp = previousApp; });
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("book"));
  await callPage(page, "refresh");
  const oldDraft = page.data.draft;
  await callPage(page, "generateChapter");
  assert.ok(page.data.candidate);
  assert.equal(page.data.draft, oldDraft);
  assert.equal(storage.roomState().manuscriptRevisions, undefined);
  await callPage(page, "adoptCandidate");
  assert.ok(page.data.draft);
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
  assert.match(template, /bindtap="addPhoto"/);
  assert.match(template, /viewportHeight/);
  assert.doesNotMatch(template, /100vh\s*-/, "do not subtract a keyboard from a shrinking CSS viewport");
  const styles = readFileSync("miniprogram/pages/book/book.wxss", "utf8");
  assert.match(styles, /\.writing-toolbar > \.tool-button[^}]*width: 25%/);
  assert.match(styles, /\.tool-button[^}]*white-space: nowrap/);
  assert.ok(template.indexOf('bindtap="saveEdits"') < template.indexOf('class="writing-fields"'));
  assert.doesNotMatch(template, /<story-switcher|bindtap="editManuscript"/);
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

test("choosing a profile changes the active personal archive", async (context) => {
  const state = createInitialRoomState();
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("profiles"));

  await callPage(page, "refresh", state);
  assert.equal(
    (page.data.profiles as Array<{ id: string; current: boolean }>).find(
      (profile) => profile.id === "owner",
    )?.current,
    true,
  );

  await callPage(page, "chooseProfile", {
    currentTarget: { dataset: { id: "member-1" } },
  });

  assert.equal(storage.currentMemberId(), "member-1");
  assert.equal(last(storage.toasts), "已切换到林秋");
  assert.equal(storage.backCount(), 1);
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
  const saved = (page.data.draft as any).content;
  assert.ok(saved[1].photoId);
  assert.ok(!JSON.stringify(saved).includes("wxfile"));
  const reopened = instantiate(await pageDefinition("book"));
  await callPage(reopened, "refresh");
  assert.deepEqual((reopened.data.draft as any).content, saved);
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
