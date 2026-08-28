import assert from "node:assert/strict";
import test from "node:test";

import {
  backendEligibleContributionIds,
  buildBiographyJobPayload,
  buildMemoryPayload,
  buildSourceRecordPayload,
} from "../miniprogram/services/backendApi";
import {
  createContribution,
  createInitialRoomState,
  reviewContribution,
} from "../miniprogram/domain/biography";

const fixedNow = new Date("2026-08-28T06:00:00.000Z");

test("a frontend contribution maps to a backend source record with provenance", () => {
  const contribution = createContribution({
    id: "frontend-memory-1",
    authorMemberId: "member-1",
    authorName: "林秋",
    relation: "女儿",
    text: "父亲年轻时喜欢修收音机。",
    visibility: "family",
    now: fixedNow,
  });

  const payload = buildSourceRecordPayload(contribution);
  const notes = JSON.parse(payload.notes);

  assert.equal(payload.contributor_person_id, "member-1");
  assert.equal(payload.raw_text, "父亲年轻时喜欢修收音机。");
  assert.equal(notes.frontendContributionId, "frontend-memory-1");
  assert.equal(notes.authorName, "林秋");
  assert.equal(notes.reviewStatus, "pending");
});

test("a frontend contribution maps to a backend memory review state", () => {
  const contribution = reviewContribution(
    createContribution({
      id: "frontend-memory-2",
      authorMemberId: "owner",
      authorName: "林岚",
      relation: "外孙女",
      text: "外公会在雨天等我放学。",
      visibility: "private",
      now: fixedNow,
    }),
    "confirmed",
    "elder",
  );

  const payload = buildMemoryPayload(contribution, "src_123");

  assert.equal(payload.author_person_id, "owner");
  assert.equal(payload.visibility, "private");
  assert.equal(payload.review_status, "confirmed");
  assert.deepEqual(payload.source_record_ids, ["src_123"]);
});

test("biography generation uses only confirmed family-visible contribution ids", () => {
  const state = createInitialRoomState();
  state.contributions = [
    reviewContribution(state.contributions[0], "confirmed", "elder"),
    reviewContribution({ ...state.contributions[1], id: "conflict" }, "conflict", "elder"),
    reviewContribution(
      createContribution({
        id: "private-confirmed",
        authorMemberId: "owner",
        authorName: "林岚",
        relation: "外孙女",
        text: "这条属实但仍然私密。",
        visibility: "private",
        now: fixedNow,
      }),
      "confirmed",
      "elder",
    ),
  ];

  assert.deepEqual(backendEligibleContributionIds(state), ["demo-memory-rain"]);
});

test("biography job payload targets the memoir review product", () => {
  assert.deepEqual(buildBiographyJobPayload(["mem_1"], ["src_1"]), {
    product_type: "memoir_review",
    output_modality: "text",
    input_memory_ids: ["mem_1"],
    input_source_record_ids: ["src_1"],
  });
});
