import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { BiographyDraft, ManuscriptChapter } from "../miniprogram/domain/biography";
import { CHAPTER_PACKAGE_ENABLED } from "../miniprogram/config/runtime";
import { chapterPackageBlockId, parseChapterPackage } from "../miniprogram/domain/chapterPackage";
import { copyChapter, draftWithChapters, flattenChapters, validateManuscriptDraft } from "../miniprogram/services/chapters";
import {
  CHAPTER_LAYOUT_MAX_BYTES, assertLayoutFits, chapterPackageEnabled, chapterPackageImportAttempt, exportChapterPackage, packageImageInfo, prepareImport, utf8Bytes, verifyPackageAssetBytes,
} from "../miniprogram/services/chapterPackageService";
import { chapterLayoutView } from "../miniprogram/services/chapterLayoutView";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require("../miniprogram/domain/storyBookCore.js");

const FIXTURES = join(__dirname, "fixtures", "chapter-package");
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const base: BiographyDraft = { title: "全书", paragraphs: [], sourceCount: 0, generatedAt: "", generationMode: "local-demo" };
const block = (n: string) => "block-" + n.repeat(64);
const mod = (id: string, blockId: string, y = 100) => ({
  id, kind: "text" as const, bind: { blockId }, rect: { x: 60, y, width: 780, height: 80 }, fontSize: 32, contentWidth: 780, contentHeight: 80, alignment: "start" as const,
});
const layoutOf = (modules: ReturnType<typeof mod>[]) => ({
  canvas: { width: 900 as const, height: 1200 as const },
  settings: { fontId: "default", style: "plain", texture: "none", textureSeed: 1, includeCover: false, bodyTextureAssetId: null },
  pages: [{ label: "1", modules }],
}) as unknown as NonNullable<ManuscriptChapter["layout"]>;
const chapterWith = (layout?: ManuscriptChapter["layout"]): ManuscriptChapter => ({
  id: "chapter-one", title: "夏天", memoryIds: [], content: [{ text: "第一行\n" }, { text: "第二行\n" }], ...(layout ? { layout } : {}),
});
const meta = { packageId: "cp_test-0000001", createdAt: "2026-10-23T00:00:00.000Z", displayName: "小满" };

test("one line is one paragraph in the flattened book, for both the client and the shared cloud rule", () => {
  const chapter: ManuscriptChapter = { ...chapterWith(), content: [{ text: "第一行\n第二行\n\n第三段\n" }] };
  const client = flattenChapters([chapter]);
  assert.deepEqual(client.paragraphs, ["第一章　夏天", "第一行", "第二行", "第三段"]);
  assert.deepEqual(core.flatten([chapter]).paragraphs, client.paragraphs);
  assert.doesNotThrow(() => validateManuscriptDraft(draftWithChapters(base, [chapter])));
});

test("chapter package import retries keep the same request id and target", () => {
  const firstTarget = { mode: "new" as const, storyId: "story-stable", title: "夏天" };
  const first = chapterPackageImportAttempt(undefined, undefined, undefined, firstTarget, "request-stable");
  assert.deepEqual(first, { target: firstTarget, requestId: "request-stable" });
  const retry = chapterPackageImportAttempt(first, { mode: "new", storyId: "story-other", title: "不要替换" }, "request-other",
    { mode: "new", storyId: "story-new", title: "另一份" }, "request-new");
  assert.deepEqual(retry, first);
});

test("chapter layout view scales positioned modules and keeps unplaced text readable", () => {
  const firstBlock = block("a");
  const chapter: ManuscriptChapter = { ...chapterWith(layoutOf([mod("text-1", firstBlock)])), content: [
    { text: "第一行\n第二行\n", blockId: firstBlock },
    { text: "未排版文字\n", blockId: block("b") },
  ] };
  const pages = chapterLayoutView(chapter, 450, {});
  assert.equal(pages.length, 2);
  assert.equal(pages[0].height, 600);
  assert.equal(pages[0].modules[0].style, "left:30px;top:50px;width:390px;height:40px;");
  assert.equal(pages[0].modules[0].text, "第一行\n第二行");
  assert.equal(pages[1].modules[0].text, "未排版文字");
});

test("chapter layout view resolves package image modules to their chapter photo references", () => {
  const suffix = "d".repeat(32);
  const photoId = "photo-ai-req-" + suffix;
  const imageLayout = {
    canvas: { width: 900 as const, height: 1200 as const },
    settings: { fontId: "default", style: "plain", texture: "none", textureSeed: 1, includeCover: false, bodyTextureAssetId: null },
    pages: [{ label: "1", modules: [{ id: "image-1", kind: "image" as const, assetId: "asset-" + suffix,
      rect: { x: 0, y: 0, width: 900, height: 600 }, crop: { x: 0, y: 0, width: 1, height: 1 } }] }],
  } as unknown as ManuscriptChapter["layout"];
  const chapter: ManuscriptChapter = { ...chapterWith(imageLayout), content: [{ photoId }],
    packageAssets: { ["asset-" + suffix]: { photoId, aiGenerated: true } } };
  assert.equal(chapterLayoutView(chapter, 450, { [photoId]: "/tmp/photo.png" })[0].modules[0].imagePath, "/tmp/photo.png");
});

test("copyChapter deep-copies the layout so edits to a copy never change the original", () => {
  const original = chapterWith(layoutOf([mod("paragraph-1", block("a"))]));
  const copy = copyChapter(original);
  assert.deepEqual(copy.layout, original.layout);
  copy.layout!.pages[0].modules[0].rect.x = 1;
  assert.equal(original.layout!.pages[0].modules[0].rect.x, 60);
});

test("the layout stays on the chapter through draftWithChapters and does not enter the flattened text", () => {
  const withLayout = chapterWith(layoutOf([mod("paragraph-1", block("a"))]));
  const draft = draftWithChapters(base, [withLayout]);
  assert.deepEqual(draft.chapters![0].layout, withLayout.layout);
  assert.deepEqual(draft.paragraphs, draftWithChapters(base, [chapterWith()]).paragraphs);
});

test("the shared story rule keeps a layout within 60 KB, and the client helper agrees", () => {
  const small = layoutOf([mod("paragraph-1", block("a"))]);
  const large = layoutOf(Array.from({ length: 260 }, (_, i) => mod("paragraph-" + (i + 1), block("a"), i)));
  assert.doesNotThrow(() => assertLayoutFits(small));
  assert.throws(() => assertLayoutFits(large), /60 KB/);
  assert.ok(utf8Bytes(JSON.stringify(large)) > CHAPTER_LAYOUT_MAX_BYTES);
  assert.equal(utf8Bytes("中a😀"), 3 + 1 + 4);
  const draft = draftWithChapters(base, [chapterWith(large)]);
  assert.throws(() => core.validateDraft(draft, { memoryIds: [] }), /60 KB/);
});

test("export builds a valid package, carries the layout and keeps stored block ids", () => {
  const stored = block("c");
  const chapter: ManuscriptChapter = { ...chapterWith(), content: [{ text: "第一行\n", blockId: stored } as never, { text: "第二行\n" }] };
  const layout = layoutOf([mod("paragraph-1", stored)]);
  const { package: pkg, blockIds } = exportChapterPackage({ chapter, ...meta, layout });
  assert.equal(parseChapterPackage(pkg).packageId, meta.packageId);
  assert.equal(blockIds[0], stored);
  assert.equal(blockIds[1], chapterPackageBlockId(["chapter-package-v1", "chapter-one", 1, "text", "第二行"]));
  assert.deepEqual(pkg.chapters[0].layout, layout);
  assert.equal(JSON.stringify(pkg).includes("openid"), false);
});

test("received package lineage is carried from the chapter record, independent of device storage", () => {
  const chapter = { ...chapterWith(), packageLineage: { rootPackageId: "cp_root0001", receivedPackageId: "cp_parent01" } };
  const { package: pkg } = exportChapterPackage({ chapter, ...meta });
  assert.deepEqual(pkg.lineage, { rootPackageId: "cp_root0001", parentPackageId: "cp_parent01" });
  assert.equal(JSON.stringify(pkg).includes("packageLineage"), false);
});

test("export requires actual image metadata instead of silently dropping a photo", () => {
  const chapter: ManuscriptChapter = { ...chapterWith(), content: [{ text: "字\n" }, { photoId: "photo-abc" }] };
  assert.throws(() => exportChapterPackage({ chapter, ...meta }), /图片|图片信息/);
});

test("image export emits a byte-verified manifest and maps its opaque asset id back to the photo", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  const info = packageImageInfo(jpeg, 2, 3);
  assert.equal(info.mime, "image/jpeg");
  assert.equal(info.bytes, jpeg.length);
  assert.equal(info.sha256, require("node:crypto").createHash("sha256").update(jpeg).digest("hex"));
  assert.equal(verifyPackageAssetBytes({ assetId: "asset-" + "1".repeat(32), ...info }, jpeg, 2, 3).aiGenerated, false);
  assert.throws(() => verifyPackageAssetBytes({ assetId: "asset-" + "1".repeat(32), ...info, sha256: "0".repeat(64) }, jpeg, 2, 3), /校验值不一致/);
  assert.throws(() => packageImageInfo(new Uint8Array([0, 1, 2]), 1, 1), /JPEG、PNG 或 WebP/);
  const photoId = "photo-local-1", chapter: ManuscriptChapter = { ...chapterWith(), content: [{ photoId }] };
  const exported = exportChapterPackage({ chapter, ...meta, images: { [photoId]: info } });
  const assetId = exported.package.chapters[0].blocks[0].type === "image" ? exported.package.chapters[0].blocks[0].assetId : "";
  assert.deepEqual(exported.assetPhotos, { [assetId]: photoId });
  assert.equal(exported.package.assets[0].sha256, info.sha256);
});

test("re-export preserves imported asset ids, AI flags, layout image references and cover association", () => {
  const photoId = "photo-registered-cover", assetId = "asset-" + "9".repeat(32);
  const imageLayout = {
    canvas: { width: 900 as const, height: 1200 as const },
    settings: { fontId: "default", style: "plain", texture: "none", textureSeed: 1, includeCover: true, bodyTextureAssetId: assetId },
    pages: [{ label: "1", modules: [{ id: "image-1", kind: "image" as const, assetId,
      rect: { x: 0, y: 0, width: 900, height: 600 }, crop: { x: 0, y: 0, width: 1, height: 1 } }] }],
  } as unknown as ManuscriptChapter["layout"];
  const chapter: ManuscriptChapter = { ...chapterWith(imageLayout), content: [{ photoId }],
    packageAssets: { [assetId]: { photoId, aiGenerated: true } }, packageCoverAssetId: assetId };
  const { package: pkg } = exportChapterPackage({ chapter, ...meta,
    images: { [photoId]: { mime: "image/png", bytes: 100, sha256: "b".repeat(64), width: 20, height: 20, aiGenerated: false } } });
  assert.deepEqual(pkg.assets.map(asset => asset.assetId), [assetId]);
  assert.equal(pkg.assets[0].aiGenerated, true);
  assert.deepEqual(pkg.chapters[0].cover, { assetId });
  assert.equal(pkg.chapters[0].layout?.settings.bodyTextureAssetId, assetId);
  assert.equal(pkg.chapters[0].layout?.pages[0].modules[0].kind, "image");
});

test("export refuses restricted source blocks and unsupported backdrops", () => {
  assert.throws(() => exportChapterPackage({ chapter: { ...chapterWith(), content: [{ text: "受限文字", blockId: block("a"), sourceIds: ["source-" + "a".repeat(64)] }] }, ...meta }), /来源权限/);
  assert.throws(() => exportChapterPackage({ chapter: { ...chapterWith(), backdropImageId: "family_owner_img_req-abcdefgh" }, ...meta }), /底图/);
});

test("single-chapter import cannot silently discard other chapters in a package", () => {
  assert.throws(() => prepareImport(load("valid-03-three-chapters.json")), /单章章节包/);
});

test("prepareImport keeps every block id and layout from a shared sample", () => {
  const sample = load("valid-01-text-only.json");
  const payload = prepareImport(sample);
  const ids = sample.chapters[0].blocks.map((b: { blockId: string }) => b.blockId);
  assert.deepEqual(payload.chapter.content.map(item => item.blockId), ids);
  assert.equal(payload.packageId, sample.packageId);
  assert.equal(payload.senderName, sample.sender.displayName);
  assert.equal(payload.storyTitle, sample.storyTitle);
  assert.deepEqual(payload.lineage, sample.lineage);
  const withLayout = prepareImport(load("valid-02-layout-two-images.json"));
  assert.ok(withLayout.layout && withLayout.layout.pages.length > 0);
  assert.ok(withLayout.chapter.content.some(item => typeof item.photoId === "string"));
  const imageSample = load("valid-02-layout-two-images.json");
  const photoIds = Object.fromEntries(imageSample.assets.map((asset: { assetId: string }, index: number) => [asset.assetId, `photo-registered-${index}`]));
  const mapped = prepareImport(imageSample, photoIds);
  assert.deepEqual(mapped.assetPhotos, photoIds);
  assert.deepEqual(mapped.assets, imageSample.assets);
  assert.ok(mapped.chapter.content.some(item => item.photoId && Object.values(photoIds).includes(item.photoId)));
});

test("prepareImport turns invalid packages into a readable error and imports nothing", () => {
  for (const name of ["invalid-version.json", "invalid-missing-block.json", "invalid-forbidden-identifier.json", "invalid-over-limit.json"]) {
    assert.throws(() => prepareImport(load(name)), /章节包无法使用/, name);
  }
});

test("an exported package round-trips through prepareImport without losing text, order or ids", () => {
  const chapter = chapterWith(layoutOf([mod("paragraph-1", chapterPackageBlockId(["chapter-package-v1", "chapter-one", 0, "text", "第一行"]))]));
  const { package: pkg, blockIds } = exportChapterPackage({ chapter, ...meta, layout: chapter.layout });
  const payload = prepareImport(pkg);
  assert.deepEqual(payload.chapter.content.map(item => item.text), ["第一行\n", "第二行\n"]);
  assert.deepEqual(payload.chapter.content.map(item => item.blockId), blockIds);
  assert.deepEqual(payload.layout, chapter.layout);
});

test("the chapter package switch is off by default and gates the service", async () => {
  assert.equal(CHAPTER_PACKAGE_ENABLED, false);
  assert.equal(chapterPackageEnabled(), false);
  assert.equal(chapterPackageEnabled(true), true);
  const { chapterPackages } = await import("../miniprogram/services/chapterPackageService");
  await assert.rejects(
    chapterPackages.import(prepareImport(load("valid-01-text-only.json")), { mode: "new", storyId: "story-x", title: "x" }, "package-request-1"),
    /暂未开放/
  );
});

test("the page shows the package entries only behind the switch, and the four story switches stay closed", () => {
  const wxml = readFileSync(join(__dirname, "..", "miniprogram", "pages", "book", "book.wxml"), "utf8");
  assert.match(wxml, /wx:if="\{\{chapterPackageOn\}\}"[^>]*data-action="package-chapter"/);
  assert.match(wxml, /wx:if="\{\{chapterPackageDev\}\}"[^>]*data-action="import-package"/);
  const runtime = readFileSync(join(__dirname, "..", "miniprogram", "config", "runtime.ts"), "utf8");
  assert.match(runtime, /export const CHAPTER_PACKAGE_ENABLED = false;/);
  assert.doesNotMatch(runtime, /STORY_(ACCESS|INVITATIONS|COPY_RECEIVE|SHARED_EDIT)_ENABLED\s*=\s*true/);
});

const legacyDraft = (): BiographyDraft => {
  const chapters: ManuscriptChapter[] = [{ id: "chapter-one", title: "章", memoryIds: [], content: [
    { text: "第一行\n第二行\n\n" }, { photoId: "photo-old" }, { text: "照片之后\n最后一行\n" },
  ] }];
  const flat = core.flatten(chapters);
  return { ...base, title: "书", chapters, content: flat.content,
    paragraphs: flat.content.map((item: { text?: string }) => item.text ?? "").join("")
      .split(/\n\s*\n/).map((text: string) => text.trim()).filter(Boolean) };
};

test("legacy blank-line drafts pass client and cloud validation without changing stored text or photos", () => {
  const draft = legacyDraft(), before = structuredClone(draft);
  assert.doesNotThrow(() => validateManuscriptDraft(draft));
  assert.doesNotThrow(() => core.validateDraft(draft, { memoryIds: [] }));
  assert.deepEqual(draft, before);
  const edited = draftWithChapters(draft, draft.chapters!);
  assert.deepEqual(edited.chapters, before.chapters);
  assert.deepEqual(edited.paragraphs, ["第一章　章", "第一行", "第二行", "照片之后", "最后一行"]);
});

test("legacy compatibility still rejects lost text, changed photos and mismatched provenance", () => {
  for (const mutate of [
    (d: BiographyDraft) => d.paragraphs.pop(),
    (d: BiographyDraft) => { d.paragraphs[1] = "被替换"; },
    (d: BiographyDraft) => { d.content!.find(b => b.photoId)!.photoId = "photo-other"; },
    (d: BiographyDraft) => { (d.content![1] as any).sourceIds = []; },
  ]) {
    const draft = legacyDraft(); mutate(draft);
    assert.throws(() => validateManuscriptDraft(draft), /章节和全文不一致/);
    assert.throws(() => core.validateDraft(draft, { memoryIds: [] }), /章节和全文不一致/);
  }
});

test("saving or restoring a legacy draft writes canonical paragraphs into a new revision only", () => {
  const draft = legacyDraft();
  const state = { storyMigration: { status: "active" }, contributions: [], stories: [{ id: "story-old", title: "书", writingMode: "objective",
    memoryIds: [], version: 1, currentRevisionId: "revision-old" }],
    manuscriptRevisions: [{ id: "revision-old", storyId: "story-old", draft, savedAt: "2026-01-01", kind: "version" }] };
  const before = structuredClone(state);
  for (const restore of [false, true]) {
    const next = core.apply(state, { action: "save", storyId: "story-old", expectedVersion: 1, expectedRevisionId: "revision-old", requestId: "legacy-save-request",
      ...(restore ? { restoreRevisionId: "revision-old" } : {}), revision: { id: "revision-new", storyId: "story-old", draft } });
    assert.deepEqual(next.manuscriptRevisions[0], before.manuscriptRevisions[0]);
    assert.deepEqual(next.manuscriptRevisions[1].draft.chapters, draft.chapters);
    assert.deepEqual(next.manuscriptRevisions[1].draft.paragraphs, core.flatten(draft.chapters).paragraphs);
    assert.deepEqual(state, before);
  }
});
