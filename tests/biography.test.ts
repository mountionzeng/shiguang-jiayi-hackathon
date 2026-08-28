import assert from "node:assert/strict";
import test from "node:test";

import {
  biographySourceContributions,
  buildLocalBiographyDraft,
  confirmedContributions,
  createContribution,
  createInitialRoomState,
  MEMORY_TYPE_LABELS,
  pendingContributionsFor,
  reviewContribution,
  revokeFamilyVisibility,
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

test("a family-visible memory stays hidden from other relatives until the elder confirms it", () => {
  const state = createInitialRoomState();
  const pendingFamilyMemory = createContribution({
    id: "pending-family",
    authorMemberId: "member-1",
    authorName: "林秋",
    relation: "女儿",
    text: "父亲当年是厂里第一个学会修机器的。",
    visibility: "family",
    now: fixedNow,
  });
  const contributions = [pendingFamilyMemory];

  const author = state.members.find((member) => member.id === "member-1");
  const otherFamilyMember = state.members.find((member) => member.id === "owner");
  const elder = state.members.find((member) => member.id === "elder");
  assert.ok(author && otherFamilyMember && elder);

  // 投稿人和老人看得到；其他家人在确认之前看不到。
  assert.ok(visibleContributionsForMember(contributions, author).includes(pendingFamilyMemory));
  assert.ok(visibleContributionsForMember(contributions, elder).includes(pendingFamilyMemory));
  assert.ok(
    !visibleContributionsForMember(contributions, otherFamilyMember).includes(pendingFamilyMemory),
  );

  // 老人确认之后才对其他家人公开。
  const confirmed = reviewContribution(pendingFamilyMemory, "confirmed", "elder");
  assert.ok(visibleContributionsForMember([confirmed], otherFamilyMember).includes(confirmed));

  // 被拒绝或存在冲突的说法始终不对其他家人公开。
  const rejected = reviewContribution(pendingFamilyMemory, "rejected", "elder");
  const conflict = reviewContribution(pendingFamilyMemory, "conflict", "elder");
  assert.ok(!visibleContributionsForMember([rejected], otherFamilyMember).includes(rejected));
  assert.ok(!visibleContributionsForMember([conflict], otherFamilyMember).includes(conflict));
});

test("the pending entry point shows the elder every open item and a relative only their own", () => {
  const state = createInitialRoomState();
  const mine = createContribution({
    id: "mine-pending",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "我记得他总在巷口等我。",
    visibility: "family",
    now: fixedNow,
  });
  const theirs = createContribution({
    id: "theirs-pending",
    authorMemberId: "member-1",
    authorName: "林秋",
    relation: "女儿",
    text: "父亲喜欢修收音机。",
    visibility: "family",
    now: fixedNow,
  });
  const contributions = [mine, theirs];

  const owner = state.members.find((member) => member.id === "owner");
  const elder = state.members.find((member) => member.id === "elder");
  assert.ok(owner && elder);

  assert.deepEqual(
    pendingContributionsFor(contributions, elder).map((item) => item.id),
    ["mine-pending", "theirs-pending"],
  );
  assert.deepEqual(
    pendingContributionsFor(contributions, owner).map((item) => item.id),
    ["mine-pending"],
  );
});

test("taking a memory off the family timeline only revokes family visibility", () => {
  const state = createInitialRoomState();
  const author = state.members.find((member) => member.id === "owner");
  const someoneElse = state.members.find((member) => member.id === "member-1");
  const elder = state.members.find((member) => member.id === "elder");
  assert.ok(author && someoneElse && elder);

  const shared = reviewContribution(
    createContribution({
      id: "shared",
      authorMemberId: "owner",
      authorName: "林岚",
      relation: "外孙女",
      text: "外公总在巷口等我放学。",
      visibility: "family",
      now: fixedNow,
    }),
    "confirmed",
    "elder",
  );

  assert.throws(() => revokeFamilyVisibility(shared, someoneElse), /只有讲述/);

  const revoked = revokeFamilyVisibility(shared, author);

  // 撤下之后：不再进入公开时间线与章节来源。
  assert.ok(!biographySourceContributions([revoked]).includes(revoked));
  assert.ok(!visibleContributionsForMember([revoked], someoneElse).includes(revoked));

  // 但原始内容仍然留在人生之书里，确认结论不变。
  assert.equal(revoked.text, shared.text);
  assert.equal(revoked.reviewStatus, "confirmed");
  assert.ok(visibleContributionsForMember([revoked], author).includes(revoked));
  assert.ok(visibleContributionsForMember([revoked], elder).includes(revoked));

  // 已经是私密的片段再撤一次不会有副作用。
  assert.equal(revokeFamilyVisibility(revoked, author), revoked);
});

test("a fragment carries its prototype type label and keeps a note as the default", () => {
  const memoir = createContribution({
    id: "memoir",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "外婆家门口有一口老井。",
    title: "  外婆家的那口老井  ",
    memoryType: "memoir",
    visibility: "family",
    now: fixedNow,
  });
  assert.equal(memoir.memoryType, "memoir");
  assert.equal(memoir.title, "外婆家的那口老井");
  assert.equal(MEMORY_TYPE_LABELS[memoir.memoryType!], "回忆录");

  const untyped = createContribution({
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "今天想起他了。",
    visibility: "private",
    now: fixedNow,
  });
  assert.equal(untyped.memoryType, "note");
  assert.equal(untyped.title, undefined);
});

test("choosing not to share keeps a fragment out of the memory home entirely", () => {
  const state = createInitialRoomState();
  const otherFamilyMember = state.members.find((member) => member.id === "member-1");
  assert.ok(otherFamilyMember);

  // 整理页上没有点「也分享到记忆之家」＝ 只留在人生之书。
  const notShared = reviewContribution(
    createContribution({
      id: "not-shared",
      authorMemberId: "owner",
      authorName: "林岚",
      relation: "外孙女",
      text: "这段我暂时不想给别人看。",
      visibility: "private",
      now: fixedNow,
    }),
    "confirmed",
    "elder",
  );

  assert.ok(!biographySourceContributions([notShared]).includes(notShared));
  assert.ok(!visibleContributionsForMember([notShared], otherFamilyMember).includes(notShared));
});
