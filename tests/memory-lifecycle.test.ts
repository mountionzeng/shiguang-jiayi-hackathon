import assert from "node:assert/strict";
import test from "node:test";

import {
  createContribution,
  FamilyRoomState,
  isActiveMemory,
  memoryPool,
} from "../miniprogram/domain/biography";
import { planDeleteMemory, planRestoreMemory } from "../miniprogram/services/memoryLifecycle";
import { loadRoomState, restoreMemory, saveRoomState, softDeleteMemory } from "../miniprogram/services/roomStorage";
import { restoreCloudMemory, softDeleteCloudMemory } from "../miniprogram/services/cloudRoomStorage";
import {
  purgeAllDeletedMemoriesRemoteFirst,
  purgeMemoryRemoteFirst,
  restoreMemoryRemoteFirst,
  softDeleteMemoryRemoteFirst,
} from "../miniprogram/services/roomRepository";
import { recentlyDeletedItems } from "../miniprogram/services/recentlyDeleted";
import { createDemoRoomStateForTests } from "./fixtures";

const FAMILY = "family_fixture-user";

function installLocal(state: FamilyRoomState, currentMemberId = "owner") {
  const stored = new Map<string, unknown>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "wx");
  Object.defineProperty(globalThis, "wx", {
    configurable: true,
    writable: true,
    value: {
      getStorageSync: (key: string) => stored.get(key),
      setStorageSync: (key: string, value: unknown) => stored.set(key, value),
      showToast: () => undefined,
    },
  });
  saveRoomState(state);
  return () => {
    if (previous) Object.defineProperty(globalThis, "wx", previous);
    else delete (globalThis as Record<string, unknown>).wx;
  };
}

function installCloud() {
  const tables = new Map<string, Map<string, any>>();
  const records = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const local = new Map<string, unknown>();
  const previousWx = (globalThis as any).wx;
  (globalThis as any).wx = {
    getStorageSync: (key: string) => local.get(key),
    setStorageSync: (key: string, value: unknown) => local.set(key, value),
    cloud: {
      callFunction: async () => ({ result: { openid: "fixture-user" } }),
      database: () => ({
        serverDate: () => new Date(0),
        collection: (name: string) => ({
          where: (filter: Record<string, unknown>) => {
            let offset = 0;
            let size = 20;
            const query = {
              orderBy: () => query,
              skip: (n: number) => { offset = n; return query; },
              limit: (n: number) => { size = n; return query; },
              get: async () => ({
                data: [...records(name)].map(([id, data]) => ({ ...data, _id: id }))
                  .filter((data) => Object.entries(filter).every(([key, value]) => data[key] === value)).slice(offset, offset + size),
              }),
            };
            return query;
          },
          doc: (id: string) => ({
            get: async () => ({ data: records(name).get(id) }),
            set: async ({ data }: any) => { records(name).set(id, structuredClone(data)); },
            remove: async () => { records(name).delete(id); },
          }),
        }),
      }),
    },
  };
  records("families").set(FAMILY, { roomName: "测试房间" });
  // loadCloudRoomState 在没有任何家庭成员时直接返回空状态，测记忆得先有个人。
  records("family_members").set(`${FAMILY}_owner`, {
    familyId: FAMILY, memberId: "owner", name: "林岚", relation: "自己", role: "owner", avatarText: "岚",
  });
  return { records, restore: () => { (globalThis as any).wx = previousWx; } };
}

function memory(overrides: Partial<Parameters<typeof createContribution>[0]> = {}) {
  return createContribution({
    id: "memory-1",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "灶台边总有一股柴火味。",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  });
}

test("planDeleteMemory / planRestoreMemory are pure and idempotent", () => {
  const state: FamilyRoomState = { ...createDemoRoomStateForTests(), contributions: [memory()] };
  const deleted = planDeleteMemory(state, "memory-1", new Date("2026-09-16T00:00:00.000Z"));
  assert.equal(deleted?.deletedAt, "2026-09-16T00:00:00.000Z");

  const alreadyDeleted: FamilyRoomState = { ...state, contributions: [{ ...memory(), deletedAt: "2026-09-16T00:00:00.000Z" }] };
  assert.equal(planDeleteMemory(alreadyDeleted, "memory-1"), undefined, "deleting an already-deleted memory is a no-op");
  assert.equal(planRestoreMemory(state, "memory-1"), undefined, "restoring an active memory is a no-op");

  const restored = planRestoreMemory(alreadyDeleted, "memory-1");
  assert.equal(restored?.deletedAt, undefined);
  assert.throws(() => planDeleteMemory(state, "missing"), /没有找到这段记忆/);
});

test("soft-deleted memories fail closed out of every normal listing, and restore brings them back", () => {
  const restore = installLocal({ ...createDemoRoomStateForTests(), contributions: [memory()] });
  try {
    const before = memoryPool(loadRoomState().contributions);
    assert.equal(before.length, 1);

    const afterDelete = softDeleteMemory("memory-1");
    assert.equal(memoryPool(afterDelete.contributions).length, 0, "hidden from the shared pool");
    assert.equal(isActiveMemory(afterDelete.contributions[0]), false);
    // 已删除但仍在 contributions 数组里，供「最近删除」读取。
    assert.equal(afterDelete.contributions.length, 1);

    const afterRestore = restoreMemory("memory-1");
    assert.equal(memoryPool(afterRestore.contributions).length, 1);
    assert.equal(afterRestore.contributions[0].deletedAt, undefined);
  } finally { restore(); }
});

test("cloud soft-delete writes deletedAt, round-trips through loadCloudRoomState, and restore clears it", async () => {
  const cloud = installCloud();
  try {
    const { appendCloudContribution, loadCloudRoomState } = await import("../miniprogram/services/cloudRoomStorage");
    await appendCloudContribution(memory());

    const deleted = await softDeleteCloudMemory("memory-1", new Date("2026-09-16T00:00:00.000Z"));
    assert.equal(deleted.contributions[0].deletedAt, "2026-09-16T00:00:00.000Z");
    assert.equal(cloud.records("memories").get(`${FAMILY}_memory-1`).deletedAt, "2026-09-16T00:00:00.000Z");

    const reloaded = await loadCloudRoomState();
    assert.equal(reloaded.contributions[0].deletedAt, "2026-09-16T00:00:00.000Z", "deletedAt survives a reload");
    assert.equal(memoryPool(reloaded.contributions).length, 0);

    const restored = await restoreCloudMemory("memory-1");
    assert.equal(restored.contributions[0].deletedAt, undefined);
    assert.equal(cloud.records("memories").get(`${FAMILY}_memory-1`).deletedAt, undefined, ".set() drops the field entirely, not just clears it locally");
  } finally { cloud.restore(); }
});

test("cloud round-trip also keeps a memory's segments (regression: they were missing from the cloud write/read)", async () => {
  const cloud = installCloud();
  try {
    const { appendMemorySegment } = await import("../miniprogram/domain/biography");
    const { appendCloudContribution, loadCloudRoomState } = await import("../miniprogram/services/cloudRoomStorage");
    const grown = appendMemorySegment(memory(), "又想起一件事。", "continue", undefined, new Date("2026-09-08T00:00:00.000Z"));
    await appendCloudContribution(grown);
    const reloaded = await loadCloudRoomState();
    assert.equal(reloaded.contributions[0].segments?.length, 2);
    assert.equal(reloaded.contributions[0].segments?.[1].text, "又想起一件事。");
  } finally { cloud.restore(); }
});

test("recentlyDeletedItems combines stories and memories, newest deletion first", () => {
  const state: FamilyRoomState = {
    ...createDemoRoomStateForTests(),
    contributions: [
      { ...memory({ id: "memory-a" }), deletedAt: "2026-09-16T09:00:00.000Z" },
      { ...memory({ id: "memory-b" }), deletedAt: "2026-09-16T11:00:00.000Z" },
      memory({ id: "memory-c" }), // active, should not appear
    ],
    deletedStories: [{ key: "story:外公", title: "外公", deletedAt: "2026-09-16T10:00:00.000Z" }],
  };
  const items = recentlyDeletedItems(state);
  assert.deepEqual(items.map((item) => [item.type, item.id]), [
    ["memory", "memory-b"],
    ["story", "story:外公"],
    ["memory", "memory-a"],
  ]);
  assert.equal(items[0].title, "灶台边总有一股柴火味");
});

test("softDeleteMemoryRemoteFirst / restoreMemoryRemoteFirst go through the local path when there is no cloud", async () => {
  const restore = installLocal({ ...createDemoRoomStateForTests(), contributions: [memory()] });
  try {
    const deleted = await softDeleteMemoryRemoteFirst("memory-1");
    assert.equal(deleted.contributions[0].deletedAt !== undefined, true);
    const restored = await restoreMemoryRemoteFirst("memory-1");
    assert.equal(restored.contributions[0].deletedAt, undefined);
  } finally { restore(); }
});

test("purgeMemoryRemoteFirst really removes the memory; purgeAllDeletedMemoriesRemoteFirst clears every soft-deleted one and leaves active memories alone", async () => {
  const restore = installLocal({
    ...createDemoRoomStateForTests(),
    contributions: [memory({ id: "memory-a" }), memory({ id: "memory-b" }), memory({ id: "memory-c" })],
  });
  try {
    await softDeleteMemoryRemoteFirst("memory-a");
    let state = await softDeleteMemoryRemoteFirst("memory-b");
    assert.equal(state.contributions.length, 3, "still present, just hidden");

    state = await purgeMemoryRemoteFirst("memory-a");
    assert.equal(state.contributions.some((item) => item.id === "memory-a"), false, "永久删除，真的没了");
    assert.equal(state.contributions.length, 2);

    state = await purgeAllDeletedMemoriesRemoteFirst();
    assert.deepEqual(state.contributions.map((item) => item.id), ["memory-c"], "只清掉软删除的，活跃的记忆留着");
  } finally { restore(); }
});
