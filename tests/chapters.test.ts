import assert from "node:assert/strict";
import test from "node:test";
import { BiographyDraft, ManuscriptChapter } from "../miniprogram/domain/biography";
import { chapterLabel, chaptersOf, draftWithChapters, flattenChapters, memoryIdsFromFingerprint, validateManuscriptDraft } from "../miniprogram/services/chapters";
import { makeRevision, saveManuscriptRevision } from "../miniprogram/services/manuscript";
import { createDemoRoomStateForTests } from "./fixtures";

const base: BiographyDraft = { title: "外公和雨天", paragraphs: [], sourceCount: 1, generatedAt: "", generationMode: "local-demo" };

function chapter(id: string, title: string, text: string, photos: string[] = []): ManuscriptChapter {
  return { id, title, memoryIds: [], content: [{ text }, ...photos.map(photoId => ({ photoId }))] };
}

test("chapter numbers follow the chapter order in Chinese", () => {
  assert.deepEqual([1, 2, 9, 10, 11, 20, 23, 30].map(chapterLabel),
    ["第一章", "第二章", "第九章", "第十章", "第十一章", "第二十章", "第二十三章", "第三十章"]);
});

test("a flat older book reads as one first chapter with its photos, without being rewritten", () => {
  const flat: BiographyDraft = {
    ...base, paragraphs: ["前文", "后文"],
    content: [{ text: "前文\n" }, { photoId: "photo-first" }, { text: "后文【本机照片：photo-marker】\n" }],
  };
  const before = structuredClone(flat);
  const fingerprint = JSON.stringify({ memberId: "owner", sources: [{ id: "memory-a" }, { id: "memory-b" }] });
  const [only, ...rest] = chaptersOf(flat, fingerprint);
  assert.equal(rest.length, 0);
  assert.equal(only.id, "chapter-1");
  assert.equal(only.title, "");
  assert.deepEqual(only.memoryIds, ["memory-a", "memory-b"]);
  assert.deepEqual(only.content.flatMap(item => item.photoId ? [item.photoId] : []), ["photo-first", "photo-marker"]);
  assert.deepEqual(flat, before, "migration happens in memory only");
  assert.deepEqual(memoryIdsFromFingerprint("not json"), []);
  const legacyText: BiographyDraft = { ...base, paragraphs: ["只有文字", "没有图文字段"] };
  assert.deepEqual(chaptersOf(legacyText)[0].content, [{ text: "只有文字\n\n没有图文字段\n" }]);
});

test("the flattened copy lets older clients read every chapter heading, text and photo in order", () => {
  const draft = draftWithChapters(base, [
    chapter("chapter-1", "雨天的巷口", "外公带着两把伞。\n", ["photo-a"]),
    chapter("chapter-2", "", "修收音机的父亲。\n", ["photo-b"]),
  ]);
  assert.equal(draft.title, "外公和雨天", "the book title stays separate from chapter titles");
  assert.deepEqual(draft.paragraphs, ["第一章　雨天的巷口", "外公带着两把伞。", "第二章", "修收音机的父亲。"]);
  assert.deepEqual(draft.content!.flatMap(item => item.photoId ? [item.photoId] : []), ["photo-a", "photo-b"]);
  validateManuscriptDraft(draft);
  assert.deepEqual(chaptersOf(draft), draft.chapters, "a chaptered book keeps its own chapters");
  assert.throws(() => validateManuscriptDraft({ ...draft, paragraphs: ["被旧版改过的全文"] }), /章节和全文不一致/);
});

test("a long book near the limits still saves because the flattened copy is not counted twice", async context => {
  const before = (globalThis as any).wx;
  const beforeApp = (globalThis as any).getApp;
  context.after(() => { (globalThis as any).wx = before; (globalThis as any).getApp = beforeApp; });
  const stored = new Map<string, unknown>([["shiguang-family-room-v5", createDemoRoomStateForTests()]]);
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: true } });
  (globalThis as any).wx = { getStorageSync: (key: string) => stored.get(key), setStorageSync: (key: string, value: unknown) => stored.set(key, value) };

  const long = (length: number) => "长".repeat(length - 1) + "\n";
  const chapters = [
    chapter("chapter-1", "雨天的巷口", long(6663), ["photo-a1", "photo-a2", "photo-a3"]),
    chapter("chapter-2", "修收音机的父亲", long(6663), ["photo-b1", "photo-b2", "photo-b3"]),
    chapter("chapter-3", "搬家那年", long(6664), ["photo-c1", "photo-c2", "photo-c3"]),
  ];
  const draft = draftWithChapters(base, chapters);
  assert.ok(draft.paragraphs.join("\n").length > 20000, "the derived copy alone would trip the old text limit");
  const state = await saveManuscriptRevision(makeRevision("owner", draft, "", "version", "长书稿"), "");
  const saved = state.manuscriptRevisions!;
  assert.equal(saved[saved.length - 1].draft.chapters!.length, 3);

  const tooLong = draftWithChapters(base, [...chapters.slice(0, 2), chapter("chapter-3", "搬家那年", long(6675))]);
  await assert.rejects(saveManuscriptRevision(makeRevision("owner", tooLong, "", "version", "超长"), ""), /正文最多 20000 字/);
  const tooManyPhotos = draftWithChapters(base, [...chapters, chapter("chapter-4", "", "再加一张\n", ["photo-d1"])]);
  await assert.rejects(saveManuscriptRevision(makeRevision("owner", tooManyPhotos, "", "version", "十张照片"), ""), /最多放 9 张照片/);
});

test("chapter operations keep one memory in one chapter and only append to the selected chapter", async () => {
  const { addChapter, assignMemory, moveChapter, placeMemoryInChapter, removeChapter, unassignedMemoryIds, updateChapter } = await import("../miniprogram/services/chapters");
  const one = { ...chapter("chapter-1", "一", "第一章正文\n", ["photo-a"]), memoryIds: ["m1", "m2"] };
  const two = { ...chapter("chapter-2", "二", "第二章正文\n"), memoryIds: ["m3"] };
  const added = addChapter([one, two], "三", ["m2"], "chapter-3");
  assert.deepEqual(added.map(item => item.memoryIds), [["m1"], ["m3"], ["m2"]], "a memory moves instead of being copied");
  assert.deepEqual(added[0].content, one.content);
  assert.deepEqual(assignMemory(added, "m1", "chapter-2").map(item => item.memoryIds), [[], ["m3", "m1"], ["m2"]]);
  assert.deepEqual(unassignedMemoryIds(assignMemory(added, "m1", ""), ["m1", "m2", "m3", "m4"]), ["m1", "m4"]);
  assert.deepEqual(moveChapter(added, "chapter-3", -1).map(item => item.id), ["chapter-1", "chapter-3", "chapter-2"]);
  assert.deepEqual(moveChapter(added, "chapter-1", -1).map(item => item.id), ["chapter-1", "chapter-2", "chapter-3"]);
  assert.deepEqual(removeChapter(added, "chapter-2").map(item => item.id), ["chapter-1", "chapter-3"]);
  assert.throws(() => removeChapter([one], "chapter-1"), /至少要保留一章/);
  const edited = updateChapter(added, "chapter-2", { title: " 新名字 ", content: [{ text: "改过的\n" }] });
  assert.equal(edited[1].title, "新名字");
  assert.equal(edited[1].handEdited, true);
  assert.deepEqual(edited[0], added[0]);
  assert.equal(updateChapter(added, "chapter-2", { title: "只改名" })[1].handEdited, undefined);
  assert.deepEqual(one.memoryIds, ["m1", "m2"], "inputs are never mutated");

  const placed = placeMemoryInChapter(added, { id: "m4", text: "新放进来的原始记忆。" }, "chapter-1");
  assert.deepEqual(placed[0].memoryIds, ["m1", "m4"]);
  assert.deepEqual(placed[0].content, [
    { text: "第一章正文\n" },
    { photoId: "photo-a" },
    { text: "\n新放进来的原始记忆。\n" },
  ], "the memory text is appended without moving the existing photo");
  assert.equal(placed[0].handEdited, true);
  assert.deepEqual(placed[1], added[1], "other chapters remain unchanged");

  const repaired = placeMemoryInChapter(added, { id: "m1", text: "旧归档里漏掉的正文。" }, "chapter-1");
  assert.match(repaired[0].content.map(item => item.text ?? "").join(""), /旧归档里漏掉的正文/,
    "an existing chapter assignment with missing text can be repaired");

  const repeated = placeMemoryInChapter(placed, { id: "m4", text: "新放进来的原始记忆。" }, "chapter-1");
  assert.deepEqual(repeated[0].content, placed[0].content, "placing the same memory twice does not duplicate its text");
  const removed = assignMemory(placed, "m4", "");
  assert.deepEqual(removed[0].content, placed[0].content, "removing a memory keeps the editable chapter text");
  const restored = placeMemoryInChapter(removed, { id: "m4", text: "新放进来的原始记忆。" }, "chapter-1");
  assert.deepEqual(restored[0].content, placed[0].content, "putting a removed memory back does not duplicate text already present");
});

test("organizing replaces only the target chapter's text, keeps its photos (even old markers) and moves the chosen memories", async () => {
  const { applyOrganized, organizedChapterTitle } = await import("../miniprogram/services/chapters");
  const [first] = chaptersOf({ ...base, paragraphs: ["前文【本机照片：photo-legacy】后文"] });
  const second = { ...chapter("chapter-2", "二", "第二章正文\n", ["photo-b"]), memoryIds: ["m1"], handEdited: true };
  const ai = { ...base, title: "第一章｜我记得的那一天", paragraphs: ["新正文"] };
  const result = applyOrganized([first, { ...second }], "chapter-1", ai, ["m1"]);
  assert.deepEqual(result.keptPhotoIds, ["photo-legacy"]);
  assert.deepEqual(result.chapters[0].content, [{ text: "新正文\n" }, { photoId: "photo-legacy" }, { text: "\n" }]);
  assert.equal(result.chapters[0].title, "", "template AI titles never become chapter names");
  assert.deepEqual(result.chapters[0].memoryIds, ["m1"]);
  assert.deepEqual(result.chapters[1], { ...second, memoryIds: [] }, "other chapters keep their text, photos and hand edits");
  const created = applyOrganized([first], "new", { ...ai, title: "第二章｜雨天的巷口" }, []);
  assert.equal(created.chapters.length, 2);
  assert.equal(created.chapters[1].title, "雨天的巷口");
  assert.deepEqual(created.chapters[0], first);
  assert.equal(organizedChapterTitle("被记住的日常"), "");
});

test("chapter structure is checked before saving", () => {
  const good = chapter("chapter-1", "章名", "正文\n");
  assert.throws(() => validateManuscriptDraft(draftWithChapters(base, [good, { ...good }])), /章节编号无效/);
  assert.throws(() => validateManuscriptDraft(draftWithChapters(base, [{ ...good, title: "长".repeat(41) }])), /章节标题最多 40 字/);
  assert.throws(() => validateManuscriptDraft(draftWithChapters(base, [{ ...good, id: "../1" }])), /章节编号无效/);
  assert.throws(() => validateManuscriptDraft({ ...draftWithChapters(base, [good]), chapters: [] }), /最多 30 章/);
  assert.equal(flattenChapters([good]).paragraphs[0], "第一章　章名");
});
