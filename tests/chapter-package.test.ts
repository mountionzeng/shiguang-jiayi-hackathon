import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ManuscriptChapter } from "../miniprogram/domain/biography";
import {
  AI_PHOTO_ID, ChapterPackageError, chapterPackageBlockId, fromChapterPackage, parseChapterPackage,
  sha256Hex, toChapterPackage,
} from "../miniprogram/domain/chapterPackage";
import { isStoryImageReference } from "../miniprogram/services/bookImages";

const DIR = join(__dirname, "fixtures", "chapter-package");
const load = (name: string) => JSON.parse(readFileSync(join(DIR, name), "utf8"));
const codeOf = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof ChapterPackageError ? e.code : `other:${String(e)}`; }
  return null;
};
const meta = { packageId: "cp_test-0000001", createdAt: "2026-10-22T00:00:00.000Z", displayName: "小满" };
const img = (c: string, ai = false) => ({ mime: "image/jpeg" as const, bytes: 1000, sha256: c.repeat(64), width: 800, height: 600, aiGenerated: ai });

test("sha256Hex matches node:crypto", () => {
  for (const t of ["", "abc", "中文测试", "👩‍👧é", "a".repeat(200), "x".repeat(55), "x".repeat(56), "x".repeat(64)])
    assert.equal(sha256Hex(t), createHash("sha256").update(t, "utf8").digest("hex"));
});

test("AI photo regex equals the services one", () => {
  for (const v of ["photo-ai-req-abcdef12", "photo-ai-req-short", "photo-ai-req-ABCDEF12", "photo-local-1", "photo-ai-xyz", "photo-ai-req-" + "a".repeat(60), "photo-ai-req-" + "a".repeat(61), ""])
    assert.equal(AI_PHOTO_ID.test(v), isStoryImageReference(v), v);
});

test("fixtures SHA256SUMS match", () => {
  const lines = readFileSync(join(DIR, "SHA256SUMS"), "utf8").trim().split("\n");
  assert.deepEqual(lines.map(l => l.split("  ")[1]), readdirSync(DIR).filter(f => f.endsWith(".json")).sort());
  for (const l of lines) {
    const [h, n] = l.split("  ");
    assert.equal(createHash("sha256").update(readFileSync(join(DIR, n))).digest("hex"), h);
  }
});

test("invalid fixtures give the agreed error codes", () => {
  for (const [f, c] of [["invalid-version.json", "UNSUPPORTED_VERSION"], ["invalid-missing-block.json", "MISSING_BLOCK_REF"],
    ["invalid-missing-asset.json", "MISSING_ASSET_REF"], ["invalid-over-limit.json", "LIMIT_EXCEEDED"],
    ["invalid-forbidden-identifier.json", "FORBIDDEN_IDENTIFIER"]])
    assert.equal(codeOf(() => parseChapterPackage(load(f))), c, f);
});

test("valid fixtures parse and the content is one line per block", () => {
  for (const f of readdirSync(DIR).filter(f => f.startsWith("valid-"))) {
    const pkg = parseChapterPackage(load(f));
    const out = fromChapterPackage(pkg);
    assert.equal(out.blockIds.length, out.chapter.content.length);
    for (const item of out.chapter.content) if ("text" in item && item.text !== undefined) assert.equal(item.text.indexOf("\n"), item.text.length - 1);
    assert.doesNotMatch(readFileSync(join(DIR, f), "utf8"), /family_|openid|_img_req-/i);
  }
});

test("layout and AI marks survive a round trip", () => {
  const pkg = parseChapterPackage(load("valid-02-layout-two-images.json"));
  const out = fromChapterPackage(pkg);
  assert.deepEqual(out.layout, pkg.chapters[0].layout);
  assert.deepEqual(out.unplacedBlockIds, []);
  const ai = fromChapterPackage(load("valid-04-ai-marked.json"));
  assert.equal(ai.chapter.containsAiText, true);
  assert.ok(Object.values(ai.assetPhotos).every(p => AI_PHOTO_ID.test(p)));
});

test("mini-program chapter -> package -> chapter keeps non-empty lines and photo positions", () => {
  const chapter: ManuscriptChapter = {
    id: "chapter-a", title: "外公和雨天", memoryIds: ["m1"],
    content: [{ text: "第一行\n第二行\n\n第三行\n", blockId: `block-${"a".repeat(64)}`, sourceIds: ["s1"] }, { photoId: "photo-local-1" }, { text: "尾声" }],
  };
  const r = toChapterPackage(chapter, { "photo-local-1": img("a") }, meta);
  const texts = r.package.chapters[0].blocks.map(b => (b.type === "text" ? b.text : "[img]"));
  assert.deepEqual(texts, ["第一行", "第二行", "第三行", "[img]", "尾声"]);
  assert.equal(r.package.chapters[0].blocks[0].blockId, `block-${"a".repeat(64)}`);
  assert.notEqual(r.package.chapters[0].blocks[1].blockId, r.package.chapters[0].blocks[0].blockId);
  const json = JSON.stringify(r.package);
  assert.doesNotMatch(json, /photo-local|sourceIds|memoryIds|"m1"/);
  const back = fromChapterPackage(r.package, { resolvePhotoId: a => r.assetPhotos[a] });
  assert.deepEqual(back.chapter.content, [{ text: "第一行\n" }, { text: "第二行\n" }, { text: "第三行\n" }, { photoId: "photo-local-1" }, { text: "尾声\n" }]);
  assert.deepEqual(back.blockIds, r.blockIds);
  assert.equal("blockId" in back.chapter.content[0], false);
});

test("ids are deterministic and AI photos are marked", () => {
  const chapter: ManuscriptChapter = { id: "chapter-b", title: "t", memoryIds: [], content: [{ text: "甲" }, { photoId: "photo-ai-req-abcdef12" }] };
  const a = toChapterPackage(chapter, { "photo-ai-req-abcdef12": img("c") }, meta);
  const b = toChapterPackage(chapter, { "photo-ai-req-abcdef12": img("c") }, { ...meta, packageId: "cp_test-0000002" });
  assert.deepEqual(a.blockIds, b.blockIds);
  assert.equal(a.package.assets[0].aiGenerated, true);
  assert.equal(a.blockIds[0], chapterPackageBlockId(["chapter-package-v1", "chapter-b", 0, "text", "甲"]));
  assert.equal(codeOf(() => toChapterPackage(chapter, {}, meta)), "ASSET_INFO_MISSING");
});

test("cross-end: web-made package gives the same lines and package round-trips", () => {
  const pkg = parseChapterPackage(load("valid-01-text-only.json"));
  const out = fromChapterPackage(pkg);
  const lines = out.chapter.content.map(c => ("text" in c ? c.text!.split("\n")[0] : ""));
  assert.deepEqual(lines, pkg.chapters[0].blocks.map(b => (b.type === "text" ? b.text : "")));
  const again = toChapterPackage(out.chapter, {}, { ...meta, lineage: pkg.lineage });
  assert.deepEqual(again.package.chapters[0].blocks.map(b => b.type === "text" && b.text), pkg.chapters[0].blocks.map(b => b.type === "text" && b.text));
});

test('export omits empty editor placeholders and only their layout bindings', async () => {
  const {articleChapter,changeArticleText} = await import('../miniprogram/services/articleModules');
  const start = articleChapter({id:'chapter-one',title:'测试',memoryIds:[],content:[{text:'正文'}]});
  const edited = changeArticleText(start,start.content[0].blockId,'正文\n').chapter;
  assert.equal(edited.content.length,2);
  const output = toChapterPackage(edited,{},meta,{layout:edited.layout}).package;
  assert.equal(output.chapters[0].blocks.length,1);
  assert.equal(output.chapters[0].layout!.pages[0].modules.length,1);
  assert.equal(edited.layout.pages[0].modules.length,2);
  const broken = structuredClone(edited.layout);
  const module = broken.pages[0].modules[0];
  if(module.kind === 'text') module.bind = {blockId:'block-'+'f'.repeat(64)};
  assert.equal(codeOf(()=>toChapterPackage(edited,{},meta,{layout:broken})),'MISSING_BLOCK_REF');
});
