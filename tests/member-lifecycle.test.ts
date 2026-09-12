import assert from "node:assert/strict";
import test from "node:test";

import {
  createContribution,
  FamilyRoomState,
  isPerson,
  isRecordingProfile,
  memoryPool,
  needsClassification,
} from "../miniprogram/domain/biography";
import {
  addFamilyMember,
  appendContribution,
  classifyMember,
  deleteMember,
  loadCurrentMember,
  loadRoomState,
  restoreMember,
  saveCurrentMemberId,
  saveRoomState,
} from "../miniprogram/services/roomStorage";
import {
  appendCloudContribution,
  classifyCloudMember,
  deleteCloudMember,
  loadCloudRoomState,
  restoreCloudMember,
} from "../miniprogram/services/cloudRoomStorage";
import { currentManuscript, makeRevision } from "../miniprogram/services/manuscript";
import { createDemoRoomStateForTests } from "./fixtures";

function installLocal(state: FamilyRoomState, currentMemberId = "owner") {
  const stored = new Map<string, unknown>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "wx");
  Object.defineProperty(globalThis, "wx", {
    configurable: true,
    writable: true,
    value: {
      getStorageSync: (key: string) => stored.get(key),
      setStorageSync: (key: string, value: unknown) => stored.set(key, value),
    },
  });
  saveRoomState(state);
  saveCurrentMemberId(currentMemberId);
  return () => {
    if (previous) Object.defineProperty(globalThis, "wx", previous);
    else delete (globalThis as Record<string, unknown>).wx;
  };
}

/** Two recording profiles, one person, one legacy record; 林秋 has a book and told one memory. */
function stateWithBook(): FamilyRoomState {
  const state = createDemoRoomStateForTests();
  state.members = state.members.map((member) =>
    member.id === "owner" || member.id === "member-1" ? { ...member, kind: "recording-profile" as const }
      : member.id === "friend-1" ? { ...member, kind: "person" as const } : member);
  state.contributions.push(createContribution({
    id: "told-by-qiu", authorMemberId: "member-1", authorName: "林秋", relation: "女儿",
    text: "林秋讲的一段虚构记忆。", scope: "personal", visibility: "private",
    relatedMemberIds: ["friend-1", "member-2"], sharedWithMemberIds: ["friend-1", "owner"],
  }));
  state.manuscriptRevisions = [makeRevision("member-1", {
    title: "林秋的书", paragraphs: ["虚构正文"], sourceCount: 1, generatedAt: "", generationMode: "local-demo",
  }, "", "version", "第一版")];
  return state;
}

test("legacy records are sorted by changing only their kind", () => {
  const restore = installLocal(createDemoRoomStateForTests());
  try {
    const before = loadRoomState().members.find((member) => member.id === "member-2")!;
    assert.ok(needsClassification(before));
    const after = classifyMember("member-2", "person").members.find((member) => member.id === "member-2")!;
    assert.deepEqual(after, { ...before, kind: "person" });
    assert.ok(isPerson(after) && !isRecordingProfile(after), "a person leaves the profile switcher");
    classifyMember("member-2", "person");
    assert.throws(() => classifyMember("member-2", "recording-profile"), /只能给旧版数据归类/);
    assert.throws(() => classifyMember("owner", "person"), /这是你自己/);
    assert.equal(loadRoomState().members.find((member) => member.id === "owner")?.kind, undefined);
  } finally { restore(); }
});

test("deleting a profile hides it and its book, keeps its memories in the shared pool, and restores both", () => {
  const restore = installLocal(stateWithBook());
  try {
    const before = loadRoomState();
    const deleted = deleteMember("member-1", undefined, new Date("2026-09-11T08:00:00.000Z"));
    const member = deleted.members.find((item) => item.id === "member-1")!;
    assert.equal(member.deletedAt, "2026-09-11T08:00:00.000Z");
    assert.ok(!isRecordingProfile(member));
    assert.deepEqual(deleted.manuscriptRevisions, before.manuscriptRevisions, "the book is hidden, not removed");
    assert.equal(deleted.contributions.length, before.contributions.length);
    assert.ok(memoryPool(deleted.contributions).some((memory) => memory.id === "told-by-qiu"));
    saveCurrentMemberId("member-1");
    assert.notEqual(loadCurrentMember(loadRoomState()).id, "member-1", "a deleted profile is never the active one");
    saveCurrentMemberId("owner");

    const restored = restoreMember("member-1");
    assert.deepEqual(restored.members.find((item) => item.id === "member-1"), before.members.find((item) => item.id === "member-1"));
    assert.equal(currentManuscript(restored, "member-1").draft?.title, "林秋的书");
    assert.deepEqual(restoreMember("member-1"), restored, "restoring twice is a no-op");
  } finally { restore(); }
});

test("the active profile cannot be deleted and nothing is written", () => {
  const restore = installLocal(stateWithBook(), "member-1");
  try {
    const before = structuredClone(loadRoomState());
    assert.throws(() => deleteMember("member-1"), /这是你自己，不能删除/);
    assert.deepEqual(loadRoomState(), before);
  } finally { restore(); }
});

test("deleting a person clears only that person from related people and readers; retries are idempotent", () => {
  const restore = installLocal(stateWithBook());
  try {
    const first = deleteMember("friend-1", undefined, new Date("2026-09-11T08:00:00.000Z"));
    const memory = first.contributions.find((item) => item.id === "told-by-qiu")!;
    assert.deepEqual(memory.relatedMemberIds, ["member-2"]);
    assert.deepEqual(memory.sharedWithMemberIds, ["owner"]);
    assert.equal(memory.text, "林秋讲的一段虚构记忆。");
    assert.deepEqual(deleteMember("friend-1", undefined, new Date("2026-09-12T08:00:00.000Z")), first);
    assert.throws(() => addFamilyMember("周明", "朋友", loadRoomState(), "person"), /最近删除/);
    assert.throws(() => appendContribution(createContribution({
      authorMemberId: "owner", authorName: "林岚", relation: "自己", text: "提到已删除亲友的虚构记忆。",
      scope: "personal", visibility: "private", relatedMemberIds: ["friend-1"],
    })), /已离开空间/);
  } finally { restore(); }
});

const FAMILY = "family_fixture-user";

// Synthetic wx cloud I/O; storage and domain code run unmocked.
function installCloud() {
  const tables = new Map<string, Map<string, any>>();
  const records = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const failures = new Set<string>();
  const local = new Map<string, unknown>();
  const previousWx = (globalThis as any).wx;
  (globalThis as any).wx = {
    getStorageSync: (key: string) => local.get(key),
    setStorageSync: (key: string, value: unknown) => local.set(key, value),
    cloud: {
      callFunction: async () => ({ result: { openid: "fixture-user" } }),
      database: () => ({
        serverDate: () => new Date(0),
        collection: (name: string) => {
          const check = (op: string) => { if (failures.has(`${name}:${op}`)) throw new Error(`permission denied: ${name}:${op}`); };
          return {
            where: (filter: Record<string, unknown>) => {
              let offset = 0;
              let size = 20;
              const query = {
                orderBy: () => query,
                skip: (n: number) => { offset = n; return query; },
                limit: (n: number) => { size = n; return query; },
                get: async () => {
                  check("get");
                  return { data: [...records(name)].map(([id, data]) => ({ ...data, _id: id }))
                    .filter((data) => Object.entries(filter).every(([key, value]) => data[key] === value)).slice(offset, offset + size) };
                },
              };
              return query;
            },
            doc: (id: string) => ({
              get: async () => { check("get"); return { data: records(name).get(id) }; },
              set: async ({ data }: any) => { check("set"); records(name).set(id, structuredClone(data)); },
              remove: async () => { check("remove"); records(name).delete(id); },
            }),
          };
        },
      }),
    },
  };
  records("families").set(FAMILY, { roomName: "测试房间" });
  const seed = (id: string, name: string, kind?: string) => records("family_members").set(`${FAMILY}_${id}`, {
    familyId: FAMILY, memberId: id, name, relation: "自己", role: "owner", avatarText: name.slice(0, 1), ...(kind ? { kind } : {}),
  });
  return { records, failures, local, seed, restore: () => { (globalThis as any).wx = previousWx; } };
}

test("cloud delete writes references before the member, survives a failed write, and restores", async () => {
  const cloud = installCloud();
  try {
    cloud.seed("owner", "测试者", "recording-profile");
    cloud.seed("friend", "测试朋友", "person");
    await appendCloudContribution(createContribution({
      id: "memory-a", authorMemberId: "owner", authorName: "测试者", relation: "自己", text: "虚构记录。",
      scope: "personal", visibility: "private", relatedMemberIds: ["friend"], sharedWithMemberIds: ["friend"],
    }));
    cloud.failures.add("family_members:set");
    await assert.rejects(deleteCloudMember("friend"), /permission denied/);
    let state = await loadCloudRoomState();
    assert.equal(state.members.find((member) => member.id === "friend")?.deletedAt, undefined, "a failed delete never reports the person gone");

    cloud.failures.delete("family_members:set");
    state = await deleteCloudMember("friend", new Date("2026-09-11T08:00:00.000Z"));
    assert.equal(state.members.find((member) => member.id === "friend")?.deletedAt, "2026-09-11T08:00:00.000Z");
    await deleteCloudMember("friend", new Date("2026-09-12T08:00:00.000Z"));
    state = await loadCloudRoomState();
    assert.equal(state.members.find((member) => member.id === "friend")?.deletedAt, "2026-09-11T08:00:00.000Z");
    assert.deepEqual(state.contributions.map((memory) => [memory.id, memory.relatedMemberIds, memory.sharedWithMemberIds]), [["memory-a", [], []]]);
    await assert.rejects(deleteCloudMember("owner"), /这是你自己，不能删除/);

    await restoreCloudMember("friend");
    assert.equal(cloud.records("family_members").get(`${FAMILY}_friend`).deletedAt, undefined);
    assert.equal((await loadCloudRoomState()).members.find((member) => member.id === "friend")?.deletedAt, undefined);
    assert.equal(cloud.local.size, 0, "cloud member changes never fall through to local storage");
  } finally { cloud.restore(); }
});

test("cloud classification changes only the kind of a legacy record", async () => {
  const cloud = installCloud();
  try {
    cloud.seed("owner", "测试者", "recording-profile");
    cloud.seed("legacy", "旧档案");
    const before = cloud.records("family_members").get(`${FAMILY}_legacy`);
    await classifyCloudMember("legacy", "person");
    const { updatedAt: _updatedAt, ...after } = cloud.records("family_members").get(`${FAMILY}_legacy`);
    assert.deepEqual(after, { ...before, id: "legacy", kind: "person" });
  } finally { cloud.restore(); }
});
