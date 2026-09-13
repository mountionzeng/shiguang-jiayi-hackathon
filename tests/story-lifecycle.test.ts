import assert from "node:assert/strict";
import test from "node:test";

import { createContribution } from "../miniprogram/domain/biography";
import { createDemoRoomStateForTests } from "./fixtures";
import { planDeleteStory, planRestoreStory } from "../miniprogram/services/storyLifecycle";
import { storyShelf } from "../miniprogram/services/storyShelf";

test("deleting a story hides it without deleting memories, and restoring brings it back", () => {
  const state = createDemoRoomStateForTests();
  const originalMemoryIds = state.contributions.map((memory) => memory.id);

  const deleted = planDeleteStory(
    state,
    "story:外公接我放学",
    "外公接我放学",
    new Date("2026-09-13T00:00:00.000Z"),
  );

  assert.ok(!storyShelf(deleted).some((story) => story.key === "story:外公接我放学"));
  assert.deepEqual(deleted.contributions.map((memory) => memory.id), originalMemoryIds);
  assert.equal(deleted.deletedStories?.[0]?.title, "外公接我放学");

  const restored = planRestoreStory(deleted, "story:外公接我放学");
  assert.ok(storyShelf(restored).some((story) => story.key === "story:外公接我放学"));
  assert.deepEqual(restored.contributions.map((memory) => memory.id), originalMemoryIds);
});

test("deleting a manuscript-only story preserves every saved version", () => {
  const state = createDemoRoomStateForTests();
  state.manuscriptRevisions = [{
    id: "revision-test",
    memberId: "member-1",
    kind: "version",
    label: "测试版本",
    savedAt: "2026-09-13T00:00:00.000Z",
    sourceFingerprint: "",
    draft: {
      title: "林秋的书",
      paragraphs: ["测试正文"],
      sourceCount: 0,
      generatedAt: "2026-09-13T00:00:00.000Z",
      generationMode: "local-demo",
    },
  }];

  const deleted = planDeleteStory(state, "manuscript:member-1", "林秋的书");
  assert.ok(!storyShelf(deleted).some((story) => story.key === "manuscript:member-1"));
  assert.deepEqual(deleted.manuscriptRevisions, state.manuscriptRevisions);
});

test("a deleted manuscript stays hidden when same-named memories appear or disappear", () => {
  const state = createDemoRoomStateForTests();
  state.manuscriptRevisions = [{
    id: "revision-stable-delete",
    memberId: "member-1",
    kind: "version",
    label: "测试版本",
    savedAt: "2026-09-13T00:00:00.000Z",
    sourceFingerprint: "",
    draft: {
      title: "外婆的院子",
      paragraphs: ["院子里的桂花开了。"],
      sourceCount: 0,
      generatedAt: "2026-09-13T00:00:00.000Z",
      generationMode: "local-demo",
    },
  }];
  const deleted = planDeleteStory(state, "manuscript:member-1", "外婆的院子");
  const withSameName = {
    ...deleted,
    contributions: [...deleted.contributions, createContribution({
      authorMemberId: "owner",
      authorName: "测试者",
      relation: "自己",
      text: "桂花树下的回忆。",
      storyTitle: "外婆的院子",
      scope: "personal",
      visibility: "private",
    })],
  };

  assert.ok(!storyShelf(withSameName).some((story) => story.title === "外婆的院子"));
  assert.ok(!storyShelf({ ...withSameName, contributions: deleted.contributions }).some((story) => story.title === "外婆的院子"));
});
