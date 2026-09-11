import assert from "node:assert/strict";
import test from "node:test";

import { createContribution, FamilyRoomState } from "../miniprogram/domain/biography";
import { makeRevision } from "../miniprogram/services/manuscript";
import { createDemoRoomStateForTests } from "./fixtures";

type PageDefinition = { data?: Record<string, unknown>; [key: string]: unknown };
type PageInstance = PageDefinition & { data: Record<string, unknown>; setData(update: Record<string, unknown>): void };

// A page module registers itself once; later instances reuse its definition.
const definitions = new Map<string, PageDefinition>();

async function loadPage(name: "index" | "profiles", options?: Record<string, string>): Promise<PageInstance> {
  let captured = definitions.get(name);
  if (!captured) {
    (globalThis as any).Page = (definition: PageDefinition) => { captured = definition; };
    try {
      if (name === "index") await import("../miniprogram/pages/index/index");
      else await import("../miniprogram/pages/profiles/profiles");
    } finally { delete (globalThis as any).Page; }
    assert.ok(captured);
    definitions.set(name, captured);
  }
  const page = { ...captured, data: structuredClone(captured.data ?? {}) } as PageInstance;
  page.setData = (update) => Object.assign(page.data, update);
  if (options) (page.onLoad as (value: Record<string, string>) => void).call(page, options);
  return page;
}

const call = (page: PageInstance, method: string, ...args: unknown[]) =>
  (page[method] as (...values: unknown[]) => unknown).apply(page, args);
const tap = (id: string, kind?: string) => ({ currentTarget: { dataset: { id, ...(kind ? { kind } : {}) } } });
const ids = (items: unknown) => (items as Array<{ id: string }>).map((item) => item.id);

function install(state: FamilyRoomState, currentMemberId = "owner") {
  const stored = new Map<string, unknown>([["shiguang-family-room-v5", state], ["shiguang-current-member-v1", currentMemberId]]);
  const toasts: string[] = [];
  const dialogs: string[] = [];
  const previous = (globalThis as any).wx;
  (globalThis as any).wx = {
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: unknown) => stored.set(key, value),
    showToast: ({ title }: { title: string }) => toasts.push(title),
    showLoading: () => undefined,
    hideLoading: () => undefined,
    showModal: ({ title, content, success }: { title: string; content: string; success?: (result: { confirm: boolean }) => void }) => {
      dialogs.push(title + "｜" + content);
      success?.({ confirm: true });
    },
    navigateBack: () => undefined,
    navigateTo: () => undefined,
  };
  return {
    toasts, dialogs,
    room: () => stored.get("shiguang-family-room-v5") as FamilyRoomState,
    restore: () => { (globalThis as any).wx = previous; },
  };
}

test("legacy records wait in one sorting list and move into exactly one list once sorted", async (context) => {
  const env = install(createDemoRoomStateForTests());
  context.after(env.restore);
  const profiles = await loadPage("profiles", {});
  const people = await loadPage("profiles", { mode: "people" });
  await call(profiles, "refresh");
  await call(people, "refresh");
  assert.equal((profiles.data.pending as unknown[]).length, 5);
  assert.deepEqual(ids(profiles.data.profiles), []);
  assert.deepEqual(ids(people.data.profiles), []);

  await call(people, "classify", tap("member-2", "person"));
  await call(profiles, "classify", tap("member-1", "recording-profile"));
  await call(profiles, "refresh");
  await call(people, "refresh");
  assert.deepEqual(ids(profiles.data.profiles), ["member-1"]);
  assert.deepEqual(ids(people.data.profiles), ["member-2"]);
  assert.ok(!ids(profiles.data.pending).includes("member-2"));

  const home = await loadPage("index");
  await call(home, "refresh");
  assert.ok(!ids(home.data.profileOptions).includes("member-2"), "a person never shows in the profile switcher");
  assert.equal(home.data.familyMemberCount, 1);
  await call(profiles, "classify", tap("owner", "person"));
  assert.match(env.toasts[env.toasts.length - 1], /正在使用的档案/);
  assert.equal(env.room().members.find((member) => member.id === "owner")?.kind, undefined);
});

test("the home switcher deletes another profile into Recently Deleted and the profiles page restores it", async (context) => {
  const state = createDemoRoomStateForTests();
  state.contributions.push(createContribution({
    id: "told-by-qiu", authorMemberId: "member-1", authorName: "林秋", relation: "女儿",
    text: "林秋讲的一段虚构记忆。", scope: "personal", visibility: "private",
  }));
  state.manuscriptRevisions = [makeRevision("member-1", {
    title: "林秋的书", paragraphs: ["虚构正文"], sourceCount: 1, generatedAt: "", generationMode: "local-demo",
  }, "", "version", "第一版")];
  const env = install(state);
  context.after(env.restore);
  const home = await loadPage("index");
  await call(home, "refresh");
  await call(home, "deleteProfile", tap("member-1"));
  assert.match(env.dialogs[env.dialogs.length - 1], /书稿和所有版本会放进「最近删除」.*1 段记忆留在记忆库里/);
  assert.ok(!ids(home.data.profileOptions).includes("member-1"));
  assert.equal(home.data.memoryCount, 2, "the memories it told stay in the shared pool");
  assert.equal(env.room().manuscriptRevisions?.length, 1, "its book is kept");

  await call(home, "deleteProfile", tap("owner"));
  assert.match(env.toasts[env.toasts.length - 1], /正在使用的档案不能删除/);

  const profiles = await loadPage("profiles", {});
  await call(profiles, "refresh");
  assert.deepEqual(ids(profiles.data.trash), ["member-1"]);
  await call(profiles, "restoreMember", tap("member-1"));
  assert.deepEqual(ids(profiles.data.trash), []);
  await call(home, "refresh");
  assert.ok(ids(home.data.profileOptions).includes("member-1"));
  await call(home, "chooseProfile", tap("member-1"));
  assert.equal(env.toasts[env.toasts.length - 1], "现在是林秋的人生之书");
});

test("deleting a person from the people list clears its references and can be restored", async (context) => {
  const state = createDemoRoomStateForTests();
  state.members = state.members.map((member) => member.id === "friend-1" ? { ...member, kind: "person" as const } : member);
  state.contributions.push(createContribution({
    id: "mentions-friend", authorMemberId: "owner", authorName: "林岚", relation: "外孙女", text: "提到周明的虚构记忆。",
    scope: "personal", visibility: "private", relatedMemberIds: ["friend-1"], sharedWithMemberIds: ["friend-1"],
  }));
  const env = install(state);
  context.after(env.restore);
  const people = await loadPage("profiles", { mode: "people" });
  await call(people, "refresh");
  await call(people, "removeMember", tap("friend-1"));
  assert.match(env.dialogs[env.dialogs.length - 1], /记忆本身不删/);
  assert.deepEqual(ids(people.data.profiles), []);
  assert.deepEqual(ids(people.data.trash), ["friend-1"]);
  const memory = env.room().contributions.find((item) => item.id === "mentions-friend")!;
  assert.equal(memory.relatedMemberIds, undefined);
  assert.equal(memory.sharedWithMemberIds, undefined);
  assert.equal(memory.text, "提到周明的虚构记忆。");

  await call(people, "restoreMember", tap("friend-1"));
  assert.deepEqual(ids(people.data.profiles), ["friend-1"]);
});
