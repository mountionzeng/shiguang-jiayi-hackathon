import type { ManuscriptChapter } from "../domain/biography";
import {
  ChapterPackage, ChapterPackageError, PackageAsset, PackageLayout, fromChapterPackage, parseChapterPackage, toChapterPackage,
  CHAPTER_PACKAGE_LIMITS, PackageImageInfo, sha256Bytes,
} from "../domain/chapterPackage";
import { CHAPTER_PACKAGE_ENABLED } from "../config/runtime";

/** 每章排版序列化后的上限；与 storyBookCore.validateDraft 的 60000 字节保持一致。 */
export const CHAPTER_LAYOUT_MAX_BYTES = 60000;

export type ImportTarget =
  | { mode: "new"; storyId: string; title: string }
  | { mode: "append"; storyId: string; expectedVersion: number; expectedRevisionId: string };

export function chapterPackageImportAttempt(
  pending: { target: ImportTarget; requestId: string } | undefined,
  requestedTarget: ImportTarget | undefined,
  requestedId: string | undefined,
  defaultTarget: ImportTarget,
  generatedId: string,
) {
  return { target: pending?.target ?? requestedTarget ?? defaultTarget, requestId: pending?.requestId ?? requestedId ?? generatedId };
}

export const chapterPackageEnabled = (enabled: boolean = CHAPTER_PACKAGE_ENABLED) => enabled === true;

/** UTF-8 字节数，小程序端没有 Buffer。 */
export function utf8Bytes(text: string): number {
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    total += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return total;
}

export function assertLayoutFits(layout: PackageLayout | null | undefined) {
  if (layout && utf8Bytes(JSON.stringify(layout)) > CHAPTER_LAYOUT_MAX_BYTES) {
    throw new Error("这一章的排版超过 60 KB 上限，请减少模块后重试");
  }
}

export function hasPhotos(chapter: ManuscriptChapter): boolean {
  return chapter.content.some(item => typeof item.photoId === "string");
}

export interface ExportInput {
  chapter: ManuscriptChapter;
  /** Validated metadata for every referenced local photo; files are returned separately to the caller/06. */
  images?: Record<string, PackageImageInfo>;
  packageId: string;
  displayName: string;
  createdAt: string;
  storyTitle?: string;
  /** 从章节包导入时保留下来的排版；本端自己不生成排版。 */
  layout?: PackageLayout | null;
  /** 发回时指向原包；没有则是第一次导出。 */
  lineage?: { rootPackageId: string; parentPackageId: string | null };
}

/**
 * 把一章打成章节包。图片清单由本地真实文件字节构造，照片文件映射单独交给 06 传输。
 */
function buildChapterPackage(input: ExportInput, allowProtectedReturn: boolean): { package: ChapterPackage; blockIds: string[]; assetPhotos: Record<string, string> } {
  if (input.chapter.content.some(item => item.sourceIds?.length)) {
    const lineage = input.chapter.packageLineage;
    const digests = input.chapter.packageBlockDigests ?? {};
    const sourceBlocks = input.chapter.content.filter(item => item.sourceIds?.length);
    const safeReturn = allowProtectedReturn && Boolean(lineage?.rootPackageId && lineage.receivedPackageId) && sourceBlocks.every(item =>
      typeof item.blockId === "string" && /^block-[a-f0-9]{64}$/.test(item.blockId) &&
      item.sourceIds?.every(id => typeof id === "string" && id.length > 0 && id.length <= 160) &&
      /^[a-f0-9]{64}$/.test(digests[item.blockId] ?? "") &&
      /^block-[a-f0-9]{64}$/.test(input.chapter.packageSourceBlockIds?.[item.blockId] ?? "")
    );
    if (!safeReturn) throw new Error("这一章包含受来源权限保护的内容，暂不能导出章节包");
  }
  if (input.chapter.backdropImageId) throw new Error("这一章含有底图，暂时还不能打包");
  assertLayoutFits(input.layout);
  const savedLineage = input.chapter.packageLineage;
  const lineage = input.lineage ?? (savedLineage ? {
    rootPackageId: savedLineage.rootPackageId, parentPackageId: savedLineage.receivedPackageId,
  } : undefined);
  const assetIdByPhotoId: Record<string, string> = {};
  const aiGeneratedByPhotoId: Record<string, boolean> = {};
  for (const [assetId, asset] of Object.entries(input.chapter.packageAssets ?? {})) {
    assetIdByPhotoId[asset.photoId] = assetId;
    aiGeneratedByPhotoId[asset.photoId] = asset.aiGenerated;
  }
  const coverPhotoId = input.chapter.packageCoverAssetId ? input.chapter.packageAssets?.[input.chapter.packageCoverAssetId]?.photoId : null;
  const result = toChapterPackage(
    input.chapter, input.images ?? {},
    { packageId: input.packageId, createdAt: input.createdAt, displayName: input.displayName, storyTitle: input.storyTitle, lineage },
    { layout: input.layout ?? input.chapter.layout ?? null, ...(coverPhotoId ? { coverPhotoId } : {}), assetIdByPhotoId, aiGeneratedByPhotoId }
  );
  return { package: result.package, blockIds: result.blockIds, assetPhotos: result.assetPhotos };
}

export function exportChapterPackage(input: ExportInput) { return buildChapterPackage(input, false); }

/**
 * Return-only package export keeps the chapter's source markers untouched and
 * requires the original imported-package lineage. Drinking Time rechecks that
 * lineage and routes the package only to the root sender before it is stored.
 */
export function exportChapterReturnPackage(input: ExportInput) {
  if (!input.chapter.packageLineage?.rootPackageId || !input.chapter.packageLineage.receivedPackageId)
    throw new Error("这一章没有可验证的原始章节来源，不能发回");
  return buildChapterPackage(input, true);
}

/** Build a v1 manifest only after checking actual bytes and image signature. */
export function packageImageInfo(bytes: Uint8Array, width: number, height: number): PackageImageInfo {
  const limits = CHAPTER_PACKAGE_LIMITS;
  if (!bytes.length || bytes.length > limits.imageBytes) throw new Error("章节包单张图片最多 2 MB");
  if (!Number.isSafeInteger(width) || width < 1 || width > 20_000 || !Number.isSafeInteger(height) || height < 1 || height > 20_000)
    throw new Error("图片尺寸信息无效");
  let mime: PackageImageInfo["mime"];
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = "image/jpeg";
  else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) mime = "image/png";
  else if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") mime = "image/webp";
  else throw new Error("章节包只支持 JPEG、PNG 或 WebP 图片");
  return { mime, bytes: bytes.length, sha256: sha256Bytes(bytes), width, height, aiGenerated: false };
}

export function verifyPackageAssetBytes(asset: PackageAsset, bytes: Uint8Array, width: number, height: number): PackageImageInfo {
  const actual = packageImageInfo(bytes, width, height);
  if (asset.mime !== actual.mime || asset.bytes !== actual.bytes || asset.sha256 !== actual.sha256 || asset.width !== width || asset.height !== height)
    throw new Error("章节包图片与清单校验值不一致，请重新读取图片");
  return { ...actual, aiGenerated: asset.aiGenerated };
}

export function assertPackageImageTotal(images: Record<string, PackageImageInfo>) {
  const entries = Object.values(images);
  if (entries.length > CHAPTER_PACKAGE_LIMITS.images || entries.reduce((sum, image) => sum + image.bytes, 0) > CHAPTER_PACKAGE_LIMITS.totalImageBytes)
    throw new Error("章节包最多 12 张图片，合计不超过 8 MB");
}

export interface ImportPayload {
  chapter: { id: string; title: string; content: Array<{ text?: string; photoId?: string; blockId: string }>; containsAiText: boolean };
  layout: PackageLayout | null;
  packageId: string;
  senderName: string;
  storyTitle: string;
  lineage: { rootPackageId: string; parentPackageId: string | null };
  assets: PackageAsset[];
  assetPhotos: Record<string, string>;
  coverAssetId: string | null;
}

/**
 * 解包并整理成云函数要的样子。每个内容项都带上包里的 blockId：
 * blockId 由内容推出，内容一改就变，必须在留下副本时存下来，发回时才能对位。
 */
export function prepareImport(input: unknown, resolvedPhotoIds?: Record<string, string>): ImportPayload {
  let parsed: ChapterPackage;
  try { parsed = parseChapterPackage(input); }
  catch (error) {
    if (error instanceof ChapterPackageError) throw new Error("这个章节包无法使用：" + error.message);
    throw error;
  }
  if (parsed.chapters.length !== 1) throw new Error("当前入口只导入单章章节包，请先选择一章打包；没有导入任何章节");
  const assetIds = parsed.assets.map(asset => asset.assetId);
  if (resolvedPhotoIds && (Object.keys(resolvedPhotoIds).length !== assetIds.length || assetIds.some(id =>
      typeof resolvedPhotoIds[id] !== "string" || !/^photo-[a-z0-9-]{1,120}$/.test(resolvedPhotoIds[id]))))
    throw new Error("图片与章节包清单不匹配，请重新读取图片");
  const { chapter, layout, blockIds, assetPhotos } = fromChapterPackage(parsed, {
    ...(resolvedPhotoIds ? { resolvePhotoId: assetId => resolvedPhotoIds[assetId] } : {}),
  });
  assertLayoutFits(layout);
  return {
    chapter: {
      id: chapter.id, title: chapter.title, containsAiText: chapter.containsAiText === true,
      content: chapter.content.map((item, index) => ({
        ...(typeof item.text === "string" ? { text: item.text } : { photoId: item.photoId as string }),
        blockId: blockIds[index],
      })),
    },
    layout, packageId: parsed.packageId, senderName: parsed.sender.displayName, storyTitle: parsed.storyTitle, lineage: parsed.lineage,
    assets: parsed.assets, assetPhotos, coverAssetId: parsed.chapters[0].cover?.assetId ?? null,
  };
}

async function call<T>(action: string, data: Record<string, unknown>): Promise<T> {
  if (!chapterPackageEnabled()) throw new Error("章节包功能暂未开放");
  if (!wx.cloud) throw new Error("当前版本暂不支持章节包");
  const response = await wx.cloud.callFunction({ name: "storyBooks", data: { ...data, action } });
  const result = response.result as ({ error?: string; code?: string; message?: string } & T) | undefined;
  if (!result || result.error) throw Object.assign(new Error(result?.message || "章节包暂时没有导入，请稍后重试"), { code: result?.code });
  return result;
}

export const chapterPackageRequestId = () => `package-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const chapterPackages = {
  import: (payload: ImportPayload, target: ImportTarget, requestId: string, origin?: { storyId: string; chapterId: string }) =>
    call<{ ok: true; storyId: string; revisionId: string; chapterId: string; alreadyReceived: boolean }>("chapterPackageImport", {
      requestId, target, chapter: payload.chapter, layout: payload.layout, packageId: payload.packageId, senderName: payload.senderName, lineage: payload.lineage,
      assets: payload.assets, assetPhotos: payload.assetPhotos, coverAssetId: payload.coverAssetId,
      ...(origin ? { origin } : {}),
    }),
  revise: (input: { storyId: string; revisionId: string; expectedVersion: number; chapterId: string;
    edits: Array<{ blockId: string; text: string }>; layout: PackageLayout | null; requestId: string }) =>
    call<{ ok: true; storyId: string; revisionId: string; chapterId: string; version: number; alreadySaved: boolean }>("chapterPackageRevise", input),
};
