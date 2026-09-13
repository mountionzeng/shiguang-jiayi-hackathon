import assert from "node:assert/strict";
import test from "node:test";

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
