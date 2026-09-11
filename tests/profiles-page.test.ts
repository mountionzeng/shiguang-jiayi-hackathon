import assert from "node:assert/strict";
import test from "node:test";

import { createContribution, createEmptyRoomState, FamilyRoomState } from "../miniprogram/domain/biography";
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
const tap = (id: string) => ({ currentTarget: { dataset: { id } } });
const ids = (items: unknown) => (items as Array<{ id: string }>).map((item) => item.id);

function install(state: FamilyRoomState, currentMemberId = "owner") {
  const stored = new Map<string, unknown>([["shiguang-family-room-v5", state], ["shiguang-current-member-v1", currentMemberId]]);
  const toasts: string[] = [];
  const dialogs: string[] = [];
  let backCount = 0;
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
    navigateBack: () => { backCount += 1; },
    navigateTo: () => undefined,
  };
  return {
    toasts, dialogs,
    backCount: () => backCount,
    current: () => stored.get("shiguang-current-member-v1"),
    room: () => stored.get("shiguang-family-room-v5") as FamilyRoomState,
    restore: () => { (globalThis as any).wx = previous; },
  };
}

test("the people page lists everyone except the author, labels access, and adds people without switching books", async (context) => {
  const state = createDemoRoomStateForTests();
  state.members.push({ id: "self-book", name: "岱", relation: "自己", avatarText: "岱", role: "owner", kind: "recording-profile" });
  const env = install(state);
  context.after(env.restore);
  const people = await loadPage("profiles", {});
  await call(people, "refresh");
  assert.equal(people.data.view, "people");
  const rows = people.data.people as Array<{ id: string; permission: string; canDelete: boolean }>;
  assert.ok(!ids(rows).includes("self-book"), "the author's own book is not listed as a person");
  assert.ok(rows.every((row) => row.permission === "还没邀请"), "nobody has access before real invitations exist");
  assert.equal(rows.find((row) => row.id === "owner")?.canDelete, false, "the book being written cannot be deleted");

  people.setData({ nameInput: "测试朋友", relationInput: "朋友" });
  await call(people, "addPerson");
  const friend = env.room().members.find((member) => member.name === "测试朋友")!;
  assert.equal(friend.kind, "person");
  assert.equal(env.current(), "owner", "adding a person never switches the book");
  assert.ok(ids(people.data.people).includes(friend.id));

  people.setData({ nameInput: "还是我", relationInput: "自己" });
  await call(people, "addPerson");
  assert.match(env.toasts[env.toasts.length - 1], /你自己就是主笔/);

  const home = await loadPage("index");
  await call(home, "refresh");
  assert.equal(home.data.ownerAvatarText, "岱", "the home avatar is the author");
  assert.equal(home.data.peopleCount, 6);
});

test("a new book starts from its own view, and an account without any book is sent there", async (context) => {
  const env = install(createEmptyRoomState(), "");
  context.after(env.restore);
  const page = await loadPage("profiles", {});
  await call(page, "refresh");
  assert.equal(page.data.view, "new-book");
  page.setData({ nameInput: "岱" });
  await call(page, "createBook");
  const own = env.room().members.find((member) => member.name === "岱")!;
  assert.deepEqual([own.kind, own.relation, env.current(), env.backCount()], ["recording-profile", "自己", own.id, 1]);

  const another = await loadPage("profiles", { mode: "new-book" });
  await call(another, "refresh");
  assert.equal(another.data.view, "new-book");
  another.setData({ nameInput: "萍", relationInput: "妈妈" });
  await call(another, "createBook");
  const mom = env.room().members.find((member) => member.name === "萍")!;
  assert.deepEqual([mom.kind, mom.relation, env.current()], ["recording-profile", "妈妈", mom.id]);
});

test("deleting another book hides its story on home, keeps its memories, and restoring brings it back", async (context) => {
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
  const stories = () => (home.data.storyOptions as Array<{ title: string }>).map((item) => item.title);
  await call(home, "refresh");
  assert.ok(stories().includes("林秋的书"), "every profile's book is a story on home");

  const people = await loadPage("profiles", {});
  await call(people, "refresh");
  await call(people, "removeMember", tap("member-1"));
  assert.match(env.dialogs[env.dialogs.length - 1], /书稿和所有版本会放进「最近删除」.*记忆都还在记忆库里/);
  await call(home, "refresh");
  assert.ok(!stories().includes("林秋的书"));
  assert.equal(home.data.memoryCount, 2, "the memories it told stay in the shared pool");
  assert.equal(env.room().manuscriptRevisions?.length, 1, "its book is kept");

  await call(people, "removeMember", tap("owner"));
  assert.match(env.toasts[env.toasts.length - 1], /这是你自己，不能删除/);

  assert.deepEqual(ids(people.data.trash), ["member-1"]);
  await call(people, "restoreMember", tap("member-1"));
  assert.deepEqual(ids(people.data.trash), []);
  await call(home, "refresh");
  assert.ok(stories().includes("林秋的书"));
});

test("deleting a person clears its references, keeps the memory, and can be restored", async (context) => {
  const state = createDemoRoomStateForTests();
  state.members = state.members.map((member) => member.id === "friend-1" ? { ...member, kind: "person" as const } : member);
  state.contributions.push(createContribution({
    id: "mentions-friend", authorMemberId: "owner", authorName: "林岚", relation: "外孙女", text: "提到周明的虚构记忆。",
    scope: "personal", visibility: "private", relatedMemberIds: ["friend-1"], sharedWithMemberIds: ["friend-1"],
  }));
  const env = install(state);
  context.after(env.restore);
  const people = await loadPage("profiles", {});
  await call(people, "refresh");
  await call(people, "removeMember", tap("friend-1"));
  assert.match(env.dialogs[env.dialogs.length - 1], /记忆本身不删/);
  assert.ok(!ids(people.data.people).includes("friend-1"));
  assert.deepEqual(ids(people.data.trash), ["friend-1"]);
  const memory = env.room().contributions.find((item) => item.id === "mentions-friend")!;
  assert.equal(memory.relatedMemberIds, undefined);
  assert.equal(memory.sharedWithMemberIds, undefined);
  assert.equal(memory.text, "提到周明的虚构记忆。");

  await call(people, "restoreMember", tap("friend-1"));
  assert.ok(ids(people.data.people).includes("friend-1"));
});
