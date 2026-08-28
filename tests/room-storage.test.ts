import assert from "node:assert/strict";
import test from "node:test";

import {
  biographySourceFingerprint,
  BiographyDraft,
  createContribution,
  createInitialRoomState,
  reviewContribution,
} from "../miniprogram/domain/biography";
import {
  loadRoomState,
  saveDraftIfSourcesUnchanged,
  saveRoomState,
} from "../miniprogram/services/roomStorage";

function installStorageMock() {
  let stored: unknown;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "wx");
  Object.defineProperty(globalThis, "wx", {
    configurable: true,
    writable: true,
    value: {
      getStorageSync: () => stored,
      setStorageSync: (_key: string, value: unknown) => {
        stored = value;
      },
    },
  });

  return () => {
    if (previous) Object.defineProperty(globalThis, "wx", previous);
    else delete (globalThis as Record<string, unknown>).wx;
  };
}

const draft: BiographyDraft = {
  title: "第一章｜雨天的巷口",
  paragraphs: ["外公会在雨天等我放学。"],
  sourceCount: 1,
  generatedAt: "2026-08-28T05:00:00.000Z",
  generationMode: "local-demo",
};

test("a late generation keeps unrelated newer room changes", (context) => {
  const restoreWx = installStorageMock();
  context.after(restoreWx);

  const initial = createInitialRoomState();
  const started = {
    ...initial,
    contributions: [
      reviewContribution(initial.contributions[0], "confirmed", "elder"),
      initial.contributions[1],
    ],
  };
  const fingerprint = biographySourceFingerprint(started);
  const newerPending = createContribution({
    id: "newer-pending",
    authorMemberId: "member-2",
    authorName: "陈野",
    relation: "女婿",
    text: "这是生成过程中刚补充、尚未确认的材料。",
    visibility: "family",
    now: new Date("2026-08-28T05:01:00.000Z"),
  });
  saveRoomState({
    ...started,
    contributions: [...started.contributions, newerPending],
  });

  const saved = saveDraftIfSourcesUnchanged(draft, fingerprint);

  assert.ok(saved);
  assert.ok(saved.contributions.some((memory) => memory.id === "newer-pending"));
  assert.equal(loadRoomState().draft?.title, draft.title);
});

test("a late generation is discarded after the confirmed source set changes", (context) => {
  const restoreWx = installStorageMock();
  context.after(restoreWx);

  const initial = createInitialRoomState();
  const started = {
    ...initial,
    contributions: [
      reviewContribution(initial.contributions[0], "confirmed", "elder"),
      initial.contributions[1],
    ],
  };
  const fingerprint = biographySourceFingerprint(started);
  const changed = {
    ...started,
    contributions: started.contributions.map((memory) =>
      memory.id === "demo-memory-radio"
        ? reviewContribution(memory, "confirmed", "elder")
        : memory,
    ),
  };
  saveRoomState(changed);

  const saved = saveDraftIfSourcesUnchanged(draft, fingerprint);

  assert.equal(saved, undefined);
  assert.equal(loadRoomState().draft, undefined);
  assert.equal(loadRoomState().contributions[1].reviewStatus, "confirmed");
});

test("confirming a private memory does not invalidate a public-source draft", (context) => {
  const restoreWx = installStorageMock();
  context.after(restoreWx);

  const initial = createInitialRoomState();
  const privatePending = createContribution({
    id: "private-pending",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "这条只想让外公知道。",
    visibility: "private",
    now: new Date("2026-08-28T05:03:00.000Z"),
  });
  const started = {
    ...initial,
    contributions: [
      reviewContribution(initial.contributions[0], "confirmed", "elder"),
      initial.contributions[1],
      privatePending,
    ],
  };
  const fingerprint = biographySourceFingerprint(started);
  saveRoomState({
    ...started,
    contributions: started.contributions.map((memory) =>
      memory.id === privatePending.id
        ? reviewContribution(memory, "confirmed", "elder")
        : memory,
    ),
  });

  const saved = saveDraftIfSourcesUnchanged(draft, fingerprint);

  assert.ok(saved);
  assert.equal(saved.draft?.title, draft.title);
  assert.equal(saved.contributions[2].reviewStatus, "confirmed");
});
