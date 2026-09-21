import assert from "node:assert/strict";
import test from "node:test";

import {
  biographySourceFingerprint,
  createContribution,
  FamilyRoomState,
  isPerson,
  isRecordingProfile,
  memoryPool,
  needsClassification,
  personalBookSourceFingerprint,
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
  updateMember,
} from "../miniprogram/services/roomStorage";
import {
  addCloudFamilyMember,
  appendCloudContribution,
  classifyCloudMember,
  deleteCloudMember,
  loadCloudRoomState,
  restoreCloudMember,
  updateCloudMember,
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

test("editing a member preserves its stable id and updates denormalized memory attribution", () => {
  const restore = installLocal(stateWithBook());
  try {
    const before = loadRoomState();
    const beforeFingerprint = personalBookSourceFingerprint(before, "member-1");
    const next = updateMember("member-1", " 林小秋 ", " 妈妈 ");
    const member = next.members.find((item) => item.id === "member-1")!;
    const memory = next.contributions.find((item) => item.id === "told-by-qiu")!;
    assert.deepEqual({ id: member.id, name: member.name, relation: member.relation, role: member.role, kind: member.kind }, {
      id: "member-1", name: "林小秋", relation: "妈妈", role: "contributor", kind: "recording-profile",
    });
    assert.deepEqual({ id: memory.id, text: memory.text, authorName: memory.authorName, relation: memory.relation }, {
      id: "told-by-qiu", text: "林秋讲的一段虚构记忆。", authorName: "林小秋", relation: "妈妈",
    });
    assert.equal(next.draft, undefined, "family prose with the old attribution is invalidated");
    assert.notEqual(
      personalBookSourceFingerprint(next, "member-1"),
      beforeFingerprint,
      "a personal draft generated with the old narrator name becomes stale",
    );
    assert.throws(() => updateMember("member-1", "周明", "朋友"), /已经有这个名字/);
    assert.throws(() => updateMember("member-1", "", "朋友"), /请填写名字/);
    assert.deepEqual(before.manuscriptRevisions, next.manuscriptRevisions, "saved book versions stay untouched");
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
    // 模拟尚未部署 memberDelete/memberRestore 的旧版 storyBooks：服务端回「不支持的故事操作」，
    // 客户端应当回退到本地改法。这条回退路径的安全性正是本用例要守住的。
    (globalThis as any).wx.cloud.callFunction = async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
      if (name === "getOpenId") return { result: { openid: "fixture-user" } };
      if (name === "storyBooks" && data?.action === "state") return { result: {} };
      if (name === "storyBooks") return { result: { error: "STORY_BOOK_ERROR", message: "不支持的故事操作" } };
      throw new Error(`unexpected cloud function ${name}`);
    };
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

test("creating the first cloud book uses the server action and never overwrites the family record", async () => {
  const cloud = installCloud();
  try {
    const familyBefore = structuredClone(cloud.records("families").get(FAMILY));
    cloud.failures.add("families:set");
    (globalThis as any).wx.cloud.callFunction = async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
      if (name === "getOpenId") return { result: { openid: "fixture-user" } };
      if (name !== "storyBooks") throw new Error(`unexpected cloud function ${name}`);
      if (data?.action === "state") {
        const members = [...cloud.records("family_members").values()].map((member) => ({ ...member, id: member.memberId }));
        return { result: { roomStateVersion: 1, roomName: "测试房间", protagonistName: "", members, contributions: [], stories: [],
          manuscriptRevisions: [], deletedStories: [], personalDrafts: {}, personalDraftSourceFingerprints: {} } };
      }
      if (data?.action === "memberAdd") {
        cloud.records("family_members").set(`${FAMILY}_${data.memberId}`, {
          familyId: FAMILY, memberId: data.memberId, name: data.name, relation: data.relation,
          role: "owner", avatarText: String(data.name).slice(0, 1), kind: data.kind,
        });
        return { result: { ok: true } };
      }
      throw new Error(`unexpected story action ${String(data?.action)}`);
    };

    const state = await addCloudFamilyMember("测试者", "", "recording-profile");

    assert.deepEqual(state.members.map((member) => [member.id, member.name, member.relation]), [["owner", "测试者", "自己"]]);
    assert.deepEqual(cloud.records("families").get(FAMILY), familyBefore);
  } finally { cloud.restore(); }
});

test("versioned story state and member actions fail closed on malformed service responses", async () => {
  const cloud = installCloud();
  try {
    cloud.seed("owner", "测试者", "recording-profile");
    cloud.seed("friend", "旧名字", "person");
    (globalThis as any).wx.cloud.callFunction = async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
      if (name === "getOpenId") return { result: { openid: "fixture-user" } };
      if (name === "storyBooks" && data?.action === "state") return { result: { roomStateVersion: 1 } };
      throw new Error(`unexpected cloud function ${name}`);
    };
    await assert.rejects(loadCloudRoomState(), /故事服务返回不完整/);

    (globalThis as any).wx.cloud.callFunction = async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
      if (name === "getOpenId") return { result: { openid: "fixture-user" } };
      if (name === "storyBooks" && data?.action === "state") return { result: {} };
      if (name === "storyBooks" && data?.action === "memberUpdate") return { result: {} };
      throw new Error(`unexpected cloud function ${name}`);
    };
    await assert.rejects(updateCloudMember("friend", "新名字", "老朋友"), /无效响应/);
    assert.equal(cloud.records("family_members").get(`${FAMILY}_friend`).name, "旧名字");
  } finally { cloud.restore(); }
});

test("cloud member editing writes attribution before the member and survives reload", async () => {
  const cloud = installCloud();
  try {
    cloud.seed("owner", "测试者", "recording-profile");
    cloud.seed("friend", "旧名字", "person");
    await appendCloudContribution(createContribution({
      id: "memory-by-friend", authorMemberId: "friend", authorName: "旧名字", relation: "自己",
      text: "一段不会被改写的虚构记忆。", scope: "personal", visibility: "private",
    }));
    const memoryBefore = cloud.records("memories").get(`${FAMILY}_memory-by-friend`);
    cloud.records("memories").set(`${FAMILY}_memory-by-friend`, {
      ...memoryBefore, scope: "family", visibility: "family", reviewStatus: "confirmed",
    });
    const beforeRename = await loadCloudRoomState();
    cloud.records("biography_drafts").set(`${FAMILY}_family`, {
      familyId: FAMILY,
      draftType: "family",
      draft: { title: "旧署名书稿", paragraphs: ["不应继续展示"] },
      sourceFingerprint: biographySourceFingerprint(beforeRename),
    });
    cloud.failures.add("family_members:set");
    (globalThis as any).wx.cloud.callFunction = async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
      if (name === "getOpenId") return { result: { openid: "fixture-user" } };
      if (name === "storyBooks" && data?.action === "state") return { result: {} };
      if (name === "storyBooks" && data?.action === "memberUpdate") {
        const member = cloud.records("family_members").get(`${FAMILY}_friend`);
        cloud.records("family_members").set(`${FAMILY}_friend`, { ...member, name: data.name, relation: data.relation, avatarText: "新" });
        const memory = cloud.records("memories").get(`${FAMILY}_memory-by-friend`);
        cloud.records("memories").set(`${FAMILY}_memory-by-friend`, { ...memory, authorName: data.name, relation: data.relation });
        return { result: { ok: true } };
      }
      throw new Error(`unexpected cloud function ${name}`);
    };
    const state = await updateCloudMember("friend", "新名字", "老朋友");
    assert.equal(state.members.find((member) => member.id === "friend")?.name, "新名字");
    assert.equal(state.draft, undefined, "a draft generated with the old attribution is hidden after rename");
    const reloaded = await loadCloudRoomState();
    assert.deepEqual(
      reloaded.contributions.map((memory) => [memory.id, memory.authorName, memory.relation, memory.text]),
      [["memory-by-friend", "新名字", "老朋友", "一段不会被改写的虚构记忆。"]],
    );
  } finally { cloud.restore(); }
});

/*
 * 云函数创建的人物文档没有客户端 _openid，客户端直写会被权限规则挡掉：
 * 界面上看得见、却永远删不掉，只反复提示「删除没有完成，请重试」。
 * 2026-09-21 实测：真实房间 3 个人物，客户端只读得到 1 个。
 * 所以删除必须优先走服务端动作。
 */
test("人物删除优先走服务端，客户端直写被权限挡住也能删成功", async () => {
  const cloud = installCloud();
  try {
    cloud.seed("owner", "测试者", "recording-profile");
    cloud.seed("friend", "测试朋友", "person");
    const calls: string[] = [];
    (globalThis as any).wx.cloud.callFunction = async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
      if (name === "getOpenId") return { result: { openid: "fixture-user" } };
      if (name === "storyBooks" && data?.action === "state") return { result: {} };
      if (name === "storyBooks" && data?.action === "memberDelete") {
        calls.push("memberDelete");
        const member = cloud.records("family_members").get(`${FAMILY}_friend`);
        cloud.records("family_members").set(`${FAMILY}_friend`, { ...member, deletedAt: "2026-09-21T00:00:00.000Z" });
        return { result: { ok: true } };
      }
      throw new Error(`unexpected cloud function ${name}`);
    };
    // 线上就是这样：客户端对这些文档没有写权限。
    cloud.failures.add("family_members:set");

    const state = await deleteCloudMember("friend");

    assert.deepEqual(calls, ["memberDelete"], "必须调用服务端动作，而不是客户端直写");
    assert.equal(cloud.records("family_members").get(`${FAMILY}_friend`).deletedAt, "2026-09-21T00:00:00.000Z");
    assert.equal(state.members.find((member) => member.id === "friend")?.deletedAt, "2026-09-21T00:00:00.000Z");
  } finally { cloud.restore(); }
});
