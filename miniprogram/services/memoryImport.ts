import { MAX_MEMORY_LENGTH } from "../domain/biography";

export const MAX_IMPORT_CHARS = 20_000;
export const MAX_IMPORT_FILE_BYTES = 1024 * 1024;

export interface ImportFileLike {
  name?: string;
  path: string;
  size?: number;
  type?: string;
}

export interface ClassifiedImportFiles {
  images: ImportFileLike[];
  text?: ImportFileLike;
  unsupportedNames: string[];
}

function extension(name = ""): string {
  return name.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? "";
}

export function classifyImportFiles(files: ImportFileLike[]): ClassifiedImportFiles {
  const images: ImportFileLike[] = [];
  const texts: ImportFileLike[] = [];
  const unsupportedNames: string[] = [];
  for (const file of files) {
    const ext = extension(file.name);
    if (file.type === "image" || ["jpg", "jpeg", "png", "webp", "gif", "heic"].includes(ext)) {
      images.push(file);
    } else if (["txt", "md"].includes(ext)) {
      texts.push(file);
    } else {
      unsupportedNames.push(file.name || "未命名文件");
    }
  }
  if (texts.length > 1) throw new Error("一次只能导入一个文字文件");
  if (images.length > 9) throw new Error("一次最多导入 9 张照片");
  return { images, text: texts[0], unsupportedNames };
}

function markdownText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "");
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function splitLongParagraph(paragraph: string): string[] {
  const symbols = Array.from(paragraph.trim());
  const segments: string[] = [];
  let start = 0;
  while (start < symbols.length) {
    const hardEnd = Math.min(start + MAX_MEMORY_LENGTH, symbols.length);
    if (hardEnd === symbols.length) {
      segments.push(symbols.slice(start).join("").trim());
      break;
    }
    let end = hardEnd;
    for (let index = hardEnd - 1; index >= start; index -= 1) {
      if (/[。！？；!?;]/.test(symbols[index])) {
        end = index + 1;
        break;
      }
    }
    segments.push(symbols.slice(start, end).join("").trim());
    start = end;
  }
  return segments.filter(Boolean);
}

export function splitImportedText(raw: string, kind: "txt" | "md" = "txt"): string[] {
  const withoutBom = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (withoutBom.includes("�")) throw new Error("这个文件不是 UTF-8 编码，读出来会是乱码。可以用手机备忘录另存一次再导入");
  const cleaned = (kind === "md" ? markdownText(withoutBom) : withoutBom).trim();
  if (!cleaned) throw new Error("这个文件里没有可导入的文字");
  if (codePointLength(cleaned) > MAX_IMPORT_CHARS) throw new Error("一次最多导入 2 万字，请分成几个文件");
  return cleaned.split(/\n+/).map(part => part.trim()).filter(Boolean).flatMap(splitLongParagraph);
}

export function importTitle(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim().slice(0, 30) || "导入的记忆";
}

export function readImportTextFile(file: ImportFileLike): Promise<{ title: string; segments: string[] }> {
  if (Number(file.size || 0) > MAX_IMPORT_FILE_BYTES) return Promise.reject(new Error("文字文件超过 1 MB，请分成几个文件"));
  const kind = extension(file.name) === "md" ? "md" : "txt";
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath: file.path,
    encoding: "utf-8",
    success: result => {
      try {
        resolve({ title: importTitle(file.name || ""), segments: splitImportedText(String(result.data || ""), kind) });
      } catch (error) { reject(error); }
    },
    fail: reject,
  }));
}
