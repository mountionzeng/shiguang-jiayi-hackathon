import assert from "node:assert/strict";
import test from "node:test";

import {
  createContribution,
  createInitialRoomState,
  FamilyRoomState,
} from "../miniprogram/domain/biography";

const ROOM_KEY = "shiguang-family-room-v4";
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

async function pageDefinition(name: "index" | "interview" | "room"): Promise<TestPageDefinition> {
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
    } else {
      await import("../miniprogram/pages/room/room");
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
      navigateBack: () => undefined,
      navigateTo: () => undefined,
      switchTab: () => undefined,
    },
  });

  return {
    currentMemberId: () => stored.get(CURRENT_MEMBER_KEY),
    roomState: () => stored.get(ROOM_KEY) as FamilyRoomState,
    toasts,
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
  callPage(page, "save");
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
  assert.match(last(storage.toasts) ?? "", /已不在当前空间/);
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

  callPage(page, "finish");
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
  callPage(page, "finish");
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
  await assert.doesNotReject(() => Promise.resolve(callPage(interview, "onLoad")));
  const home = instantiate(await pageDefinition("index"));
  await assert.doesNotReject(() => Promise.resolve(callPage(home, "refresh", corrupted)));
  assert.equal(home.data.fragmentCount, 1);
});

test("home share picker persists multiple readers and can return to private", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("index"));
  await callPage(page, "refresh", storage.roomState());

  await callPage(page, "changeShareTarget", {
    currentTarget: { dataset: { id: "demo-personal-rain" } },
  });
  callPage(page, "toggleShareTarget", {
    currentTarget: { dataset: { id: "member-1" } },
  });
  callPage(page, "toggleShareTarget", {
    currentTarget: { dataset: { id: "member-2" } },
  });
  await callPage(page, "confirmShareTargets");

  let story = storage.roomState().contributions.find(
    (memory) => memory.id === "demo-personal-rain",
  );
  assert.deepEqual(story?.sharedWithMemberIds, ["member-1", "member-2"]);
  assert.equal(last(storage.toasts), "已允许 2 位亲友阅读");

  await callPage(page, "changeShareTarget", {
    currentTarget: { dataset: { id: "demo-personal-rain" } },
  });
  callPage(page, "choosePrivateShare");
  await callPage(page, "confirmShareTargets");
  story = storage.roomState().contributions.find(
    (memory) => memory.id === "demo-personal-rain",
  );
  assert.equal(story?.sharedWithMemberIds, undefined);
  assert.equal(last(storage.toasts), "已改为仅自己可见");
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

test("switching demo identity refreshes owned and received stories", async (context) => {
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
  const storage = installWxMock(state);
  context.after(storage.restore);
  const page = instantiate(await pageDefinition("index"));
  await callPage(page, "refresh", state);

  assert.equal((page.data.identity as { id: string }).id, "owner");
  assert.equal((page.data.sharedStories as unknown[]).length, 0);

  await callPage(page, "chooseIdentity", {
    currentTarget: { dataset: { id: "member-1" } },
  });
  assert.equal(storage.currentMemberId(), "member-1");
  assert.deepEqual(
    (page.data.recentFragments as Array<{ id: string }>).map((story) => story.id),
    [memberStory.id],
  );
  assert.deepEqual(
    (page.data.sharedStories as Array<{ id: string }>).map((story) => story.id),
    [ownerStory.id],
  );

  await callPage(page, "chooseIdentity", {
    currentTarget: { dataset: { id: "member-2" } },
  });
  assert.equal((page.data.sharedStories as unknown[]).length, 0);
});
