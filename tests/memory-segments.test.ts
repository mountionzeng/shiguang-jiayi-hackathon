import assert from "node:assert/strict";
import test from "node:test";

import {
  appendMemorySegment,
  createContribution,
  memorySegmentCount,
  memorySegments,
  MemoryContribution,
} from "../miniprogram/domain/biography";

function baseMemory(overrides: Partial<Parameters<typeof createContribution>[0]> = {}): MemoryContribution {
  return createContribution({
    id: "memory-1",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "灶台边总有一股柴火味。",
    now: new Date("2026-09-01T00:00:00.000Z"),
    scope: "personal",
    visibility: "private",
    ...overrides,
  });
}

test("a legacy memory with no segments field reads as a single note segment", () => {
  const memory = baseMemory();
  const segments = memorySegments(memory);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].id, memory.id);
  assert.equal(segments[0].text, memory.text);
  assert.equal(segments[0].createdAt, memory.createdAt);
  assert.equal(segments[0].source, "note");
  assert.equal(memorySegmentCount(memory), 1);
});

test("appendMemorySegment adds a segment, updates text, and keeps everything else unchanged", () => {
  const memory = baseMemory();
  const continued = appendMemorySegment(
    memory,
    "外公总会提前十分钟出门。",
    "continue",
    "cloud-ai",
    new Date("2026-09-08T00:00:00.000Z"),
  );

  assert.equal(memorySegmentCount(continued), 2);
  const segments = memorySegments(continued);
  assert.equal(segments[0].text, "灶台边总有一股柴火味。");
  assert.equal(segments[1].text, "外公总会提前十分钟出门。");
  assert.equal(segments[1].source, "continue");
  assert.equal(segments[1].organizationMode, "cloud-ai");
  assert.equal(continued.text, segments.map((item) => item.text).join("\n"));

  // 归类和权限不因为多讲了一段而改变。
  assert.equal(continued.id, memory.id);
  assert.equal(continued.reviewStatus, memory.reviewStatus);
  assert.equal(continued.scope, memory.scope);
  assert.equal(continued.createdAt, memory.createdAt);

  const third = appendMemorySegment(continued, "今天又想起一件小事。", "daily-question", undefined,
    new Date("2026-09-15T00:00:00.000Z"));
  assert.equal(memorySegmentCount(third), 3);
  assert.equal(memorySegments(third)[2].source, "daily-question");
  // segment id 各不相同。
  assert.equal(new Set(memorySegments(third).map((item) => item.id)).size, 3);
});

test("appendMemorySegment rejects an empty or too-long addition, without touching the memory", () => {
  const memory = baseMemory();
  assert.throws(() => appendMemorySegment(memory, "   ", "continue"), /请先写下这一段/);
  assert.throws(() => appendMemorySegment(memory, "字".repeat(501), "continue"), /单次回忆不能超过 500 字/);
  assert.equal(memorySegmentCount(memory), 1, "拒绝时原记忆不变");
});

test("a malformed cached segments field fails closed to the single-segment reading, not a crash", () => {
  const memory = { ...baseMemory(), segments: { broken: true } } as unknown as MemoryContribution;
  assert.doesNotThrow(() => memorySegments(memory));
  assert.equal(memorySegmentCount(memory), 1);

  const emptyArray = { ...baseMemory(), segments: [] } as unknown as MemoryContribution;
  assert.equal(memorySegmentCount(emptyArray), 1, "空数组也当作没有 segments");
});
