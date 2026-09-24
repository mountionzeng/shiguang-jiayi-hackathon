export type ImageLayoutMode = 'pages' | 'long';
export type ImageFontSize = 28 | 32 | 36;
export interface TextLine { text: string; newline: boolean }
export interface LayoutRow { text: string; y: number; fontSize: number; heading: boolean }
export interface TextImagePage { height: number; rows: LayoutRow[] }
export const IMAGE_WIDTH = 750;
export const PAGE_HEIGHT = 1080;
export const MAX_LONG_HEIGHT = 6000;
export const TEXT_WIDTH = 630;
export type MeasureText = (text: string, fontSize: number) => number;

/** Preserve every code point and explicit newline, including empty paragraphs. */
export function wrapImageText(text: string, fontSize: number, measure: MeasureText): TextLine[] {
  const lines: TextLine[] = [];
  let line = '';
  for (const character of Array.from(text)) {
    if (character === '\n') { lines.push({ text: line, newline: true }); line = ''; continue; }
    if (line && measure(line + character, fontSize) > TEXT_WIDTH) { lines.push({ text: line, newline: false }); line = ''; }
    line += character;
  }
  if (line || !lines.length) lines.push({ text: line, newline: false });
  return lines;
}

export function layoutTextImages(title: string, chapters: Array<{ title: string; text: string }>, mode: ImageLayoutMode,
  fontSize: ImageFontSize, measure: MeasureText): TextImagePage[] {
  if (!['pages', 'long'].includes(mode) || ![28,32,36].includes(fontSize)) throw new Error('请选择排版与字号');
  const headingSize = 38, lineHeight = Math.ceil(fontSize * 1.75);
  const top = 66 + wrapImageText(title, 24, measure).length * 34 + 32;
  const bottom = mode === 'pages' ? PAGE_HEIGHT - 106 : MAX_LONG_HEIGHT - 106;
  if (top + 54 + lineHeight > bottom) throw new Error('书名过长，无法完整排版，请缩短书名后重试');
  const pages: TextImagePage[] = [];
  let rows: LayoutRow[] = [], y = top;
  function nextPage() {
    if (mode === 'long') throw new Error('内容超过单张长图的尺寸上限，请选择分页图片；正文不会截断');
    pages.push({ height: PAGE_HEIGHT, rows }); rows = []; y = top;
  }
  function append(text: string, size: number, height: number, heading: boolean) {
    if (y + height > bottom) nextPage();
    rows.push({ text, y, fontSize: size, heading }); y += height;
  }
  for (const chapter of chapters) {
    const headingLines = wrapImageText(chapter.title || '故事片段', headingSize, measure);
    if (rows.length && y + headingLines.length * 54 + lineHeight * 2 > bottom) nextPage();
    for (const line of headingLines) append(line.text, headingSize, 54, true);
    y += 16;
    for (const line of wrapImageText(chapter.text, fontSize, measure)) append(line.text, fontSize, lineHeight, false);
    y += 26;
  }
  if (rows.length) pages.push({ height: mode === 'pages' ? PAGE_HEIGHT : Math.max(PAGE_HEIGHT, y - 26 + 106), rows });
  if (!pages.length) throw new Error('没有可以排版的文字');
  if (pages.length > 160) throw new Error('图片数量过多，请分批选择章节');
  return pages;
}
