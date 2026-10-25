import assert from "node:assert/strict";
import test from "node:test";

import { createContribution, createEmptyRoomState, FamilyRoomState } from "../miniprogram/domain/biography";
import { makeRevision } from "../miniprogram/services/manuscript";
import { createDemoRoomStateForTests } from "./fixtures";

type PageDefinition = { data?: Record<string, unknown>; [key: string]: unknown };
type PageInstance = PageDefinition & { data: Record<string, unknown>; setData(update: Record<string, unknown>): void };

let definition: PageDefinition | undefined;

async function loadRoom(): Promise<PageInstance> {
  if (!definition) {
    (globalThis as any).Page = (captured: PageDefinition) => { definition = captured; };
    try { await import("../miniprogram/pages/room/room"); } finally { delete (globalThis as any).Page; }
    assert.ok(definition);
  }
  const page = { ...definition, data: structuredClone(definition.data ?? {}) } as PageInstance;
  page.setData = (update) => Object.assign(page.data, update);
  return page;
}

const call = (page: PageInstance, method: string, ...args: unknown[]) =>
  (page[method] as (...values: unknown[]) => unknown).apply(page, args);
const tap = (id: string) => ({ currentTarget: { dataset: { id } } });
const ids = (items: unknown) => (items as Array<{ id: string }>).map((item) => item.id);

function install(state: FamilyRoomState) {
  const stored = new Map<string, unknown>([["shiguang-family-room-v5", state], ["shiguang-current-member-v1", "owner"]]);
  const navigations: string[] = [];
  const previous = (globalThis as any).wx;
  (globalThis as any).wx = {
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: unknown) => stored.set(key, value),
    navigateTo: ({ url }: { url: string }) => navigations.push(url),
    showToast: () => undefined,
  };
  return { navigations, restore: () => { (globalThis as any).wx = previous; } };
}

/** 一段和周明有关的记忆、一段已经写进书的记忆，外加示例数据里那一段。 */
function stateWithPeopleMemories(): FamilyRoomState {
  const state = createDemoRoomStateForTests();
  state.contributions.push(createContribution({
    id: "with-friend", authorMemberId: "owner", authorName: "林岚", relation: "外孙女",
    text: "和周明一起走夜路回家的那次。", scope: "personal", visibility: "private",
    relatedMemberIds: ["friend-1"], now: new Date("2026-09-01T02:00:00.000Z"),
  }));
  state.contributions.push(createContribution({
    id: "in-book", authorMemberId: "owner", authorName: "林岚", relation: "外孙女",
    text: "已经写进书的一段虚构记忆。", scope: "personal", visibility: "private",
    now: new Date("2026-09-02T02:00:00.000Z"),
  }));
  state.manuscriptRevisions = [makeRevision("owner", {
    title: "书", paragraphs: [], sourceCount: 1, generatedAt: "", generationMode: "local-demo",
    chapters: [{ id: "chapter-a", title: "", memoryIds: ["in-book"], content: [{ text: "正文\n" }] }],
  }, "", "version", "第一版")];
  return state;
}

test("Memory Home lists people first; choosing one shows the memories connected to them", async (context) => {
  const env = install(stateWithPeopleMemories());
  context.after(env.restore);
  const room = await loadRoom();
  await call(room, "refresh");

  const people = room.data.people as Array<{ id: string; name: string; count: number }>;
  assert.deepEqual([people[0].id, people[0].name, people[0].count], ["me", "你", 3], "you come first, with every memory");
  assert.equal(people.find((person) => person.id === "friend-1")?.count, 1);
  assert.equal(people.length, 6, "you plus everyone on the list");

  await call(room, "choosePerson", tap("friend-1"));
  assert.deepEqual(ids(room.data.memories), ["with-friend"]);
  assert.equal(room.data.activeName, "周明");

  await call(room, "choosePerson", tap("me"));
  assert.deepEqual(ids(room.data.memories), ["in-book", "with-friend", "demo-personal-rain"], "newest first");
});

test("Memory Home shows memories whether or not they are written into a book", async (context) => {
  const env = install(stateWithPeopleMemories());
  context.after(env.restore);
  const room = await loadRoom();
  await call(room, "refresh");

  const rows = room.data.memories as Array<{ id: string; placeLabel: string }>;
  assert.match(rows.find((row) => row.id === "in-book")!.placeLabel, /写进了 林岚的书第一章/);
  assert.equal(rows.find((row) => row.id === "with-friend")!.placeLabel, "还没写进书");
  assert.equal(room.data.hasMemories, true);

  call(room, "openMemory", tap("with-friend"));
  call(room, "openPeople");
  assert.deepEqual(env.navigations, ["/pages/archive/archive?id=with-friend"]);
  assert.equal(room.data.editorOpen, true, "person editing stays inside Memory Home");
});

test("a new room without profiles displays an empty state instead of a load error", async (context) => {
  const env = install(createEmptyRoomState());
  context.after(env.restore);
  const room = await loadRoom();
  await call(room, "refresh");
  assert.equal(room.data.loadError, "");
  assert.equal(room.data.hasAnyMemory, false);
  assert.deepEqual(ids(room.data.people), ["me"]);
  assert.equal(room.data.viewerId, "");
});

test("a person with no memories yet says so instead of looking empty", async (context) => {
  const env = install(stateWithPeopleMemories());
  context.after(env.restore);
  const room = await loadRoom();
  await call(room, "refresh");
  await call(room, "choosePerson", tap("member-2"));

  assert.deepEqual(ids(room.data.memories), []);
  assert.equal(room.data.hasMemories, false);
  assert.equal(room.data.hasAnyMemory, true, "the page still knows there are memories elsewhere");
  assert.equal(room.data.activeName, "陈野");
});

test('received accounts stay separate from same-named story characters and filter shares in place', async context => {
  const state = stateWithPeopleMemories(), env = install(state); context.after(env.restore);
  const room = await loadRoom();
  room.allActivity = [{id:'message-one',accountKey:'trusted-one',name:'周明',verified:true,at:'2026-10-25',kind:'发来文章',title:'只分享给我的文章',text:'独立分享的正文',imageCount:1,changes:[],comparisonAvailable:true,storyId:''}];
  await call(room,'refresh');
  assert.ok(ids(room.data.people).includes('account:trusted-one'));
  assert.ok(ids(room.data.people).includes('friend-1'));
  await call(room,'choosePerson',tap('account:trusted-one'));
  assert.equal(room.data.canEditPerson,false,'a sender account is not a locally editable character');
  assert.equal((room.data.sharedArticles as any[])[0].text,'独立分享的正文');
  assert.deepEqual(room.data.memories,[]);
  await call(room,'choosePerson',tap('friend-1'));
  assert.deepEqual(room.data.sharedArticles,[],'matching names must not disclose another identity’s activity');
});

test('shared family view refuses person mutations even if its event handlers are called directly', async context => {
  const env=install(stateWithPeopleMemories());context.after(env.restore);
  const room=await loadRoom();
  room.setData({sharedFamilyId:'someone-else',nameInput:'should-not-save',editingId:'friend-1',canEditPerson:true});
  await call(room,'savePerson');await call(room,'removePerson');await call(room,'editPerson');
  assert.equal(room.data.editorOpen,false);assert.equal(room.data.personSaving,false);
});
