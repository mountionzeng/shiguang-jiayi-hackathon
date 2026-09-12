import assert from "node:assert/strict";
import test from "node:test";

import {
  accountOwner,
  BiographyDraft,
  createContribution,
  FamilyRoomState,
  ManuscriptRevision,
} from "../miniprogram/domain/biography";
import { shelfStoryLabel, storyShelf } from "../miniprogram/services/storyShelf";
import { createDemoRoomStateForTests } from "./fixtures";

function revision(memberId: string, title: string, savedAt: string, chapters = 1): ManuscriptRevision {
  const draft: BiographyDraft = {
    title,
    paragraphs: ["第一章　开头", "那一年我们搬进了老屋。"],
    sourceCount: 1,
    generatedAt: savedAt,
    generationMode: "local-demo",
    chapters: Array.from({ length: chapters }, (_, index) => ({
      id: `chapter-${index}`,
      title: `第${index + 1}段`,
      memoryIds: [],
      content: [{ text: index === 0 ? "那一年我们搬进了老屋。" : "后来的事。" }],
    })),
  };
  return { id: `revision-${memberId}-${savedAt}`, memberId, kind: "version", label: "保存", savedAt, sourceFingerprint: "", draft };
}

test("the account owner is the 自己 book first, then the account's first profile", () => {
  const members = createDemoRoomStateForTests().members;
  assert.equal(accountOwner(members)?.id, "owner");

  const withSelf = members.concat({ id: "self", name: "岱", relation: "自己", avatarText: "岱", role: "contributor", kind: "recording-profile" });
  assert.equal(accountOwner(withSelf)?.id, "self");

  const deletedSelf = withSelf.map((member) => member.id === "self" ? { ...member, deletedAt: "2026-09-11T00:00:00.000Z" } : member);
  assert.equal(accountOwner(deletedSelf)?.id, "owner");

  const ownerIsPerson = members.map((member) => member.id === "owner" ? { ...member, kind: "person" as const } : member);
  assert.equal(accountOwner(ownerIsPerson), undefined);
});

test("the shelf lists every named story in the memory pool, newest first, without family-review posts", () => {
  const initial = createDemoRoomStateForTests();
  const byMom = createContribution({
    id: "mom-wedding",
    authorMemberId: "member-1",
    authorName: "林秋",
    relation: "女儿",
    text: "那天下着小雨，我们骑自行车去领的证。",
    storyTitle: "爸妈的婚礼",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-09-01T00:00:00.000Z"),
  });
  const state: FamilyRoomState = { ...initial, contributions: initial.contributions.concat(byMom) };

  const shelf = storyShelf(state);
  assert.deepEqual(shelf.map((story) => story.title), ["爸妈的婚礼", "外公接我放学"]);
  assert.deepEqual(shelf[1].memoryIds, ["demo-personal-rain"]);
  assert.equal(shelfStoryLabel(shelf[0]), "1 段记忆");
  assert.equal(state.contributions.length, initial.contributions.length + 1, "reading the shelf writes nothing");
});

test("each profile's manuscript is a story, merged with the same-named story", () => {
  const initial = createDemoRoomStateForTests();
  const state: FamilyRoomState = {
    ...initial,
    manuscriptRevisions: [
      revision("owner", "外公接我放学", "2026-09-05T00:00:00.000Z", 3),
      revision("member-1", "我这一辈子", "2026-09-10T00:00:00.000Z"),
      revision("member-2", "  ", "2026-08-01T00:00:00.000Z"),
    ],
  };

  const shelf = storyShelf(state);
  assert.deepEqual(shelf.map((story) => [story.title, story.manuscriptMemberId, story.memoryIds.length]), [
    ["我这一辈子", "member-1", 0],
    ["外公接我放学", "owner", 1],
    ["还没取名的书稿", "member-2", 0],
  ]);
  assert.equal(shelfStoryLabel(shelf[1]), "已整理 3 章 · 1 段记忆");
  assert.equal(shelf[0].excerpt, "那一年我们搬进了老屋。");

  const deleted = { ...state, members: state.members.map((member) => member.id === "member-1" ? { ...member, deletedAt: "2026-09-11T00:00:00.000Z" } : member) };
  assert.ok(!storyShelf(deleted).some((story) => story.manuscriptMemberId === "member-1"), "a deleted profile's book is hidden, not removed");
  assert.equal(deleted.manuscriptRevisions?.length, 3);
});
