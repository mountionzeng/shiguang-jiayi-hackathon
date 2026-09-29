import { cacheBookCover, cachedBookCover } from './bookCoverCache';
import { startPerformanceMeasure } from './performanceLog';

type Hsl = [number, number, number];

function hsl(r: number, g: number, b: number): Hsl {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const delta = max - min, light = (max + min) / 2;
  if (!delta) return [0, 0, light];
  const hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue / 6, delta / (1 - Math.abs(2 * light - 1)), light];
}

function rgb([h, s, l]: Hsl): number[] {
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map(n => {
    const k = (n + h * 12) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  });
}

/** Dominant colour excludes white margins and dark lettering. */
export function coverColor(pixels: Uint8ClampedArray): Hsl {
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
  let grey = 0, count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const [h, s, l] = hsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    grey += l; count++;
    if (l < .12 || l > .94 || s < .08) continue;
    const bin = bins[Math.floor(h * 24) % 24], weight = .2 + s;
    bin.weight += weight;
    bin.r += pixels[i] * weight; bin.g += pixels[i + 1] * weight; bin.b += pixels[i + 2] * weight;
  }
  const best = bins.reduce((a, b) => b.weight > a.weight ? b : a);
  return best.weight ? hsl(best.r / best.weight, best.g / best.weight, best.b / best.weight)
    : [0, 0, count ? grey / count : .7];
}

/** Replace the frame's colour, preserving its original alpha and luminance detail. */
export function recolorFrame(pixels: Uint8ClampedArray, color: Hsl): void {
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    const [, , light] = hsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    const values = rgb([color[0], color[1], light]);
    pixels[i] = values[0]; pixels[i + 1] = values[1]; pixels[i + 2] = values[2];
  }
}

/** Feather only the inner left seam, after the binding cord; leave the outer rim intact. */
export function softenLeftSeam(pixels: Uint8ClampedArray, width: number, height: number): void {
  const start = width * .1125, end = width * .15625;
  const smooth = (value: number) => {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < height; y++) {
    const inside = smooth((Math.min(y, height - 1 - y) / height - .015) / .025);
    for (let x = Math.ceil(start); x < Math.ceil(end); x++) {
      const alpha = (y * width + x) * 4 + 3;
      pixels[alpha] = Math.round(pixels[alpha] * (1 - inside * smooth((x - start) / (end - start))));
    }
  }
}

const pending = new Map<string, Promise<string>>();
let rendering: Promise<unknown> = Promise.resolve();

function loadImage(canvas: WechatMiniprogram.Canvas, src: string): Promise<WechatMiniprogram.Image> {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    const timer = setTimeout(() => reject(new Error('书框图片加载超时')), 15000);
    image.onload = () => { clearTimeout(timer); resolve(image); };
    image.onerror = () => { clearTimeout(timer); reject(new Error('书框图片加载失败')); };
    image.src = src;
  });
}

/** Compose once, clip to the original paper silhouette, then reuse the local image. */
export function renderBookCover(page: WechatMiniprogram.Page.TrivialInstance, url: string, key: string): Promise<string> {
  const cached = cachedBookCover(key);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(key);
  if (existing) return existing;
  const render = async () => {
    const finish = startPerformanceMeasure('book.cover-render');
    let outcome: 'ok' | 'error' = 'error';
    try {
      const canvas = await new Promise<WechatMiniprogram.Canvas>((resolve, reject) => {
        page.createSelectorQuery().select('#book-frame-canvas').fields({ node: true }).exec(results => {
          if (results[0]?.node) resolve(results[0].node);
          else reject(new Error('书框画布未准备好'));
        });
      });
      const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve, reject) =>
        wx.getImageInfo({ src: url, success: resolve, fail: reject }));
      const cover = await loadImage(canvas, info.path);
      const silhouette = await loadImage(canvas, '/assets/illustrations/story-book-cover.png');
      canvas.width = 48; canvas.height = 48;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(cover, 0, 0, 48, 48);
      const color = coverColor(ctx.getImageData(0, 0, 48, 48).data);
      const frame = await loadImage(canvas, '/assets/illustrations/story-book-cover-frame.png');
      // Two source pixels per display pixel keep generated artwork crisp on phones.
      canvas.width = frame.width * 2; canvas.height = frame.height * 2;
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      recolorFrame(pixels.data, color);
      softenLeftSeam(pixels.data, canvas.width, canvas.height);
      ctx.putImageData(pixels, 0, 0);
      // Keep the established cover crop. Only its outer outline changes: artwork
      // cannot show through the transparent corners and paper fibres of the book.
      ctx.globalCompositeOperation = 'destination-over';
      const targetWidth = canvas.width * 1.1, targetHeight = canvas.height * 1.16;
      const scale = Math.max(targetWidth / cover.width, targetHeight / cover.height);
      const sourceWidth = targetWidth / scale, sourceHeight = targetHeight / scale;
      ctx.drawImage(cover, (cover.width - sourceWidth) / 2, (cover.height - sourceHeight) / 2,
        sourceWidth, sourceHeight, -canvas.width * .05, -canvas.height * .08, targetWidth, targetHeight);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(silhouette, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      const path = await new Promise<string>((resolve, reject) => wx.canvasToTempFilePath({
        canvas, fileType: 'png', width: canvas.width, height: canvas.height,
        destWidth: canvas.width, destHeight: canvas.height,
        success: result => resolve(result.tempFilePath), fail: reject,
      }, page));
      const saved = await cacheBookCover(key, path);
      outcome = 'ok';
      return saved;
    } finally { finish(outcome); }
  };
  const result = rendering.then(render, render);
  rendering = result.catch(() => undefined);
  pending.set(key, result);
  void result.finally(() => pending.delete(key)).catch(() => undefined);
  return result;
}
