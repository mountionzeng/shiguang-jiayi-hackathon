import assert from "node:assert/strict";
import test from "node:test";

import {
  BiographyDraft,
  createContribution,
  FamilyRoomState,
  ManuscriptRevision,
  Story,
} from "../miniprogram/domain/biography";
import {
  deriveLegacyStories,
  legacyManuscriptStoryId,
  legacyTitleStoryId,
  newStoryId,
  STORY_ID,
} from "../miniprogram/services/storyRecords";
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

test("newStoryId and the legacy id functions all satisfy STORY_ID", () => {
  assert.match(newStoryId(new Date("2026-09-14T00:00:00.000Z")), STORY_ID);
  assert.match(legacyManuscriptStoryId("owner"), STORY_ID);
  assert.match(legacyTitleStoryId("外公接我放学"), STORY_ID);
});

test("a story derived from the memory pool keeps a fixed id across renames and reorderings", () => {
  const initial = createDemoRoomStateForTests();
  const id = legacyTitleStoryId("外公接我放学");

  const before = deriveLegacyStories(initial);
  assert.equal(before.find((story) => story.title === "外公接我放学")?.id, id);

  // 加一段同名记忆、换个顺序、改一下别处的数据，id 应该不变。
  const later = createContribution({
    id: "later-memory",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "后来我才知道，外公总会提前十分钟出门。",
    storyTitle: "外公接我放学",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-09-01T00:00:00.000Z"),
  });
  const changed: FamilyRoomState = { ...initial, contributions: [later, ...initial.contributions] };
  const after = deriveLegacyStories(changed);
  const story = after.find((item) => item.title === "外公接我放学");
  assert.equal(story?.id, id, "同一个故事名，id 不变");
  assert.deepEqual(new Set(story?.memoryIds), new Set(["demo-personal-rain", "later-memory"]));
});

test("a manuscript keeps its own fixed id, separate from a same-titled memory story", () => {
  const initial = createDemoRoomStateForTests();
  const state: FamilyRoomState = {
    ...initial,
    manuscriptRevisions: [revision("member-1", "我这一辈子", "2026-09-10T00:00:00.000Z")],
  };
  const stories = deriveLegacyStories(state);
  const manuscript = stories.find((story) => story.title === "我这一辈子");
  assert.equal(manuscript?.id, legacyManuscriptStoryId("member-1"));
  assert.deepEqual(manuscript?.legacy, {
    memberId: "member-1",
    storyTitle: "我这一辈子",
    previousShelfKey: "manuscript:member-1",
  });
  assert.deepEqual(manuscript?.memoryIds, []);
});

test("每个故事带着迁移前的 storyShelf key，供发到电脑端的快照做旧 key 过渡", () => {
  const initial = createDemoRoomStateForTests();
  const memoryOnly = deriveLegacyStories(initial).find((story) => story.title === "外公接我放学");
  assert.equal(memoryOnly?.legacy?.previousShelfKey, "story:外公接我放学");

  const withManuscript = deriveLegacyStories({
    ...initial,
    manuscriptRevisions: [revision("owner", "外公接我放学", "2026-09-05T00:00:00.000Z")],
  }).find((story) => story.title === "外公接我放学");
  assert.equal(withManuscript?.legacy?.previousShelfKey, "story:外公接我放学",
    "书稿并入同名记忆故事后，旧 key 仍是记忆那一份的，不换成 manuscript:");
});

test("a manuscript joining a same-named memory story keeps the memory story's id and picks up the memories", () => {
  const initial = createDemoRoomStateForTests();
  const state: FamilyRoomState = {
    ...initial,
    manuscriptRevisions: [revision("owner", "外公接我放学", "2026-09-05T00:00:00.000Z", 3)],
  };
  const before = deriveLegacyStories(createDemoRoomStateForTests());
  const merged = deriveLegacyStories(state);
  const story = merged.find((item) => item.title === "外公接我放学");
  assert.equal(story?.id, before.find((item) => item.title === "外公接我放学")?.id, "id 用记忆故事那一份，不换成书稿的");
  assert.deepEqual(story?.memoryIds, ["demo-personal-rain"], "素材记忆没有丢");
  assert.equal(story?.legacy?.memberId, "owner");
});

test("stories are ordered by which was touched most recently", () => {
  const initial = createDemoRoomStateForTests();
  const state: FamilyRoomState = {
    ...initial,
    manuscriptRevisions: [revision("member-1", "我这一辈子", "2026-09-10T00:00:00.000Z")],
  };
  const titles = deriveLegacyStories(state).map((story) => story.title);
  assert.deepEqual(titles, ["我这一辈子", "外公接我放学"], "2026-09-10 晚于记忆故事最后一次讲述");
});

test("a deleted legacy story stays hidden after this pass, whichever half of the merge it was deleted as", () => {
  const initial = createDemoRoomStateForTests();
  const deletedByMemoryKey: FamilyRoomState = {
    ...initial,
    deletedStories: [{ key: "story:外公接我放学", title: "外公接我放学", deletedAt: "2026-09-11T00:00:00.000Z" }],
  };
  assert.ok(!deriveLegacyStories(deletedByMemoryKey).some((story) => story.title === "外公接我放学"));

  const withManuscript: FamilyRoomState = {
    ...deletedByMemoryKey,
    manuscriptRevisions: [revision("owner", "外公接我放学", "2026-09-05T00:00:00.000Z")],
  };
  // 书稿并入了这个故事，旧的删除 key 仍然是 story:外公接我放学，删除状态应该继续生效。
  assert.ok(!deriveLegacyStories(withManuscript).some((story) => story.title === "外公接我放学"));
});

test("同一账号内已有的同名故事迁移时不合并，只在展示名上加编号，最近动过的留原名", () => {
  const initial = createDemoRoomStateForTests();
  const state: FamilyRoomState = {
    ...initial,
    manuscriptRevisions: [
      revision("member-1", "外公", "2026-09-01T00:00:00.000Z"),
      revision("member-2", "外公", "2026-09-12T00:00:00.000Z"),
    ],
  };
  const rows = deriveLegacyStories(state).filter((story) => story.title === "外公" || story.title === "外公（2）");
  assert.deepEqual(rows.map((story) => story.title), ["外公", "外公（2）"]);
  assert.equal(rows[0].legacy?.memberId, "member-2", "最近动过的（09-12）留原名");
  assert.equal(rows[1].legacy?.memberId, "member-1");
  // id 互不相同、各自稳定，不受重名影响。
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(rows[0].id, legacyManuscriptStoryId("member-2"));
});

test("deriveLegacyStories only reads; it writes nothing back onto the state", () => {
  const initial = createDemoRoomStateForTests();
  const before = JSON.stringify(initial);
  deriveLegacyStories(initial);
  assert.equal(JSON.stringify(initial), before);
});

test("every derived story satisfies the Story shape and its id matches STORY_ID", () => {
  const initial = createDemoRoomStateForTests();
  const state: FamilyRoomState = {
    ...initial,
    manuscriptRevisions: [revision("member-1", "我这一辈子", "2026-09-10T00:00:00.000Z")],
  };
  for (const story of deriveLegacyStories(state)) {
    const typed: Story = story;
    assert.match(typed.id, STORY_ID);
    assert.deepEqual(typed.protagonistMemberIds, []);
    assert.ok(typed.createdAt && typed.updatedAt);
  }
});
