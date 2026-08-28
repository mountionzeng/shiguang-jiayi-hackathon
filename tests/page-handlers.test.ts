import assert from "node:assert/strict";
import test from "node:test";

import {
  createContribution,
  createInitialRoomState,
  FamilyRoomState,
} from "../miniprogram/domain/biography";

const ROOM_KEY = "shiguang-family-room-v3";
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

async function pageDefinition(name: "index" | "quick-note"): Promise<TestPageDefinition> {
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
    } else {
      await import("../miniprogram/pages/quick-note/quick-note");
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
      showModal: () => undefined,
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

function withImmediateTimeouts(action: () => void): void {
  const previous = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    callback();
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    action();
  } finally {
    globalThis.setTimeout = previous;
  }
}

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

test("quick note maps destination and one reader into the persisted story", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const definition = await pageDefinition("quick-note");
  const page = instantiate(definition);
  callPage(page, "onLoad");

  page.setData({
    text: "今天忽然很想念小时候放学回家的路。",
    textLength: 18,
    destination: "personal",
    shareTargetId: "member-1",
  });
  withImmediateTimeouts(() => callPage(page, "save"));

  const savedPersonal = last(storage.roomState().contributions);
  assert.equal(savedPersonal?.scope, "personal");
  assert.equal(savedPersonal?.authorMemberId, "owner");
  assert.deepEqual(savedPersonal?.sharedWithMemberIds, ["member-1"]);
  const countAfterFirstSave = storage.roomState().contributions.length;
  callPage(page, "save");
  assert.equal(storage.roomState().contributions.length, countAfterFirstSave);

  const familyPage = instantiate(definition);
  callPage(familyPage, "onLoad");
  familyPage.setData({
    text: "去年春节，我们全家一起包了很多饺子。",
    textLength: 19,
  });
  callPage(familyPage, "chooseDestination", {
    currentTarget: { dataset: { scope: "family" } },
  });
  withImmediateTimeouts(() => callPage(familyPage, "save"));

  const savedFamily = last(storage.roomState().contributions);
  assert.equal(savedFamily?.scope, "family");
  assert.equal(savedFamily?.reviewStatus, "pending");
  assert.equal(savedFamily?.sharedWithMemberIds, undefined);
});

test("quick note rejects invalid destinations and removed share targets", async (context) => {
  const storage = installWxMock(createInitialRoomState());
  context.after(storage.restore);
  const definition = await pageDefinition("quick-note");
  const page = instantiate(definition);
  callPage(page, "onLoad");

  callPage(page, "chooseDestination", {
    currentTarget: { dataset: { scope: "unexpected" } },
  });
  assert.equal(page.data.destination, "personal");
  assert.equal(last(storage.toasts), "请选择故事归属");

  const beforeCount = storage.roomState().contributions.length;
  page.setData({
    text: "这段不能写给已经离开房间的成员。",
    textLength: 16,
    destination: "personal",
    shareTargetId: "removed-member",
  });
  callPage(page, "save");

  assert.equal(storage.roomState().contributions.length, beforeCount);
  assert.equal(page.data.saving, false);
  assert.match(last(storage.toasts) ?? "", /不在当前房间/);
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
  callPage(page, "refresh", state);

  assert.equal((page.data.identity as { id: string }).id, "owner");
  assert.equal((page.data.sharedStories as unknown[]).length, 0);

  callPage(page, "chooseIdentity", {
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

  callPage(page, "chooseIdentity", {
    currentTarget: { dataset: { id: "member-2" } },
  });
  assert.equal((page.data.sharedStories as unknown[]).length, 0);
});
