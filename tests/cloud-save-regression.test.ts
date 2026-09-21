import assert from "node:assert/strict";
import test from "node:test";
import { createContribution, personalBookSourceFingerprint } from "../miniprogram/domain/biography";
// Cloud storage remains the default; exercise both cloud boundaries and public repositories.
import { addCloudFamilyMember, appendCloudContribution as appendContributionRemoteFirst, appendCloudContributions, deleteCloudContribution as deleteContributionRemoteFirst, loadCloudRoomState as loadRoomStateRemoteFirst } from "../miniprogram/services/cloudRoomStorage";
import * as localRepository from "../miniprogram/services/roomRepository";
import { currentManuscript, makeRevision, saveManuscriptRevision } from "../miniprogram/services/manuscript";
import { ensureStoryBooks } from "../miniprogram/services/storyBooks";

// Synthetic wx I/O only: repository, cloud storage and domain code all run unmocked.
function fixture() {
  const tables = new Map<string, Map<string, any>>();
  const records = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const failures = new Set<string>(["biography_drafts:remove"]);
  const local = new Map<string, unknown>();
  records("families").set("family_fixture-user", { roomName: "测试房间" });
  records("family_members").set("owner", { familyId: "family_fixture-user", memberId: "owner", name: "测试者", relation: "自己", role: "owner", avatarText: "测" });
  const previousWx = (globalThis as any).wx;
  const previousApp = (globalThis as any).getApp;
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: true } });
  (globalThis as any).wx = {
    getStorageSync: (key: string) => local.get(key),
    setStorageSync: (key: string, value: unknown) => local.set(key, value),
    cloud: {
      callFunction: async () => ({ result: { openid: "fixture-user" } }),
      database: () => ({
        serverDate: () => new Date(),
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
                  return { data: [...records(name)].map(([id, data]) => ({ ...data, _id: id })).filter(data => Object.entries(filter).every(([key, value]) => data[key] === value)).slice(offset, offset + size) };
                },
              };
              return query;
            },
            doc: (id: string) => ({
              get: async () => { check("get"); return { data: records(name).get(id) }; },
              set: async ({ data }: any) => { check("set"); records(name).set(id, structuredClone(data)); check("ack"); },
              update: async ({ data }: any) => {
                check("update");
                const current = records(name).get(id);
                if (!current) throw new Error(`document ${id} does not exist`);
                records(name).set(id, { ...structuredClone(current), ...structuredClone(data) });
                check("ack");
              },
              remove: async () => { check("remove"); records(name).delete(id); return { stats: { removed: 1 } }; },
            }),
          };
        },
      }),
    },
  };
  return { records, failures, local, restore: () => { (globalThis as any).wx = previousWx; (globalThis as any).getApp = previousApp; } };
}

const memory = () => createContribution({ authorMemberId: "owner", authorName: "测试者", relation: "自己", text: "仅供测试的虚构记录。", scope: "personal", visibility: "private" });

test("normal loading restores existing cloud people without overwriting local-only records", async () => {
  const f = fixture();
  try {
    f.records("family_members").set("relative", { familyId: "family_fixture-user", memberId: "relative", name: "原有人物", relation: "朋友", role: "contributor", avatarText: "友", kind: "person" });
    const localOnly = { ...await loadRoomStateRemoteFirst(), members: [{ id: "local-person", name: "本机人物", relation: "自己", role: "owner", avatarText: "本" }] };
    f.local.set("shiguang-family-room-v5", localOnly);
    const state = await localRepository.loadRoomStateRemoteFirst();
    assert.ok(state.members.some(member => member.id === "relative"), "existing cloud people must be visible without importing");
    assert.deepEqual(f.local.get("shiguang-family-room-v5"), localOnly, "rollback must not overwrite local data");
    f.failures.add("family_members:get");
    await assert.rejects(localRepository.loadRoomStateRemoteFirst(), /permission denied/);
    assert.deepEqual(f.local.get("shiguang-family-room-v5"), localOnly);
  } finally { f.restore(); }
});

test("a missing storyBooks function keeps legacy cloud stories readable", async () => {
  const f = fixture();
  try {
    const item = { ...memory(), storyTitle: "仍然在的故事" };
    await appendContributionRemoteFirst(item);
    (globalThis as any).wx.cloud.callFunction = async ({ name }: { name: string }) => {
      if (name === "getOpenId") return { result: { openid: "fixture-user" } };
      throw Object.assign(new Error("cloud.callFunction:fail Error: errCode: -501000 FunctionName parameter could not be found"), {
        errCode: -501000,
        errMsg: "cloud.callFunction:fail FunctionName parameter could not be found",
      });
    };

    const state = await ensureStoryBooks();

    assert.equal(state.contributions.length, 1);
    assert.equal(state.contributions[0].storyTitle, "仍然在的故事");
    assert.equal(state.storyMigration, undefined, "read-only fallback must not pretend migration completed");
  } finally { f.restore(); }
});

test("a disabled storyBooks migration keeps legacy cloud stories readable", async () => {
  const f = fixture();
  try {
    const item = { ...memory(), storyTitle: "迁移前仍可阅读" };
    await appendContributionRemoteFirst(item);
    (globalThis as any).wx.cloud.callFunction = async ({ name, data }: { name: string; data?: { action?: string } }) => {
      if (name === "getOpenId") return { result: { openid: "fixture-user" } };
      if (name === "storyBooks" && data?.action === "state") return { result: {} };
      if (name === "storyBooks" && data?.action === "migrate") return {
        result: { error: "STORY_BOOK_ERROR", code: "MIGRATION_NOT_READY", message: "新版故事库正在准备，请保留现有内容，稍后再试" },
      };
      throw new Error("unexpected cloud function");
    };

    const state = await ensureStoryBooks();

    assert.equal(state.contributions.length, 1);
    assert.equal(state.contributions[0].storyTitle, "迁移前仍可阅读");
    assert.equal(state.storyMigration, undefined);
  } finally { f.restore(); }
});

test("legacy family shell writes preserve activated story metadata", async () => {
  const f = fixture();
  try {
    f.records("families").set("family_fixture-user", {
      roomName: "测试房间",
      ownerAccountId: "account_fixture",
      storyBooks: { version: 1, status: "active", cursor: 6, total: 6 },
    });
    (globalThis as any).wx.cloud.callFunction = async ({ name }: { name: string }) => {
      if (name === "getOpenId") return { result: { openid: "fixture-user" } };
      if (name === "storyBooks") throw Object.assign(new Error("FunctionName parameter could not be found"), { errCode: -501000 });
      throw new Error("unexpected cloud function");
    };

    await addCloudFamilyMember("旧客户端新增人物", "朋友", "person");

    const family = f.records("families").get("family_fixture-user");
    assert.equal(family.ownerAccountId, "account_fixture");
    assert.deepEqual(family.storyBooks, { version: 1, status: "active", cursor: 6, total: 6 });
  } finally { f.restore(); }
});

test("successful primary save and delete survive draft cleanup denial; retries are idempotent", async () => {
  const f = fixture();
  try {
    const item = memory();
    for (let n = 0; n < 7; n++) {
      const state = await appendContributionRemoteFirst(item);
      assert.equal(state.contributions.length, 1);
    }
    assert.equal((await loadRoomStateRemoteFirst()).contributions.length, 1);
    await deleteContributionRemoteFirst(item.id);
    await deleteContributionRemoteFirst(item.id);
    assert.equal((await loadRoomStateRemoteFirst()).contributions.length, 0);
    assert.equal(f.records("source_records").size, 0);
    assert.equal(f.local.size, 0, "cloud writes never fall through to another local dataset");
  } finally { f.restore(); }
});

test("cloud loading collapses legacy copies and deletion removes every document for one memory", async () => {
  const f = fixture();
  try {
    const item = { ...memory(), id: "memory-with-legacy-copies" };
    await appendContributionRemoteFirst(item);

    const canonicalMemory = f.records("memories").get(`family_fixture-user_${item.id}`);
    const canonicalSource = f.records("source_records").get(`src_family_fixture-user_${item.id}`);
    f.records("memories").set("legacy-random-memory-doc", structuredClone(canonicalMemory));
    f.records("source_records").set("legacy-random-source-doc", structuredClone(canonicalSource));

    const loaded = await loadRoomStateRemoteFirst();
    assert.deepEqual(loaded.contributions.map(contribution => contribution.id), [item.id],
      "one logical memory must not render once per legacy cloud document");

    await deleteContributionRemoteFirst(item.id);
    assert.equal((await loadRoomStateRemoteFirst()).contributions.length, 0);
    assert.equal(f.records("memories").size, 0, "all visible copies are removed");
    assert.equal(f.records("source_records").size, 0, "all raw copies are removed");
  } finally { f.restore(); }
});

test("a stable multi-record import resumes after a partial cloud failure", async () => {
  const f = fixture();
  try {
    const first = { ...memory(), id: "import-1", text: "第一段" };
    const second = { ...memory(), id: "import-2", text: "第二段" };
    f.failures.add("memories:set");
    await assert.rejects(appendCloudContributions([first, second]), /permission denied/);
    f.failures.delete("memories:set");
    assert.equal((await loadRoomStateRemoteFirst()).contributions.length, 0);
    await appendCloudContributions([first, second]);
    assert.deepEqual((await loadRoomStateRemoteFirst()).contributions.map(item => item.id).sort(), ["import-1", "import-2"]);
  } finally { f.restore(); }
});

test("write/read permission failure is not converted to an empty local family", async () => {
  const f = fixture();
  try {
    f.failures.add("memories:set");
    await assert.rejects(appendContributionRemoteFirst(memory()), /permission denied/);
    f.failures.add("families:get");
    await assert.rejects(loadRoomStateRemoteFirst(), /permission denied/);
    assert.equal(f.local.size, 0);
  } finally { f.restore(); }
});

test("authenticated story service restores an existing room when direct family reads are denied", async () => {
  const f = fixture();
  try {
    f.failures.add("families:get");
    (globalThis as any).wx.cloud.callFunction = async ({ name, data }: { name: string; data?: { action?: string } }) => {
      if (name === "getOpenId") return { result: { openid: "fixture-user" } };
      if (name === "storyBooks" && data?.action === "state") return {
        result: {
          roomStateVersion: 1,
          roomName: "服务端房间",
          protagonistName: "测试者",
          members: [{ id: "owner", name: "测试者", relation: "自己", role: "owner", avatarText: "测" }],
          contributions: [{ ...memory(), id: "memory-from-service", storyTitle: "仍然在的故事" }],
          stories: [{ id: "story-service", familyId: "family_fixture-user", title: "仍然在的故事", bookTitle: "仍然在的故事", writingMode: "objective", memoryIds: ["memory-from-service"], version: 1 }],
          manuscriptRevisions: [],
          deletedStories: [],
          personalDrafts: { owner: { title: "旧名字草稿" } },
          personalDraftSourceFingerprints: { owner: "outdated-fingerprint" },
          legacyPersonalDrafts: { owner: { title: "旧名字草稿" } },
          storyMigration: { version: 1, status: "active", cursor: 1, total: 1, pending: [] },
        },
      };
      throw new Error("unexpected cloud function");
    };

    const state = await loadRoomStateRemoteFirst();

    assert.equal(state.roomName, "服务端房间");
    assert.equal(state.members[0]?.name, "测试者");
    assert.equal(state.contributions[0]?.id, "memory-from-service");
    assert.equal(state.stories?.[0]?.id, "story-service");
    assert.equal(
      currentManuscript(state, "owner").draft,
      undefined,
      "a rejected versioned personal draft must not reappear through legacy fallback",
    );
  } finally { f.restore(); }
});

test("source deletion failure keeps visible record available for retry", async () => {
  const f = fixture();
  try {
    const item = memory();
    await appendContributionRemoteFirst(item);
    f.failures.add("source_records:remove");
    await assert.rejects(deleteContributionRemoteFirst(item.id), /permission denied/);
    assert.equal((await loadRoomStateRemoteFirst()).contributions.length, 1);
    f.failures.delete("source_records:remove");
    await deleteContributionRemoteFirst(item.id);
    assert.equal((await loadRoomStateRemoteFirst()).contributions.length, 0);
  } finally { f.restore(); }
});

test("cloud load includes more than twenty records and hides stale generated drafts", async () => {
  const f = fixture();
  try {
    const state = await loadRoomStateRemoteFirst();
    const fingerprint = personalBookSourceFingerprint(state, "owner");
    f.records("biography_drafts").set("old", { familyId: "family_fixture-user", draftType: "personal", memberId: "owner", sourceFingerprint: fingerprint, draft: { title: "旧稿" } });
    for (let n = 0; n < 23; n++) await appendContributionRemoteFirst(memory());
    const latest = await loadRoomStateRemoteFirst();
    assert.equal(latest.contributions.length, 23);
    assert.equal(latest.personalDrafts?.owner, undefined);
  } finally { f.restore(); }
});

test("explicit read-only import never seeds a missing cloud room", async () => {
  const f = fixture();
  try {
    f.records("families").clear();
    f.failures.add("families:set");
    const state = await loadRoomStateRemoteFirst({ readOnly: true });
    assert.equal(state.members.length, 0);
    assert.equal(f.records("families").size, 0);
    assert.equal(f.local.size, 0);
  } finally { f.restore(); }
});

test("cloud manuscripts preserve legacy versions, tolerate lost acknowledgements and reject stale editors", async () => {
  const f = fixture();
  try {
    const legacy = { title: "原来的一章", paragraphs: ["原来的虚构正文"], sourceCount: 1, generatedAt: new Date().toISOString(), generationMode: "local-demo" as const };
    f.records("biography_drafts").set("legacy-personal", { familyId: "family_fixture-user", memberId: "owner", draftType: "personal", draft: legacy });
    let state = await loadRoomStateRemoteFirst();
    assert.equal(currentManuscript(state, "owner").draft?.title, legacy.title);
    const first = makeRevision("owner", { ...legacy, title: "第一份手改稿" }, "", "draft", "编辑存档");
    f.failures.add("biography_drafts:ack");
    await assert.rejects(saveManuscriptRevision(first, ""), /permission denied/);
    f.failures.delete("biography_drafts:ack");
    state = await saveManuscriptRevision(first, "");
    assert.equal(state.manuscriptRevisions?.length, 2);
    const second = makeRevision("owner", { ...legacy, title: "第二版" }, "", "version", "第二版");
    f.failures.add("biography_drafts:ack");
    await assert.rejects(saveManuscriptRevision(second, first.id), /permission denied/);
    f.failures.delete("biography_drafts:ack");
    state = await saveManuscriptRevision(second, first.id);
    state = await saveManuscriptRevision(second, first.id);
    assert.equal(state.manuscriptRevisions?.length, 3, "no duplicate revision after acknowledgement loss");
    const stale = makeRevision("owner", legacy, "", "draft", "过期编辑器");
    await assert.rejects(saveManuscriptRevision(stale, first.id), /已有更新/);
    await localRepository.appendContributionRemoteFirst(memory());
    state = await localRepository.loadRoomStateRemoteFirst();
    assert.equal(currentManuscript(state, "owner").draft?.title, "第二版");
    const restored = makeRevision("owner", legacy, "", "restore", "恢复原稿");
    state = await saveManuscriptRevision(restored, second.id);
    assert.equal(state.manuscriptRevisions?.length, 4);
    assert.ok(state.manuscriptRevisions?.some(item => item.id === second.id));
    assert.equal(f.local.size, 0, "cloud versions never fall through to local storage");
  } finally { f.restore(); }
});

test("cloud versions keep their chapters across reload and acknowledgement loss", async () => {
  const f = fixture();
  try {
    const { draftWithChapters } = await import("../miniprogram/services/chapters");
    const draft = draftWithChapters({ title: "我的书", paragraphs: [], sourceCount: 1, generatedAt: "", generationMode: "local-demo" }, [
      { id: "chapter-1", title: "雨天", memoryIds: ["memory-a"], content: [{ text: "第一段\n" }, { photoId: "photo-a" }], handEdited: true },
      { id: "chapter-2", title: "", memoryIds: [], content: [{ text: "第二段\n" }] },
    ]);
    const revision = makeRevision("owner", draft, "", "version", "分章节");
    f.failures.add("biography_drafts:ack");
    await assert.rejects(saveManuscriptRevision(revision, ""), /permission denied/);
    f.failures.delete("biography_drafts:ack");
    await saveManuscriptRevision(revision, "");
    const state = await loadRoomStateRemoteFirst();
    assert.equal(state.manuscriptRevisions?.length, 1, "retry after a lost acknowledgement adds no copy");
    assert.deepEqual(currentManuscript(state, "owner").draft?.chapters, draft.chapters);
    const changed = { ...revision, draft: draftWithChapters(revision.draft, revision.draft.chapters!.map(item => ({ ...item, title: "改名" }))) };
    await assert.rejects(saveManuscriptRevision(changed, ""), /编号冲突/);
  } finally { f.restore(); }
});

test("cloud initialization failure blocks saving instead of silently switching datasets", async () => {
  const f = fixture();
  try {
    (globalThis as any).getApp = () => ({ globalData: { cloudReady: false } });
    await assert.rejects(localRepository.appendContributionRemoteFirst(memory()), /云端连接尚未就绪/);
    assert.equal(f.local.size, 0);
    assert.equal(f.records("memories").size, 0);
  } finally { f.restore(); }
});
