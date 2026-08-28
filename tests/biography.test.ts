import assert from "node:assert/strict";
import test from "node:test";

import {
  biographySourceContributions,
  buildLocalBiographyDraft,
  confirmedContributions,
  createContribution,
  createInitialRoomState,
  reviewContribution,
  visibleContributionsForMember,
} from "../miniprogram/domain/biography";

const fixedNow = new Date("2026-08-28T04:00:00.000Z");

test("a family member can submit a normalized private memory", () => {
  const contribution = createContribution({
    id: "memory-1",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "  外公   总会等我放学。  ",
    visibility: "private",
    now: fixedNow,
  });

  assert.equal(contribution.text, "外公 总会等我放学。");
  assert.equal(contribution.visibility, "private");
  assert.equal(contribution.reviewStatus, "pending");
});

test("blank and oversized memories are rejected", () => {
  assert.throws(
    () =>
      createContribution({
        authorMemberId: "owner",
        authorName: "林岚",
        relation: "外孙女",
        text: "   ",
        visibility: "family",
      }),
    /请先写下/,
  );

  assert.throws(
    () =>
      createContribution({
        authorMemberId: "owner",
        authorName: "林岚",
        relation: "外孙女",
        text: "记".repeat(501),
        visibility: "family",
      }),
    /500 字/,
  );
});

test("only the elder can decide whether a memory becomes factual", () => {
  const contribution = createContribution({
    id: "memory-2",
    authorMemberId: "member-1",
    authorName: "林秋",
    relation: "女儿",
    text: "父亲喜欢修收音机。",
    visibility: "family",
    now: fixedNow,
  });

  assert.throws(
    () => reviewContribution(contribution, "confirmed", "owner"),
    /只有传记主人公/,
  );

  assert.equal(
    reviewContribution(contribution, "confirmed", "elder").reviewStatus,
    "confirmed",
  );
});

test("pending, rejected and conflict memories never enter the authoritative source set", () => {
  const base = createContribution({
    id: "memory-3",
    authorMemberId: "member-1",
    authorName: "林秋",
    relation: "女儿",
    text: "父亲喜欢修收音机。",
    visibility: "family",
    now: fixedNow,
  });

  const contributions = [
    base,
    reviewContribution({ ...base, id: "confirmed" }, "confirmed", "elder"),
    reviewContribution({ ...base, id: "rejected" }, "rejected", "elder"),
    reviewContribution({ ...base, id: "conflict" }, "conflict", "elder"),
  ];

  assert.deepEqual(
    biographySourceContributions(contributions).map((item) => item.id),
    ["confirmed"],
  );
});

test("private memories stay between their author and the elder and never enter the book", () => {
  const state = createInitialRoomState();
  const privateMemory = reviewContribution(
    createContribution({
      id: "private-confirmed",
      authorMemberId: "owner",
      authorName: "林岚",
      relation: "外孙女",
      text: "这件事只想先告诉外公。",
      visibility: "private",
      now: fixedNow,
    }),
    "confirmed",
    "elder",
  );
  const contributions = [...state.contributions, privateMemory];
  const owner = state.members.find((member) => member.id === "owner");
  const otherFamilyMember = state.members.find((member) => member.id === "member-1");
  const elder = state.members.find((member) => member.id === "elder");

  assert.ok(owner && otherFamilyMember && elder);
  assert.ok(visibleContributionsForMember(contributions, owner).includes(privateMemory));
  assert.ok(visibleContributionsForMember(contributions, elder).includes(privateMemory));
  assert.ok(!visibleContributionsForMember(contributions, otherFamilyMember).includes(privateMemory));
  assert.ok(confirmedContributions(contributions).includes(privateMemory));
  assert.ok(!biographySourceContributions(contributions).includes(privateMemory));
});

test("the transparent local draft cites only confirmed memories", () => {
  const pending = createContribution({
    id: "pending",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "这条还没有确认。",
    visibility: "family",
    now: fixedNow,
  });
  const confirmed = reviewContribution(
    createContribution({
      id: "confirmed",
      authorMemberId: "member-1",
      authorName: "林秋",
      relation: "女儿",
      text: "父亲喜欢修收音机。",
      visibility: "family",
      now: fixedNow,
    }),
    "confirmed",
    "elder",
  );
  const confirmedPrivate = reviewContribution(
    createContribution({
      id: "confirmed-private",
      authorMemberId: "owner",
      authorName: "林岚",
      relation: "外孙女",
      text: "这条虽然属实，但没有同意公开。",
      visibility: "private",
      now: fixedNow,
    }),
    "confirmed",
    "elder",
  );

  const draft = buildLocalBiographyDraft(
    "林致远",
    [pending, confirmed, confirmedPrivate],
    fixedNow,
  );
  const fullText = draft.paragraphs.join("\n");

  assert.equal(draft.generationMode, "local-demo");
  assert.equal(draft.sourceCount, 1);
  assert.match(fullText, /父亲喜欢修收音机/);
  assert.doesNotMatch(fullText, /这条还没有确认/);
  assert.doesNotMatch(fullText, /没有同意公开/);
});

test("a chapter cannot be generated without confirmed material", () => {
  const pending = createContribution({
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "等待确认。",
    visibility: "family",
    now: fixedNow,
  });

  assert.throws(
    () => buildLocalBiographyDraft("林致远", [pending], fixedNow),
    /至少确认一段/,
  );
});
