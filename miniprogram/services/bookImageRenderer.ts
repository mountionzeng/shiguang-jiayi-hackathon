import { BookExportMaterial } from './bookExport';
import { ImageLayoutMode, ImageFontSize, IMAGE_WIDTH, PAGE_HEIGHT, TEXT_WIDTH, layoutTextImages, wrapImageText } from './bookImageLayout';

export function removeImageFiles(paths: string[]) {
  for (const filePath of paths) wx.getFileSystemManager().unlink({ filePath, fail: () => undefined });
}
function layoutForTarget(title: string, chapters: Array<{ title: string; text: string }>, mode: ImageLayoutMode,
  fontSize: ImageFontSize, targetTextImageCount: number | undefined, measure: (text: string, fontSize: number) => number) {
  const first = layoutTextImages(title, chapters, mode, fontSize, measure);
  if (!targetTextImageCount || mode !== 'pages' || first.length === targetTextImageCount) return first;
  const candidates = ([fontSize, 28, 32, 36] as ImageFontSize[]).filter((size, index, all) => all.indexOf(size) === index);
  const counts = new Map<number, number>();
  counts.set(fontSize, first.length);
  for (const size of candidates.filter(size => size !== fontSize)) {
    const pages = layoutTextImages(title, chapters, mode, size, measure);
    counts.set(size, pages.length);
    if (pages.length === targetTextImageCount) return pages;
  }
  const possible = [...new Set([...counts.values()])].sort((a, b) => a - b).join('、');
  throw new Error('当前内容可生成 ' + possible + ' 张正文图，请调整正文图片数量或内容后重试');
}
function timed<T>(run: (resolve: (value: T) => void, reject: (error: unknown) => void) => void, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + '超时，请重试')), 20000);
    run(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
export async function renderBookImages(material: BookExportMaterial, mode: ImageLayoutMode, fontSize: ImageFontSize,
  page: WechatMiniprogram.Page.TrivialInstance, isActive: () => boolean, progress: (done: number, total: number) => void): Promise<string[]> {
  const assertActive = () => { if (!isActive()) throw new Error('已停止本次图片生成'); };
  const canvas = await timed<WechatMiniprogram.Canvas>((resolve, reject) => {
    page.createSelectorQuery().select('#book-send-canvas').fields({ node: true, size: true }).exec(results => {
      const node = results[0]?.node as WechatMiniprogram.Canvas | undefined;
      if (node) resolve(node); else reject(new Error('图片画布未准备好，请重试'));
    });
  }, '准备画布');
  assertActive();
  const ctx = canvas.getContext('2d');
  const measure = (text: string, size: number) => { ctx.font = size + 'px sans-serif'; return ctx.measureText(text).width; };
  const descriptor = material.descriptor;
  const pages = layoutForTarget(descriptor.title, descriptor.chapters, mode, fontSize, descriptor.targetTextImageCount, measure);
  const titleLines = wrapImageText(descriptor.title, 42, measure);
  if (titleLines.length > 10) throw new Error('书名过长，无法完整排版，请缩短书名后重试');
  const headerLines = wrapImageText(descriptor.title, 24, measure);
  const paths: string[] = [];
  try {
    assertActive();
    const coverUrls = material.coverUrls?.length ? material.coverUrls : [material.coverUrl || ''];
    const covers = [];
    for (const url of coverUrls) {
      const cover = await timed<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve, reject) => wx.getImageInfo({
        src: url || '/assets/illustrations/story-book-cover.png', success: resolve, fail: reject }), '读取封面');
      const coverImage = canvas.createImage();
      await timed<void>((resolve, reject) => {
        coverImage.onload = () => resolve();
        coverImage.onerror = () => reject(new Error('封面暂时无法加载，请重试'));
        // Bundled image paths from getImageInfo lack a leading slash on WeChat.
        coverImage.src = url ? cover.path : '/assets/illustrations/story-book-cover.png';
      }, '加载封面');
      assertActive();
      if (!cover.width || !cover.height) throw new Error('封面暂时无法读取，请重试');
      covers.push({ info: cover, image: coverImage });
    }
    for (let index = 0; index < covers.length + pages.length; index++) {
      assertActive();
      const coverIndex = index < covers.length ? index : -1;
      const textIndex = index - covers.length;
      const height = coverIndex >= 0 ? PAGE_HEIGHT : pages[textIndex].height;
      await timed<void>(resolve => page.setData({ canvasHeight: height }, () => resolve()), '准备画布');
      assertActive();
      canvas.width = IMAGE_WIDTH; canvas.height = height;
      ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#fbf8f1'; ctx.fillRect(0, 0, IMAGE_WIDTH, height);
      ctx.fillStyle = '#4f7f6b'; ctx.fillRect(60, 44, 56, 5);
      if (coverIndex >= 0) {
        const cover = covers[coverIndex].info, coverImage = covers[coverIndex].image;
        ctx.fillStyle = '#2a2e2b'; ctx.font = 42 + 'px sans-serif';
        titleLines.forEach((line, i) => ctx.fillText(line.text, 60, 80 + i * 58));
        const top = 100 + titleLines.length * 58, available = height - top - 130;
        const scale = Math.min(TEXT_WIDTH / cover.width, available / cover.height);
        ctx.drawImage(coverImage, (IMAGE_WIDTH - cover.width * scale) / 2, top, cover.width * scale, cover.height * scale);
      } else {
        ctx.fillStyle = '#6a6e68'; ctx.font = 24 + 'px sans-serif';
        headerLines.forEach((line, i) => ctx.fillText(line.text, 60, 66 + i * 34));
        for (const row of pages[textIndex].rows) {
          ctx.fillStyle = row.heading ? '#4f7f6b' : '#2a2e2b'; ctx.font = row.fontSize + 'px sans-serif'; ctx.fillText(row.text, 60, row.y);
        }
      }
      ctx.fillStyle = '#d7d6ca'; ctx.fillRect(60, height - 78, TEXT_WIDTH, 1);
      ctx.fillStyle = '#6a6e68'; ctx.font = 20 + 'px sans-serif';
      ctx.fillText(coverIndex >= 0 ? '拾光家忆' + (descriptor.coverImageId ? ' · AI 生成封面' : '')
        : '拾光家忆' + (descriptor.containsAiText ? ' · 含 AI 生成文字' : ''), 60, height - 52);
      ctx.textAlign = 'right'; ctx.fillText(coverIndex >= 0 ? (covers.length > 1 ? '封面 ' + (coverIndex + 1) + ' / ' + covers.length : '封面') : (textIndex + 1) + ' / ' + pages.length, 690, height - 52);
      assertActive();
      const path = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => { settled = true; reject(new Error('导出图片超时，请重试')); }, 20000);
        wx.canvasToTempFilePath({ canvas, x: 0, y: 0, width: IMAGE_WIDTH, height, destWidth: IMAGE_WIDTH, destHeight: height,
          fileType: 'jpg', quality: .95, success: result => {
            clearTimeout(timer);
            if (settled) { removeImageFiles([result.tempFilePath]); return; }
            settled = true;
            if (!isActive()) { removeImageFiles([result.tempFilePath]); reject(new Error('已停止本次图片生成')); }
            else resolve(result.tempFilePath);
          }, fail: error => { settled = true; clearTimeout(timer); reject(error); } }, page);
      });
      paths.push(path); assertActive(); progress(paths.length, pages.length + covers.length);
    }
    return paths;
  } catch (error) { removeImageFiles(paths); throw error; }
}
