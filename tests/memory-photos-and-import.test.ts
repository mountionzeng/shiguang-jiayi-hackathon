import assert from "node:assert/strict";
import test from "node:test";

import {
  createContribution,
  createContributionFromSegments,
  memorySegmentCount,
  memorySegments,
} from "../miniprogram/domain/biography";

function baseInput(overrides: Partial<Parameters<typeof createContribution>[0]> = {}) {
  return {
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "灶台边总有一股柴火味。",
    scope: "personal" as const,
    visibility: "private" as const,
    now: new Date("2026-09-16T00:00:00.000Z"),
    ...overrides,
  };
}

test("a memory can be photo-only: empty text is allowed when photoIds are present", () => {
  assert.throws(() => createContribution({ ...baseInput(), text: "" }), /请先写下一段回忆，或者加一张照片/);
  const withPhoto = createContribution({ ...baseInput(), text: "", photoIds: ["family_x_img_req-abc12345"] });
  assert.equal(withPhoto.text, "");
  assert.deepEqual(withPhoto.photoIds, ["family_x_img_req-abc12345"]);
});

test("photoIds fail closed: not an array, empty, duplicate, or over 9 are all rejected or normalized", () => {
  assert.equal(createContribution(baseInput()).photoIds, undefined, "no photoIds field at all");
  assert.equal(createContribution({ ...baseInput(), photoIds: [] }).photoIds, undefined);
  assert.equal(createContribution({ ...baseInput(), photoIds: "oops" as unknown as string[] }).photoIds, undefined,
    "a malformed cached value fails closed to no photos, not a crash");
  assert.deepEqual(createContribution({ ...baseInput(), photoIds: ["a", "a", "b"] }).photoIds, ["a", "b"], "dedupes");
  assert.throws(() => createContribution({ ...baseInput(), photoIds: Array.from({ length: 10 }, (_, i) => `p${i}`) }),
    /最多放 9 张照片/);
});

test("createContributionFromSegments builds one memory from several pre-split texts, each validated like a normal segment", () => {
  const contribution = createContributionFromSegments(
    baseInput({ text: "" }),
    ["第一段导入的文字。", "第二段导入的文字。", "第三段导入的文字。"],
    "import",
  );
  assert.equal(memorySegmentCount(contribution), 3);
  const segments = memorySegments(contribution);
  assert.deepEqual(segments.map((item) => item.source), ["import", "import", "import"]);
  assert.equal(contribution.text, segments.map((item) => item.text).join("\n"));
  // 段 id 各不相同。
  assert.equal(new Set(segments.map((item) => item.id)).size, 3);
  // 归类和权限字段照常来自 input，不受多段影响。
  assert.equal(contribution.authorMemberId, "owner");
  assert.equal(contribution.scope, "personal");
});

test("createContributionFromSegments rejects an over-length segment, and empty segments are skipped", () => {
  assert.throws(
    () => createContributionFromSegments(baseInput(), ["正常的一段", "字".repeat(501)], "import"),
    /单次回忆不能超过 500 字/,
  );
  const skippedEmpty = createContributionFromSegments(baseInput(), ["  ", "唯一有内容的一段", "\n"], "import");
  assert.equal(memorySegmentCount(skippedEmpty), 1);
  assert.equal(memorySegments(skippedEmpty)[0].text, "唯一有内容的一段");
});

test("createContributionFromSegments throws when every segment is empty", () => {
  assert.throws(() => createContributionFromSegments(baseInput(), ["", "   ", "\n"], "import"),
    /请先写下一段回忆，或者加一张照片/);
});

test("a single-segment import still tags its one segment as 'import', not the default 'note'", () => {
  const contribution = createContributionFromSegments(baseInput(), ["只有一段的导入。"], "import");
  assert.equal(memorySegmentCount(contribution), 1);
  assert.equal(memorySegments(contribution)[0].source, "import");
});
