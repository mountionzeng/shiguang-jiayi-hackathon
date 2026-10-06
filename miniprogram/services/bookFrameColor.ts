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
  const watercolour: Hsl = [
    color[0],
    color[1] < .08 ? 0 : Math.min(.22, Math.max(.07, color[1] * .34)),
    color[2],
  ];
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    const [, , light] = hsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    const values = rgb([watercolour[0], watercolour[1], light]);
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
      const ctx = canvas.getContext('2d');
      canvas.width = 48; canvas.height = 48;
      ctx.drawImage(cover, 0, 0, 48, 48);
      const color = coverColor(ctx.getImageData(0, 0, 48, 48).data);
      // Keep the full-size edge crisp. Tint only its green cloth pigments to
      // match the shelf spine; the warm paper, page edges and cord stay intact.
      canvas.width = silhouette.width; canvas.height = silhouette.height;
      ctx.drawImage(silhouette, 0, 0);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      recolorSpine(frame.data, color);
      ctx.putImageData(frame, 0, 0);
      const left = canvas.width * .145, top = canvas.height * .025;
      const right = canvas.width * .95, bottom = canvas.height * .975;
      const radius = canvas.width * .018;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(left + radius, top);
      ctx.lineTo(right - radius, top);
      ctx.quadraticCurveTo(right, top, right, top + radius);
      ctx.lineTo(right, bottom - radius);
      ctx.quadraticCurveTo(right, bottom, right - radius, bottom);
      ctx.lineTo(left + radius, bottom);
      ctx.quadraticCurveTo(left, bottom, left, bottom - radius);
      ctx.lineTo(left, top + radius);
      ctx.quadraticCurveTo(left, top, left + radius, top);
      ctx.closePath();
      ctx.clip();
      const targetWidth = right - left, targetHeight = bottom - top;
      const scale = Math.max(targetWidth / cover.width, targetHeight / cover.height);
      const sourceWidth = targetWidth / scale, sourceHeight = targetHeight / scale;
      ctx.drawImage(cover, (cover.width - sourceWidth) / 2, (cover.height - sourceHeight) / 2,
        sourceWidth, sourceHeight, left, top, targetWidth, targetHeight);
      ctx.restore();
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


/** The source has sage cloth and warm paper. Recolour cloth only, never the label or cord. */
export function recolorSpine(pixels: Uint8ClampedArray, color: Hsl): void {
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3] || pixels[i + 1] <= pixels[i] || pixels[i + 1] <= pixels[i + 2]) continue;
    recolorFrame(pixels.subarray(i, i + 4), color);
  }
}

export function bookSpineKey(storyId: string, coverImageId: string): string {
  return `spine-v1:${storyId}:${coverImageId}`;
}

/** Reuse the small derivative cache and serial canvas queue; never generate new artwork. */
export function renderBookSpine(page: WechatMiniprogram.Page.TrivialInstance, url: string, key: string): Promise<string> {
  const cached = cachedBookCover(key);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(key);
  if (existing) return existing;
  const render = async () => {
    const canvas = await new Promise<WechatMiniprogram.Canvas>((resolve, reject) => {
      page.createSelectorQuery().select('#book-spine-canvas').fields({ node: true }).exec(results => {
        if (results[0]?.node) resolve(results[0].node);
        else reject(new Error('书脊画布未准备好'));
      });
    });
    const info = await new Promise<WechatMiniprogram.GetImageInfoSuccessCallbackResult>((resolve, reject) =>
      wx.getImageInfo({ src: url, success: resolve, fail: reject }));
    const cover = await loadImage(canvas, info.path);
    canvas.width = 48; canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(cover, 0, 0, 48, 48);
    const color = coverColor(ctx.getImageData(0, 0, 48, 48).data);
    const spine = await loadImage(canvas, '/assets/illustrations/story-book-spine.png');
    canvas.width = spine.width; canvas.height = spine.height;
    ctx.drawImage(spine, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    recolorSpine(pixels.data, color);
    ctx.putImageData(pixels, 0, 0);
    const path = await new Promise<string>((resolve, reject) => wx.canvasToTempFilePath({
      canvas, fileType: 'png', width: canvas.width, height: canvas.height,
      destWidth: canvas.width, destHeight: canvas.height,
      success: result => resolve(result.tempFilePath), fail: reject,
    }, page));
    return cacheBookCover(key, path);
  };
  const result = rendering.then(render, render);
  rendering = result.catch(() => undefined);
  pending.set(key, result);
  void result.finally(() => pending.delete(key)).catch(() => undefined);
  return result;
}
