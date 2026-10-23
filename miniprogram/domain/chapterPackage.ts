/**
 * Chapter package v1 (contract 1.0.0), mini-program side. Pure functions only.
 * Mirrors shared/chapterPackage.ts in the web repo; both are checked against the
 * same fixtures in tests/fixtures/chapter-package/. See docs/integrations/chapter-package-contract.md.
 */
import type { ManuscriptChapter, ManuscriptContent } from "./biography";

export const CHAPTER_PACKAGE_KIND = "chapter-package";
export const CHAPTER_PACKAGE_VERSION = 1;
export const CHAPTER_PACKAGE_CONTRACT_VERSION = "1.0.0";
export const CHAPTER_PACKAGE_LIMITS = {
  chapters: 30, totalText: 20_000, jsonBytes: 240 * 1024, pagesPerChapter: 9, modulesPerPage: 300,
  images: 12, imageBytes: 2 * 1024 * 1024, totalImageBytes: 8 * 1024 * 1024,
} as const;
export type ChapterPackageErrorCode =
  | "UNSUPPORTED_VERSION" | "INVALID_SHAPE" | "MISSING_BLOCK_REF" | "MISSING_ASSET_REF"
  | "LIMIT_EXCEEDED" | "FORBIDDEN_IDENTIFIER" | "ASSET_INFO_MISSING";
export class ChapterPackageError extends Error {
  readonly code: ChapterPackageErrorCode;
  constructor(code: ChapterPackageErrorCode, message: string) {
    super(message);
    this.name = "ChapterPackageError";
    this.code = code;
  }
}
const fail = (code: ChapterPackageErrorCode, message: string): never => {
  throw new ChapterPackageError(code, message);
};

// Pure SHA-256 (no node:crypto in the domain layer); verified against node:crypto in the tests.
function utf8(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 of a UTF-8 string as lowercase hex. */
export function sha256Bytes(value: ArrayBuffer | Uint8Array): string {
  const bytes = Array.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  for (const word of [high, bitLength >>> 0])
    bytes.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map(value => value.toString(16).padStart(8, "0")).join("");
}

/** SHA-256 of UTF-8 text. */
export function sha256Hex(text: string): string { return sha256Bytes(new Uint8Array(utf8(text))); }

export const chapterPackageBlockId = (parts: readonly (string | number)[]) =>
  `block-${sha256Hex(JSON.stringify(parts))}`;
export const chapterPackageAssetId = (key: string) =>
  `asset-${sha256Hex(JSON.stringify(["chapter-package-v1-asset", key]))}`.slice(0, 6 + 32);

// ---------------------------------------------------------------- types
export type Rect = { x: number; y: number; width: number; height: number };
export type PackageBlock =
  | { blockId: string; type: "text"; text: string }
  | { blockId: string; type: "image"; assetId: string; caption?: string };
export type PackageLayoutModule =
  | { id: string; kind: "text"; bind: { blockId: string } | { chapterTitle: true }; rect: Rect; positioned?: boolean;
      fontSize: number; contentWidth: number; contentHeight: number; alignment: "start" | "center";
      emphasis?: "normal" | "bright"; backdrop?: boolean }
  | { id: string; kind: "image"; assetId: string; rect: Rect; crop: Rect; positioned?: boolean };
export type PackageLayout = {
  canvas: { width: 900; height: 1200 }; flowVersion?: 1;
  settings: { fontId: string; style: string; texture: string; textureSeed: number; includeCover: boolean; bodyTextureAssetId: string | null };
  pages: { label: string; modules: PackageLayoutModule[] }[];
};
export type PackageChapter = {
  chapterId: string; title: string; containsAiText: boolean; cover: { assetId: string } | null;
  blocks: PackageBlock[]; layout: PackageLayout | null;
};
export type PackageAsset = { assetId: string; mime: "image/jpeg" | "image/png" | "image/webp"; bytes: number; sha256: string; width: number; height: number; aiGenerated: boolean };
export type ChapterPackage = {
  kind: "chapter-package"; version: 1; packageId: string;
  lineage: { rootPackageId: string; parentPackageId: string | null };
  createdAt: string; sender: { platform: "web" | "miniprogram"; displayName: string };
  storyTitle: string; chapters: PackageChapter[]; assets: PackageAsset[];
};
export type PackageImageInfo = Omit<PackageAsset, "assetId">;

// ---------------------------------------------------------------- validation
const BLOCK_ID = /^block-[a-f0-9]{64}$/;
const ASSET_ID = /^asset-[a-f0-9]{32}$/;
const CHAPTER_ID = /^chapter-[a-z0-9-]{1,60}$/;
const PACKAGE_ID = /^cp_[A-Za-z0-9-]{8,64}$/;
const MODULE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** Copy of STORY_IMAGE_REFERENCE in services/bookImages.ts (domain cannot import services); a test keeps them equal. */
export const AI_PHOTO_ID = /^photo-ai-(req-[0-9a-z-]{8,60})$/;
const FORBIDDEN_KEYS = new Set(["openid", "unionid", "accountid", "familyid", "userid", "memoryid", "memoryids", "sourceid", "sourceids", "grantid"]);

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > 32 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) { const f = findForbiddenKey(item, depth + 1); if (f) return f; }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""))) return key;
    const f = findForbiddenKey(item, depth + 1);
    if (f) return f;
  }
  return null;
}
const bad = (what: string): never => fail("INVALID_SHAPE", `章节包格式不正确：${what}`);
const str = (v: unknown, what: string, max: number, re?: RegExp): string => {
  if (typeof v !== "string" || v.length > max || (re && !re.test(v))) return bad(what);
  return v;
};
const num = (v: unknown, what: string): number => (typeof v === "number" && Number.isFinite(v) ? v : bad(what));
const bool = (v: unknown, what: string): boolean => (typeof v === "boolean" ? v : bad(what));
const arr = (v: unknown, what: string): unknown[] => (Array.isArray(v) ? v : bad(what));
const obj = (v: unknown, what: string): Record<string, unknown> => rec(v) ?? bad(what);
const rect = (v: unknown, what: string): Rect => {
  const r = obj(v, what);
  const out = { x: num(r.x, what), y: num(r.y, what), width: num(r.width, what), height: num(r.height, what) };
  if (out.width <= 0 || out.height <= 0) bad(what);
  return out;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T =>
  (list as readonly unknown[]).includes(v) ? (v as T) : bad(what);

function checkLimits(raw: Record<string, unknown>) {
  const L = CHAPTER_PACKAGE_LIMITS;
  const over = (what: string): never => fail("LIMIT_EXCEEDED", `章节包超出上限：${what}`);
  const chapters = Array.isArray(raw.chapters) ? raw.chapters : [];
  if (chapters.length > L.chapters) over(`最多 ${L.chapters} 章`);
  let text = 0;
  for (const chapter of chapters) {
    const c = rec(chapter);
    if (!c) continue;
    for (const block of Array.isArray(c.blocks) ? c.blocks : []) {
      const b = rec(block);
      if (b?.type === "text" && typeof b.text === "string") text += b.text.length;
    }
    const pages = rec(c.layout)?.pages;
    if (Array.isArray(pages)) {
      if (pages.length > L.pagesPerChapter) over(`每章最多 ${L.pagesPerChapter} 页`);
      for (const page of pages) {
        const modules = rec(page)?.modules;
        if (Array.isArray(modules) && modules.length > L.modulesPerPage) over(`每页最多 ${L.modulesPerPage} 个模块`);
      }
    }
  }
  if (text > L.totalText) over(`文字合计最多 ${L.totalText} 字`);
  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  if (assets.length > L.images) over(`图片最多 ${L.images} 张`);
  let total = 0;
  for (const asset of assets) {
    const bytes = rec(asset)?.bytes;
    if (typeof bytes !== "number") continue;
    if (bytes > L.imageBytes) over("单张图片最多 2 MB");
    total += bytes;
  }
  if (total > L.totalImageBytes) over("图片合计最多 8 MB");
  let size: number;
  try { size = utf8(JSON.stringify(raw)).length; } catch { return fail("INVALID_SHAPE", "章节包不是合法的 JSON 数据"); }
  if (size > L.jsonBytes) over("不含图片的 JSON 最多 240 KB");
}

function readModule(v: unknown): PackageLayoutModule {
  const m = obj(v, "module");
  const base = { id: str(m.id, "module.id", 120, MODULE_ID), rect: rect(m.rect, "module.rect"),
    ...(m.positioned !== undefined ? { positioned: bool(m.positioned, "module.positioned") } : {}) };
  if (m.kind === "image")
    return { ...base, kind: "image", assetId: str(m.assetId, "module.assetId", 38, ASSET_ID), crop: rect(m.crop, "module.crop") };
  if (m.kind !== "text") return bad("module.kind");
  const b = obj(m.bind, "module.bind");
  const bind = b.chapterTitle === true ? ({ chapterTitle: true } as const) : { blockId: str(b.blockId, "module.bind", 70, BLOCK_ID) };
  const fontSize = num(m.fontSize, "module.fontSize");
  if (fontSize < 8 || fontSize > 240) bad("module.fontSize");
  const cw = num(m.contentWidth, "module.contentWidth"), ch = num(m.contentHeight, "module.contentHeight");
  if (cw <= 0 || ch <= 0) bad("module.content");
  return { ...base, kind: "text", bind, fontSize, contentWidth: cw, contentHeight: ch,
    alignment: oneOf(m.alignment, ["start", "center"] as const, "module.alignment"),
    ...(m.emphasis !== undefined ? { emphasis: oneOf(m.emphasis, ["normal", "bright"] as const, "module.emphasis") } : {}),
    ...(m.backdrop !== undefined ? { backdrop: bool(m.backdrop, "module.backdrop") } : {}) };
}
function readLayout(v: unknown): PackageLayout | null {
  if (v === null || v === undefined) return null;
  const l = obj(v, "layout");
  const c = obj(l.canvas, "layout.canvas");
  if (c.width !== 900 || c.height !== 1200) bad("layout.canvas");
  const s = obj(l.settings, "layout.settings");
  const seed = num(s.textureSeed, "textureSeed");
  if (!Number.isInteger(seed) || seed < 0 || seed > 1_000_000_000) bad("textureSeed");
  const pages = arr(l.pages, "layout.pages");
  if (pages.length < 1) bad("layout.pages");
  if (l.flowVersion !== undefined && l.flowVersion !== 1) bad("flowVersion");
  return {
    canvas: { width: 900, height: 1200 },
    ...(l.flowVersion === 1 ? { flowVersion: 1 as const } : {}),
    settings: { fontId: str(s.fontId, "fontId", 80), style: str(s.style, "style", 40), texture: str(s.texture, "texture", 40),
      textureSeed: seed, includeCover: bool(s.includeCover, "includeCover"),
      bodyTextureAssetId: s.bodyTextureAssetId === null ? null : str(s.bodyTextureAssetId, "bodyTextureAssetId", 38, ASSET_ID) },
    pages: pages.map(p => { const page = obj(p, "page"); return { label: str(page.label, "page.label", 80), modules: arr(page.modules, "page.modules").map(readModule) }; }),
  };
}
function readBlock(v: unknown): PackageBlock {
  const b = obj(v, "block");
  const blockId = str(b.blockId, "block.blockId", 70, BLOCK_ID);
  if (b.type === "text") {
    const text = str(b.text, "block.text", CHAPTER_PACKAGE_LIMITS.totalText);
    if (text === "" || /[\r\n]/.test(text) || text.trim() === "") bad("文字块必须是单行非空文字");
    return { blockId, type: "text", text };
  }
  if (b.type !== "image") return bad("block.type");
  return { blockId, type: "image", assetId: str(b.assetId, "block.assetId", 38, ASSET_ID),
    ...(b.caption !== undefined ? { caption: str(b.caption, "block.caption", 200) } : {}) };
}
function readChapter(v: unknown): PackageChapter {
  const c = obj(v, "chapter");
  const cover = c.cover === null || c.cover === undefined ? null : { assetId: str(obj(c.cover, "cover").assetId, "cover", 38, ASSET_ID) };
  return { chapterId: str(c.chapterId, "chapterId", 70, CHAPTER_ID), title: str(c.title, "title", 200),
    containsAiText: c.containsAiText === undefined ? false : bool(c.containsAiText, "containsAiText"),
    cover, blocks: arr(c.blocks, "blocks").map(readBlock), layout: readLayout(c.layout) };
}
function readAsset(v: unknown): PackageAsset {
  const a = obj(v, "asset");
  const posInt = (x: unknown, what: string, max = Infinity) => {
    const n = num(x, what);
    if (!Number.isInteger(n) || n <= 0 || n > max) bad(what);
    return n;
  };
  return { assetId: str(a.assetId, "asset.assetId", 38, ASSET_ID), mime: oneOf(a.mime, ["image/jpeg", "image/png", "image/webp"] as const, "asset.mime"),
    bytes: posInt(a.bytes, "asset.bytes"), sha256: str(a.sha256, "asset.sha256", 64, /^[a-f0-9]{64}$/),
    width: posInt(a.width, "asset.width", 20_000), height: posInt(a.height, "asset.height", 20_000), aiGenerated: bool(a.aiGenerated, "asset.aiGenerated") };
}

function checkSemantics(pkg: ChapterPackage) {
  const assetIds = new Set<string>();
  for (const asset of pkg.assets) {
    if (assetIds.has(asset.assetId)) fail("INVALID_SHAPE", "图片编号重复");
    assetIds.add(asset.assetId);
  }
  const needAsset = (id: string) => { if (!assetIds.has(id)) fail("MISSING_ASSET_REF", "章节包引用了 assets 里没有的图片"); };
  const chapterIds = new Set<string>();
  for (const chapter of pkg.chapters) {
    if (chapterIds.has(chapter.chapterId)) fail("INVALID_SHAPE", "章节编号重复");
    chapterIds.add(chapter.chapterId);
    const blockTypes = new Map<string, "text" | "image">();
    for (const block of chapter.blocks) {
      if (blockTypes.has(block.blockId)) fail("INVALID_SHAPE", "同一章内块编号重复");
      blockTypes.set(block.blockId, block.type);
      if (block.type === "image") needAsset(block.assetId);
    }
    if (chapter.cover) needAsset(chapter.cover.assetId);
    const layout = chapter.layout;
    if (!layout) continue;
    if (layout.settings.bodyTextureAssetId) needAsset(layout.settings.bodyTextureAssetId);
    if (layout.settings.includeCover && !chapter.cover) fail("INVALID_SHAPE", "排版要求封面，但章节没有封面图片");
    const bound = new Set<string>();
    let titleBound = false;
    for (const page of layout.pages) {
      const moduleIds = new Set<string>();
      for (const module of page.modules) {
        if (moduleIds.has(module.id)) fail("INVALID_SHAPE", "同一页内模块编号重复");
        moduleIds.add(module.id);
        const r = module.rect;
        if (r.x < 0 || r.y < 0 || r.x + r.width > 900.01 || r.y + r.height > 1200.01) fail("INVALID_SHAPE", "模块超出画布");
        if (module.kind === "image") {
          needAsset(module.assetId);
          const c = module.crop;
          if (c.x < 0 || c.y < 0 || c.x + c.width > 1.00001 || c.y + c.height > 1.00001) fail("INVALID_SHAPE", "图片裁切范围无效");
        } else if ("blockId" in module.bind) {
          if (blockTypes.get(module.bind.blockId) !== "text") fail("MISSING_BLOCK_REF", "排版引用了不存在的文字块");
          if (bound.has(module.bind.blockId)) fail("INVALID_SHAPE", "同一个文字块被多个模块引用");
          bound.add(module.bind.blockId);
        } else {
          if (titleBound) fail("INVALID_SHAPE", "章节标题被多个模块引用");
          titleBound = true;
        }
      }
    }
  }
}

/** Validate and normalise (unknown fields dropped). Throws ChapterPackageError. */
export function parseChapterPackage(input: unknown): ChapterPackage {
  const raw = rec(input);
  if (!raw) return fail("INVALID_SHAPE", "章节包必须是一个对象");
  if (raw.kind !== CHAPTER_PACKAGE_KIND) return fail("INVALID_SHAPE", "这不是章节包");
  if (raw.version !== CHAPTER_PACKAGE_VERSION) return fail("UNSUPPORTED_VERSION", "章节包的版本这个应用还不认识，请先更新应用");
  const forbidden = findForbiddenKey(raw);
  if (forbidden) return fail("FORBIDDEN_IDENTIFIER", `章节包不能包含账号或内部标识（${forbidden}）`);
  checkLimits(raw);
  const lineage = obj(raw.lineage, "lineage");
  const sender = obj(raw.sender, "sender");
  const pkg: ChapterPackage = {
    kind: "chapter-package", version: 1,
    packageId: str(raw.packageId, "packageId", 67, PACKAGE_ID),
    lineage: { rootPackageId: str(lineage.rootPackageId, "rootPackageId", 67, PACKAGE_ID),
      parentPackageId: lineage.parentPackageId === null ? null : str(lineage.parentPackageId, "parentPackageId", 67, PACKAGE_ID) },
    createdAt: str(raw.createdAt, "createdAt", 40, ISO_TIME),
    sender: { platform: oneOf(sender.platform, ["web", "miniprogram"] as const, "sender.platform"), displayName: str(sender.displayName, "displayName", 40) },
    storyTitle: str(raw.storyTitle, "storyTitle", 200),
    chapters: arr(raw.chapters, "chapters").map(readChapter),
    assets: arr(raw.assets, "assets").map(readAsset),
  };
  checkSemantics(pkg);
  return pkg;
}
export function safeParseChapterPackage(input: unknown):
  { ok: true; package: ChapterPackage } | { ok: false; code: ChapterPackageErrorCode; message: string } {
  try { return { ok: true, package: parseChapterPackage(input) }; } catch (error) {
    if (error instanceof ChapterPackageError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------- converters
/** "One line is one text block": split on line breaks and drop blank lines. */
export function chapterPackageLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n").filter(line => line.trim() !== "");
}
export type PackageMeta = {
  packageId: string; createdAt: string; displayName: string; storyTitle?: string;
  lineage?: { rootPackageId: string; parentPackageId: string | null };
};
export type ToPackageOptions = {
  /** A layout and cover carried over from an earlier import (the mini-program makes none itself). */
  layout?: PackageLayout | null;
  coverPhotoId?: string | null;
  assetIdByPhotoId?: Record<string, string>;
  aiGeneratedByPhotoId?: Record<string, boolean>;
};
export type ToPackageResult = {
  package: ChapterPackage;
  /** assetId -> photoId, so images can be sent and matched separately. */
  assetPhotos: Record<string, string>;
  blockIds: string[];
};
const toChapterId = (id: string) => (CHAPTER_ID.test(id) ? id : `chapter-${sha256Hex(JSON.stringify(["chapter-package-v1-chapter", id])).slice(0, 32)}`);

export function toChapterPackage(
  chapter: ManuscriptChapter,
  images: Record<string, PackageImageInfo>,
  meta: PackageMeta,
  options: ToPackageOptions = {}
): ToPackageResult {
  const chapterId = toChapterId(chapter.id);
  const blocks: PackageBlock[] = [];
  const used = new Set<string>();
  const assetPhotos: Record<string, string> = {};
  const assets = new Map<string, PackageAsset>();
  const useId = (preferred: string | undefined, fallbackParts: (string | number)[]) => {
    let id = preferred && BLOCK_ID.test(preferred) && !used.has(preferred) ? preferred : chapterPackageBlockId(fallbackParts);
    while (used.has(id)) id = chapterPackageBlockId([...fallbackParts, "dup", used.size]);
    used.add(id);
    return id;
  };
  const addAsset = (photoId: string): string => {
    const assetId = options.assetIdByPhotoId?.[photoId] ?? chapterPackageAssetId(photoId);
    if (!ASSET_ID.test(assetId)) fail("INVALID_SHAPE", "图片编号无效");
    if (!assets.has(assetId)) {
      const info = images[photoId];
      if (!info) fail("ASSET_INFO_MISSING", "缺少这张图片的尺寸或校验信息");
      assets.set(assetId, { assetId, ...info, aiGenerated: info.aiGenerated || options.aiGeneratedByPhotoId?.[photoId] === true || AI_PHOTO_ID.test(photoId) });
      assetPhotos[assetId] = photoId;
    }
    return assetId;
  };
  chapter.content.forEach((item: ManuscriptContent) => {
    if ("photoId" in item && item.photoId) {
      const assetId = addAsset(item.photoId);
      blocks.push({ blockId: useId(item.blockId, ["chapter-package-v1", chapterId, blocks.length, "image", assetId]), type: "image", assetId });
      return;
    }
    chapterPackageLines(item.text ?? "").forEach((line, lineNo) => {
      const split = item.blockId && lineNo > 0 ? chapterPackageBlockId(["chapter-package-v1-split", item.blockId, lineNo]) : undefined;
      const preferred = lineNo === 0 ? item.blockId : split;
      blocks.push({ blockId: useId(preferred, ["chapter-package-v1", chapterId, blocks.length, "text", line]), type: "text", text: line });
    });
  });
  const coverAssetId = options.coverPhotoId ? addAsset(options.coverPhotoId) : null;
  const layoutAssets = options.layout ? [options.layout.settings.bodyTextureAssetId,
    ...options.layout.pages.flatMap(page => page.modules.filter(module => module.kind === "image").map(module => module.assetId))].filter((id): id is string => Boolean(id)) : [];
  for (const assetId of layoutAssets) {
    if ([...assets.keys()].includes(assetId)) continue;
    const photoId = Object.keys(images).find(id => (options.assetIdByPhotoId?.[id] ?? chapterPackageAssetId(id)) === assetId);
    if (!photoId || addAsset(photoId) !== assetId) fail("ASSET_INFO_MISSING", "排版引用的图片没有可校验的原始文件");
  }
  const pkgChapter: PackageChapter = {
    chapterId, title: chapter.title, containsAiText: chapter.containsAiText === true,
    cover: coverAssetId ? { assetId: coverAssetId } : null, blocks, layout: options.layout ?? null,
  };
  const out: ChapterPackage = {
    kind: "chapter-package", version: 1, packageId: meta.packageId,
    lineage: meta.lineage ?? { rootPackageId: meta.packageId, parentPackageId: null },
    createdAt: meta.createdAt, sender: { platform: "miniprogram", displayName: meta.displayName },
    storyTitle: meta.storyTitle ?? chapter.title, chapters: [pkgChapter], assets: [...assets.values()],
  };
  return { package: parseChapterPackage(out), assetPhotos, blockIds: blocks.map(b => b.blockId) };
}

export type FromPackageOptions = {
  chapterId?: string;
  /** Maps a package image to a local photo id. Defaults to an opaque `photo-pkg-…` / `photo-ai-req-…` id. */
  resolvePhotoId?: (assetId: string, asset: PackageAsset) => string;
};
export type FromPackageResult = {
  chapter: ManuscriptChapter;
  layout: PackageLayout | null;
  /** Package block id for every entry of `chapter.content`, one per text line and image; never written onto the chapter. */
  blockIds: string[];
  coverPhotoId: string | null;
  assetPhotos: Record<string, string>;
  images: Record<string, PackageImageInfo>;
  /** Text blocks the layout does not place; the app lays them out after the rest. */
  unplacedBlockIds: string[];
};
const defaultPhotoId = (assetId: string, asset: PackageAsset) =>
  asset.aiGenerated ? `photo-ai-req-${assetId.slice(6)}` : `photo-pkg-${assetId.slice(6)}`;

export function fromChapterPackage(input: unknown, options: FromPackageOptions = {}): FromPackageResult {
  const pkg = parseChapterPackage(input);
  const found = options.chapterId ? pkg.chapters.find(c => c.chapterId === options.chapterId) : pkg.chapters[0];
  if (!found) return fail("INVALID_SHAPE", "章节包里没有这一章");
  const byId = new Map(pkg.assets.map(a => [a.assetId, a]));
  const assetPhotos: Record<string, string> = {};
  const images: Record<string, PackageImageInfo> = {};
  const photoFor = (assetId: string) => {
    const asset = byId.get(assetId) as PackageAsset;
    const photoId = (options.resolvePhotoId ?? defaultPhotoId)(assetId, asset);
    assetPhotos[assetId] = photoId;
    const { assetId: _ignored, ...info } = asset;
    images[photoId] = info;
    return photoId;
  };
  const content: ManuscriptContent[] = found.blocks.map(b =>
    b.type === "text" ? { text: `${b.text}\n` } : { photoId: photoFor(b.assetId) });
  // Include assets used only by cover/layout texture/image modules as well as body blocks.
  for (const asset of pkg.assets) photoFor(asset.assetId);
  const placed = new Set<string>();
  for (const page of found.layout?.pages ?? [])
    for (const m of page.modules) if (m.kind === "text" && "blockId" in m.bind) placed.add(m.bind.blockId);
  const chapter: ManuscriptChapter = {
    id: found.chapterId, title: found.title, memoryIds: [], content,
    ...(found.containsAiText ? { containsAiText: true } : {}),
  };
  return {
    chapter, layout: found.layout, blockIds: found.blocks.map(b => b.blockId),
    coverPhotoId: found.cover ? photoFor(found.cover.assetId) : null, assetPhotos, images,
    unplacedBlockIds: found.layout ? found.blocks.filter(b => b.type === "text" && !placed.has(b.blockId)).map(b => b.blockId) : [],
  };
}
