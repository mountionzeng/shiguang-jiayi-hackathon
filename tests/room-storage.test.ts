import assert from "node:assert/strict";
import test from "node:test";

import {
  biographySourceFingerprint,
  BiographyDraft,
  createContribution,
  createInitialRoomState,
  personalBookSourceFingerprint,
  reviewContribution,
} from "../miniprogram/domain/biography";
import {
  appendContribution,
  loadRoomState,
  savePersonalDraftIfSourcesUnchanged,
  saveDraftIfSourcesUnchanged,
  saveRoomState,
} from "../miniprogram/services/roomStorage";

function installVersionedStorageMock(initial: Record<string, unknown> = {}) {
  const stored = new Map(Object.entries(initial));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "wx");
  Object.defineProperty(globalThis, "wx", {
    configurable: true,
    writable: true,
    value: {
      getStorageSync: (key: string) => stored.get(key),
      setStorageSync: (key: string, value: unknown) => stored.set(key, value),
    },
  });

  return {
    read: (key: string) => stored.get(key),
    restore: () => {
      if (previous) Object.defineProperty(globalThis, "wx", previous);
      else delete (globalThis as Record<string, unknown>).wx;
    },
  };
}

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

test("v2 rooms migrate to v3 without becoming personal stories", (context) => {
  const legacy = createInitialRoomState();
  const scopeLess = legacy.contributions.map(({ scope: _scope, ...memory }) => memory);
  const storage = installVersionedStorageMock({
    "shiguang-family-room-v2": {
      ...legacy,
      contributions: scopeLess,
      draft,
    },
  });
  context.after(storage.restore);

  const migrated = loadRoomState();
  const persisted = storage.read("shiguang-family-room-v3") as typeof migrated;

  assert.deepEqual(
    migrated.contributions.map((memory) => memory.id),
    legacy.contributions.map((memory) => memory.id),
  );
  assert.ok(migrated.contributions.every((memory) => memory.scope === "family"));
  assert.equal(migrated.draft, undefined);
  assert.deepEqual(persisted, migrated);
});

test("a late generation keeps unrelated newer room changes", (context) => {
  const restoreWx = installStorageMock();
  context.after(restoreWx);

  const initial = createInitialRoomState();
  const started = initial;
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
  const started = initial;
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
  assert.equal(
    loadRoomState().contributions.find((memory) => memory.id === "demo-memory-radio")?.reviewStatus,
    "confirmed",
  );
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
    contributions: [...initial.contributions, privatePending],
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
  assert.equal(
    saved.contributions.find((memory) => memory.id === privatePending.id)?.reviewStatus,
    "confirmed",
  );
});

test("a personal draft is isolated to its owner and rejects changed personal sources", (context) => {
  const restoreWx = installStorageMock();
  context.after(restoreWx);

  const initial = createInitialRoomState();
  saveRoomState(initial);
  const fingerprint = personalBookSourceFingerprint(initial, "owner");

  const saved = savePersonalDraftIfSourcesUnchanged(
    draft,
    fingerprint,
    "owner",
  );
  assert.equal(saved?.personalDrafts?.owner.title, draft.title);
  assert.equal(saved?.personalDrafts?.["member-1"], undefined);

  const newerPersonal = createContribution({
    id: "owner-new-personal",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "这是我后来想起的另一段亲身经历。",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-08-28T05:05:00.000Z"),
  });
  saveRoomState({
    ...initial,
    contributions: [...initial.contributions, newerPersonal],
  });

  assert.equal(
    savePersonalDraftIfSourcesUnchanged(draft, fingerprint, "owner"),
    undefined,
  );
});

test("appending a personal story invalidates only its author's draft", (context) => {
  const restoreWx = installStorageMock();
  context.after(restoreWx);

  const initial = createInitialRoomState();
  const withDrafts = {
    ...initial,
    personalDrafts: { owner: draft, "member-1": { ...draft, title: "林秋的第一章" } },
  };
  const personal = createContribution({
    id: "owner-next-story",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "这是我又想起的一段亲身经历。",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-08-28T05:06:00.000Z"),
  });

  const afterPersonal = appendContribution(personal, withDrafts);
  assert.equal(afterPersonal.personalDrafts?.owner, undefined);
  assert.equal(afterPersonal.personalDrafts?.["member-1"]?.title, "林秋的第一章");

  const family = createContribution({
    id: "family-next-story",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "这是我和家人共同经历的一件事。",
    scope: "family",
    visibility: "family",
    now: new Date("2026-08-28T05:07:00.000Z"),
  });
  const afterFamily = appendContribution(family, withDrafts);
  assert.equal(afterFamily.personalDrafts?.owner?.title, draft.title);
  assert.equal(afterFamily.personalDrafts?.["member-1"]?.title, "林秋的第一章");
});
