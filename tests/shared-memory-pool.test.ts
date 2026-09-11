import assert from "node:assert/strict";
import test from "node:test";

import { createContribution, FamilyRoomState } from "../miniprogram/domain/biography";
import { generateBiographyWithStatus } from "../miniprogram/services/biographyService";
import { createDemoRoomStateForTests } from "./fixtures";

type PageDefinition = { data?: Record<string, unknown>; [key: string]: unknown };
type PageInstance = PageDefinition & { data: Record<string, unknown>; setData(update: Record<string, unknown>): void };

async function loadPage(name: "archive" | "stories" | "book"): Promise<PageInstance> {
  let captured: PageDefinition | undefined;
  (globalThis as any).Page = (definition: PageDefinition) => { captured = definition; };
  try {
    if (name === "archive") await import("../miniprogram/pages/archive/archive");
    else if (name === "stories") await import("../miniprogram/pages/stories/stories");
    else await import("../miniprogram/pages/book/book");
  } finally { delete (globalThis as any).Page; }
  assert.ok(captured);
  const page = { ...captured, data: structuredClone(captured.data ?? {}) } as PageInstance;
  page.setData = (update) => Object.assign(page.data, update);
  return page;
}

function install(state: FamilyRoomState, currentMemberId = "owner") {
  const stored = new Map<string, unknown>([["shiguang-family-room-v5", state], ["shiguang-current-member-v1", currentMemberId]]);
  const previousWx = (globalThis as any).wx;
  const previousApp = (globalThis as any).getApp;
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: false } });
  (globalThis as any).wx = {
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: unknown) => stored.set(key, value),
    showToast: () => undefined,
  };
  return {
    select: (memberId: string) => stored.set("shiguang-current-member-v1", memberId),
    restore: () => { (globalThis as any).wx = previousWx; (globalThis as any).getApp = previousApp; },
  };
}

function stateWithTwoNarrators(): FamilyRoomState {
  const state = createDemoRoomStateForTests();
  state.contributions.push(createContribution({
    id: "told-by-qiu", authorMemberId: "member-1", authorName: "林秋", relation: "女儿",
    text: "林秋讲的一段虚构记忆。", storyTitle: "林秋的故事", scope: "personal", visibility: "private",
  }));
  return state;
}

test("the memory and story lists show every profile's memories and name other narrators", async (context) => {
  const env = install(stateWithTwoNarrators());
  context.after(env.restore);
  const archive = await loadPage("archive");
  await (archive.refresh as () => Promise<void>).call(archive);
  const notes = archive.data.notes as Array<{ id: string; archiveLabel: string }>;
  assert.deepEqual(notes.map((note) => note.id).sort(), ["demo-personal-rain", "told-by-qiu"]);
  assert.match(notes.find((note) => note.id === "told-by-qiu")!.archiveLabel, /^林秋 讲述/);
  assert.doesNotMatch(notes.find((note) => note.id === "demo-personal-rain")!.archiveLabel, /讲述/);

  const stories = await loadPage("stories");
  await (stories.refresh as () => Promise<void>).call(stories);
  assert.ok((stories.data.stories as Array<{ title: string }>).some((story) => story.title === "林秋的故事"));
});

test("every profile's book can use any memory in the pool", async (context) => {
  const state = stateWithTwoNarrators();
  const env = install(state);
  context.after(env.restore);
  const book = await loadPage("book");
  await (book.refresh as () => Promise<void>).call(book);
  const rows = book.data.unassigned as Array<{ id: string; text: string }>;
  assert.ok(rows.some((row) => row.id === "told-by-qiu" && row.text.startsWith("林秋讲：")));
  assert.ok(rows.some((row) => row.id === "demo-personal-rain" && !row.text.includes("讲：")));
  assert.ok(!rows.some((row) => row.id === "demo-memory-rain"), "family-review submissions stay out of books");

  env.select("member-1");
  await (book.refresh as () => Promise<void>).call(book);
  assert.ok((book.data.unassigned as Array<{ id: string }>).some((row) => row.id === "demo-personal-rain"), "the same memory is available to another book");

  const owner = state.members.find((member) => member.id === "owner")!;
  const { draft } = await generateBiographyWithStatus(state, owner, { memoryIds: ["told-by-qiu", "demo-memory-rain"] });
  assert.equal(draft.sourceCount, 1, "a chapter may use another narrator's memory but never a family-review submission");
  assert.ok(draft.paragraphs.includes("林秋讲的一段虚构记忆。"));
});
