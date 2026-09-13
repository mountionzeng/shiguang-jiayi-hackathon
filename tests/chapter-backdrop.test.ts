import assert from "node:assert/strict";
import test from "node:test";

import { BiographyDraft, FamilyRoomState } from "../miniprogram/domain/biography";
import { withChapterBackdrop, saveChapterBackdrop } from "../miniprogram/services/chapterBackdrop";
import { draftWithChapters, validateChapters } from "../miniprogram/services/chapters";
import { currentManuscript, makeRevision, manuscriptHistory, saveManuscriptRevision } from "../miniprogram/services/manuscript";
import { loadRoomStateRemoteFirst } from "../miniprogram/services/roomRepository";
import { createDemoRoomStateForTests } from "./fixtures";

const ROOM_KEY = "shiguang-family-room-v5";
const CURRENT_MEMBER_KEY = "shiguang-current-member-v1";
const BACKDROP = "family_o-owner_img_req-mf1abcd-12345678";

function bookState(): FamilyRoomState {
  const state = createDemoRoomStateForTests();
  const base: BiographyDraft = { title: "外婆的书", paragraphs: [], sourceCount: 0, generatedAt: "2026-09-13T00:00:00.000Z", generationMode: "local-demo" };
  const draft = draftWithChapters(base, [
    { id: "chapter-a", title: "老院子", memoryIds: [], content: [{ text: "院子里晒着被子。\n" }], handEdited: true },
    { id: "chapter-b", title: "", memoryIds: [], content: [{ text: "第二章。\n" }] },
  ]);
  state.manuscriptRevisions = [makeRevision("owner", draft, "", "draft", "编辑存档")];
  return state;
}

function installLocalRoom(state: FamilyRoomState) {
  const stored = new Map<string, unknown>([[ROOM_KEY, state], [CURRENT_MEMBER_KEY, "owner"]]);
  const previousWx = Object.getOwnPropertyDescriptor(globalThis, "wx");
  const previousApp = Object.getOwnPropertyDescriptor(globalThis, "getApp");
  Object.defineProperty(globalThis, "wx", {
    configurable: true, writable: true,
    value: { getStorageSync: (key: string) => stored.get(key), setStorageSync: (key: string, value: unknown) => stored.set(key, value) },
  });
  Object.defineProperty(globalThis, "getApp", { configurable: true, writable: true, value: () => ({ globalData: { cloudReady: false } }) });
  return () => {
    if (previousWx) Object.defineProperty(globalThis, "wx", previousWx); else delete (globalThis as Record<string, unknown>).wx;
    if (previousApp) Object.defineProperty(globalThis, "getApp", previousApp); else delete (globalThis as Record<string, unknown>).getApp;
  };
}

test("设置底图只改这一章的底图，正文、章名、亲手改过的标记和其他章都不动", () => {
  const chapters = currentManuscript(bookState(), "owner").draft!.chapters!;
  const next = withChapterBackdrop(chapters, "chapter-a", BACKDROP);
  assert.equal(next[0].backdropImageId, BACKDROP);
  assert.deepEqual(next[0].content, chapters[0].content);
  assert.equal(next[0].title, "老院子");
  assert.equal(next[0].handEdited, true);
  assert.equal(next[1].backdropImageId, undefined);
  assert.equal(chapters[0].backdropImageId, undefined, "原数组不被修改");
  assert.equal("backdropImageId" in withChapterBackdrop(next, "chapter-a", "")[0], false);
  assert.throws(() => withChapterBackdrop(chapters, "chapter-x", BACKDROP), /没找到这一章/);
  assert.throws(() => withChapterBackdrop(chapters, "chapter-a", "../../secret"), /底图引用无效/);
});

test("书稿校验拒绝格式不对的底图引用", () => {
  const chapter = { id: "chapter-a", title: "", memoryIds: [], content: [] };
  assert.doesNotThrow(() => validateChapters([{ ...chapter, backdropImageId: BACKDROP }]));
  assert.throws(() => validateChapters([{ ...chapter, backdropImageId: "https://evil.example/x.png" }]), /底图引用无效/);
  assert.throws(() => validateChapters([{ ...chapter, backdropImageId: 42 }]), /底图引用无效/);
});

test("选底图存成新版本，恢复旧版本时底图也回到当时；选同一张不重复存", async context => {
  context.after(installLocalRoom(bookState()));
  let state = await saveChapterBackdrop({ memberId: "owner", chapterId: "chapter-a", imageId: BACKDROP });
  const history = manuscriptHistory(state, "owner");
  assert.equal(history.length, 2);
  assert.equal(history[0].label, "设置本章底图");
  assert.equal(currentManuscript(state, "owner").draft!.chapters![0].backdropImageId, BACKDROP);
  assert.equal(history[1].draft.chapters![0].backdropImageId, undefined, "旧版本里没有底图");

  state = await saveChapterBackdrop({ memberId: "owner", chapterId: "chapter-a", imageId: BACKDROP });
  assert.equal(manuscriptHistory(state, "owner").length, 2);

  state = await saveChapterBackdrop({ memberId: "owner", chapterId: "chapter-a", imageId: "" });
  assert.equal(manuscriptHistory(state, "owner")[0].label, "不用本章底图");
  assert.equal(currentManuscript(state, "owner").draft!.chapters![0].backdropImageId, undefined);
  const reloaded = await loadRoomStateRemoteFirst();
  assert.equal(manuscriptHistory(reloaded, "owner").length, 3);
});

test("同一个版本号重试时，只换了底图也算内容不同，不会被当成已经保存", async context => {
  context.after(installLocalRoom(bookState()));
  const before = currentManuscript(await loadRoomStateRemoteFirst(), "owner");
  const chapters = withChapterBackdrop(before.draft!.chapters!, "chapter-a", BACKDROP);
  const revision = makeRevision("owner", draftWithChapters(before.draft!, chapters), "", "draft", "设置本章底图");
  await saveManuscriptRevision(revision, before.revisionId);
  const other = structuredClone(revision);
  other.draft.chapters![0].backdropImageId = "family_o-owner_img_req-mf1abcd-87654321";
  await assert.rejects(saveManuscriptRevision(other, before.revisionId), /保存编号冲突/);
});

test("书稿页打开别处保存过的旧版本时拒绝覆盖，底图保存遵守同样规则", async context => {
  context.after(installLocalRoom(bookState()));
  const stale = currentManuscript(await loadRoomStateRemoteFirst(), "owner");
  await saveChapterBackdrop({ memberId: "owner", chapterId: "chapter-b", imageId: BACKDROP });
  const edit = makeRevision("owner", stale.draft!, "", "draft", "编辑存档");
  await assert.rejects(saveManuscriptRevision(edit, stale.revisionId), /已有更新的书稿/);
});
