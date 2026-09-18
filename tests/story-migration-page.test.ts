import assert from "node:assert/strict";
import test from "node:test";

import { createContribution, FamilyRoomState } from "../miniprogram/domain/biography";

const ROOM_KEY = "shiguang-family-room-v5";

test("migration confirmation appends the pending chapter once and keeps its trace", async context => {
  const state: FamilyRoomState = {
    roomName: "测试空间", protagonistName: "", members: [{ id: "owner", name: "记录者", relation: "本人", avatarText: "记", role: "owner" }],
    contributions: [createContribution({ id: "memory-a", authorMemberId: "owner", authorName: "记录者", relation: "本人", text: "旧记忆", scope: "personal", visibility: "private" })],
    personalDrafts: {},
    stories: [{ id: "story-a", familyId: "local", title: "故事 A", bookTitle: "故事 A", writingMode: "objective", version: 0, currentRevisionId: "", memoryIds: [], protagonistMemberIds: [], createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" }],
    storyMigration: { version: 1, status: "active", pending: [
      { id: "pending-a", sourceRevisionId: "legacy-a", memberId: "owner", reason: "没有明确来源记忆", chapter: { id: "legacy-chapter", title: "旧章节", memoryIds: ["memory-a"], content: [{ text: "完整保留的旧正文" }] } },
      { id: "pending-new", sourceRevisionId: "legacy-new", memberId: "owner", reason: "没有明确来源记忆", chapter: { id: "legacy-new-chapter", title: "另一个旧章节", memoryIds: ["memory-a"], content: [{ text: "放进新书的正文" }] } },
      { id: "pending-image", kind: "image", imageId: "family_local_img_req-oldimage1", reason: "这张旧图没有唯一的章节归属" },
    ] },
  };
  const stored = new Map<string, unknown>([[ROOM_KEY, state]]);
  const previousWx = Object.getOwnPropertyDescriptor(globalThis, "wx");
  const previousPage = Object.getOwnPropertyDescriptor(globalThis, "Page");
  let definition: any;
  Object.defineProperty(globalThis, "wx", { configurable: true, value: {
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: unknown) => stored.set(key, value),
  } });
  Object.defineProperty(globalThis, "Page", { configurable: true, value: (value: unknown) => { definition = value; } });
  context.after(() => {
    if (previousWx) Object.defineProperty(globalThis, "wx", previousWx); else delete (globalThis as any).wx;
    if (previousPage) Object.defineProperty(globalThis, "Page", previousPage); else delete (globalThis as any).Page;
  });
  await import("../miniprogram/pages/story-migration/story-migration");
  const page = { ...definition, data: structuredClone(definition.data), setData(update: object) { Object.assign(this.data, update); } };

  await page.refresh();
  assert.equal(page.data.pending.length, 2);
  assert.equal(page.data.pendingAssets.length, 1);
  await page.resolve("pending-a", "story-a");

  const saved = stored.get(ROOM_KEY) as FamilyRoomState;
  const story = saved.stories?.find(item => item.id === "story-a");
  const revision = saved.manuscriptRevisions?.find(item => item.id === story?.currentRevisionId);
  assert.equal(saved.storyMigration?.pending[0].resolvedStoryId, "story-a");
  assert.equal(revision?.sourceRevisionId, "legacy-a");
  assert.equal(revision?.draft.chapters?.[0].content[0].text, "完整保留的旧正文");
  assert.deepEqual(story?.memoryIds, ["memory-a"]);

  await page.createAndResolve("pending-new", "迁移中新建的故事");
  const afterCreate = stored.get(ROOM_KEY) as FamilyRoomState;
  const created = afterCreate.stories?.find(item => item.title === "迁移中新建的故事");
  const createdRevision = afterCreate.manuscriptRevisions?.find(item => item.id === created?.currentRevisionId);
  assert.ok(created);
  assert.equal(created?.writingMode, "objective");
  assert.equal(afterCreate.storyMigration?.pending[1].resolvedStoryId, created?.id);
  assert.equal(createdRevision?.sourceRevisionId, "legacy-new");
  assert.equal(createdRevision?.draft.chapters?.[0].content[0].text, "放进新书的正文");

  await page.resolveAsset("pending-image", "story-a");
  const afterAsset = stored.get(ROOM_KEY) as FamilyRoomState;
  assert.equal(afterAsset.storyMigration?.pending[2].resolvedStoryId, "story-a");
  assert.ok(afterAsset.stories?.find(item => item.id === "story-a")?.imageIds?.includes("family_local_img_req-oldimage1"));
});
