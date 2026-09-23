import assert from "node:assert/strict";
import test from "node:test";

import {
  appendAiRevision,
  createContribution,
  memoryAiLabel,
  memoryAiRevisions,
  memoryOriginalSpokenText,
  revertMemoryToSpoken,
} from "../miniprogram/domain/biography";

const fixedNow = new Date("2026-08-28T04:00:00.000Z");

function baseContribution() {
  return createContribution({
    id: "memory-ai-1",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "外公总会等我放学。",
    visibility: "private",
    now: fixedNow,
  });
}

test("a memory with no aiRevisions has no AI label and its original text is itself", () => {
  const contribution = baseContribution();
  assert.deepEqual(memoryAiRevisions(contribution), []);
  assert.equal(memoryAiLabel(contribution), "");
  assert.equal(memoryOriginalSpokenText(contribution), contribution.text);
});

test("appendAiRevision auto-seeds the spoken revision then records the AI pass", () => {
  const spoken = baseContribution();
  const laterNow = new Date(fixedNow.getTime() + 1000);
  const organized = appendAiRevision(spoken, "ai", "外公每天都会站在校门口等我放学。", undefined, "cloud-ai", laterNow);

  const revisions = memoryAiRevisions(organized);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].kind, "spoken");
  assert.equal(revisions[0].text, spoken.text);
  assert.equal(revisions[1].kind, "ai");
  assert.equal(organized.text, "外公每天都会站在校门口等我放学。");
  assert.equal(organized.organizationMode, "cloud-ai");
  assert.equal(memoryAiLabel(organized), "文字 AI 生成");
  assert.equal(memoryOriginalSpokenText(organized), spoken.text);
});

test("a manual edit after AI organizing switches the label to the edited variant", () => {
  const spoken = baseContribution();
  const organized = appendAiRevision(spoken, "ai", "外公每天都会站在校门口等我放学。", undefined, "cloud-ai", fixedNow);
  const edited = appendAiRevision(
    organized,
    "manual",
    "外公每天都提前站在校门口等我放学。",
    undefined,
    "cloud-ai",
    new Date(fixedNow.getTime() + 2000),
  );

  assert.equal(memoryAiLabel(edited), "文字 AI 生成 · 已由你修改");
  assert.equal(edited.text, "外公每天都提前站在校门口等我放学。");
  assert.equal(memoryOriginalSpokenText(edited), spoken.text);
  assert.equal(memoryAiRevisions(edited).length, 3);
});

test("a manual edit with no prior AI pass carries no AI label", () => {
  const spoken = baseContribution();
  const edited = appendAiRevision(spoken, "manual", "外公总会提前等我放学。", undefined, undefined, fixedNow);
  assert.equal(memoryAiLabel(edited), "");
});

test("revertMemoryToSpoken restores the original text without deleting history", () => {
  const spoken = baseContribution();
  const organized = appendAiRevision(spoken, "ai", "外公每天都会站在校门口等我放学。", undefined, "cloud-ai", fixedNow);
  const edited = appendAiRevision(
    organized,
    "manual",
    "外公每天都提前站在校门口等我放学。",
    undefined,
    "cloud-ai",
    new Date(fixedNow.getTime() + 1000),
  );

  const reverted = revertMemoryToSpoken(edited, new Date(fixedNow.getTime() + 2000));
  assert.equal(reverted.text, spoken.text);
  assert.equal(reverted.organizationMode, spoken.organizationMode);
  assert.equal(memoryAiLabel(reverted), "");
  // 非破坏性：历史条数只增不减（原 3 条 + 1 条 restore）。
  assert.equal(memoryAiRevisions(reverted).length, 4);
  assert.equal(memoryAiRevisions(reverted)[3].kind, "restore");

  // 已经是原话时不重复追加 restore。
  const revertedAgain = revertMemoryToSpoken(reverted, new Date(fixedNow.getTime() + 3000));
  assert.equal(memoryAiRevisions(revertedAgain).length, 4);
});

test("revertMemoryToSpoken on a memory with no history is a no-op", () => {
  const spoken = baseContribution();
  const reverted = revertMemoryToSpoken(spoken, fixedNow);
  assert.equal(reverted, spoken);
});

test("malformed cached aiRevisions fail closed to an empty history, never a fabricated label", () => {
  const contribution = { ...baseContribution(), aiRevisions: "not-an-array" as unknown as never };
  assert.deepEqual(memoryAiRevisions(contribution), []);
  assert.equal(memoryAiLabel(contribution), "");
  assert.equal(memoryOriginalSpokenText(contribution), contribution.text);

  const partiallyBroken = {
    ...baseContribution(),
    aiRevisions: [{ id: "x", kind: "spoken" }] as unknown as never,
  };
  assert.deepEqual(memoryAiRevisions(partiallyBroken), []);
});

test("createContribution passes through an explicit aiRevisions array unchanged", () => {
  const revisions = [{
    id: "revision-seed",
    kind: "spoken" as const,
    text: "原话本身。",
    createdAt: fixedNow.toISOString(),
  }];
  const contribution = createContribution({
    id: "memory-ai-2",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "原话本身。",
    visibility: "private",
    now: fixedNow,
    aiRevisions: revisions,
  });
  assert.deepEqual(memoryAiRevisions(contribution), revisions);
});
