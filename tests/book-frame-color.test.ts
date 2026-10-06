import test from 'node:test';
import assert from 'node:assert/strict';
import { blendCoverSeam, coverColor, recolorFrame, recolorSpine } from '../miniprogram/services/bookFrameColor';

const lightness = (pixels: Uint8ClampedArray, offset = 0) =>
  (Math.max(...pixels.slice(offset, offset + 3)) + Math.min(...pixels.slice(offset, offset + 3))) / 510;
const saturation = (pixels: Uint8ClampedArray) => {
  const delta = (Math.max(...pixels.slice(0, 3)) - Math.min(...pixels.slice(0, 3))) / 255;
  return delta ? delta / (1 - Math.abs(2 * lightness(pixels) - 1)) : 0;
};

test('yellow cover tints the frame while preserving silhouette and shading order', () => {
  const cover = new Uint8ClampedArray([210, 165, 72, 255, 215, 172, 80, 255, 255, 255, 255, 255]);
  const frame = new Uint8ClampedArray([80, 110, 90, 255, 120, 160, 135, 180, 160, 190, 175, 0]);
  const original = frame.slice();
  recolorFrame(frame, coverColor(cover));
  for (const i of [0, 4]) {
    assert.ok(frame[i] >= frame[i + 1] && frame[i + 1] >= frame[i + 2], 'green must become muted warm paper');
    assert.equal(frame[i + 3], original[i + 3], 'preserve the feathered seam alpha');
  }
  assert.ok(lightness(frame, 4) > lightness(frame), 'cloth highlights stay lighter than shadows');
  assert.deepEqual(frame.slice(8), original.slice(8), 'transparent cover opening remains unchanged');
});

test('blue and neutral covers stay calm and do not inherit any green frame hue', () => {
  const frame = () => new Uint8ClampedArray([80, 110, 90, 255]);
  const blue = frame();
  recolorFrame(blue, coverColor(new Uint8ClampedArray([40, 70, 170, 255])));
  assert.ok(blue[2] > blue[1] && blue[1] > blue[0]);
  const grey = frame();
  recolorFrame(grey, coverColor(new Uint8ClampedArray([160, 160, 160, 255])));
  assert.equal(grey[0], grey[1]);
  assert.equal(grey[1], grey[2]);
});

test('cover seam blends into book texture without softening the cord, outer rim or cover centre', () => {
  const width = 480, height = 745;
  const frame = new Uint8ClampedArray(width * height * 4);
  const composed = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < frame.length; i += 4) {
    frame.set([100, 110, 90, 255], i);
    composed.set([200, 150, 120, 255], i);
  }
  const left = width * .145, top = height * .025, right = width * .95, bottom = height * .975;
  blendCoverSeam(composed, frame, width, height, left, top, right, bottom);
  const red = (x: number, y = 300) => composed[(y * width + x) * 4];
  assert.equal(red(45), 200, 'pixels outside the artwork are untouched');
  assert.equal(red(70), 100, 'the inner left boundary starts with book texture');
  assert.ok(red(75) < red(82) && red(82) < red(90), 'the transition is gradual');
  assert.equal(red(110), 200, 'the artwork is clear past the narrow seam');
  assert.equal(red(240), 200, 'cover centre is untouched');
  assert.equal(red(70, 19), 200, 'top rim does not gain a dark band');
  assert.equal(red(70, 40), 100, 'left seam is blended below the top edge');
  assert.equal(red(455), 200, 'right paper edge stays sharp');
  assert.equal(red(250, 0), 200, 'outer rim is untouched');
});


test('spine matches cover hue while beige label, page edges and binding remain byte-identical', () => {
  const original = new Uint8ClampedArray([
    151, 168, 155, 255, 80, 110, 90, 180,
    243, 235, 212, 255, 120, 114, 94, 255, 230, 222, 201, 180,
    151, 168, 155, 0,
  ]);
  for (const color of [[.09, .6, .6], [.6, .7, .5], [0, 0, .6]] as [number, number, number][]) {
    const pixels = original.slice();
    recolorSpine(pixels, color);
    assert.notDeepEqual(pixels.slice(0, 3), original.slice(0, 3));
    assert.deepEqual(pixels.slice(8), original.slice(8), 'paper label, cord, pages and transparency stay unchanged');
    for (const i of [0, 4]) {
      assert.equal(pixels[i + 3], original[i + 3]);
    }
    if (color[0] === .09) assert.ok(pixels[0] > pixels[1] && pixels[1] > pixels[2]);
    if (color[0] === .6) assert.ok(pixels[2] > pixels[1] && pixels[1] > pixels[0]);
  }
});

test('cloth follows cover brightness and saturation independently', () => {
  const tint = (color: [number, number, number]) => {
    const pixels = new Uint8ClampedArray([151, 168, 155, 255]);
    recolorSpine(pixels, color);
    return pixels;
  };
  const dark = tint([.6, .5, .2]), pale = tint([.6, .5, .8]);
  assert.ok(lightness(pale) - lightness(dark) > .45, 'pale and dark covers must not share the old cloth brightness');
  const muted = tint([.6, .1, .5]), vivid = tint([.6, .8, .5]);
  assert.ok(saturation(vivid) - saturation(muted) > .5, 'vivid covers must not be capped at the old pastel saturation');
  assert.ok(Math.abs(lightness(vivid) - lightness(muted)) < .01, 'saturation changes do not change brightness');
});

test('overall cover tone is not dominated by a small vivid detail', () => {
  const pixels = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 99; i++) pixels.set([230, 230, 230, 255], i * 4);
  pixels.set([200, 40, 40, 255], 99 * 4);
  const [, s, l] = coverColor(pixels);
  assert.ok(s < .02, 'a tiny red detail must not turn a neutral book vivid red');
  assert.ok(l > .85, 'a tiny dark detail must not darken a pale book');
});

test('dark blue and pale blue covers retain their hue and measured tone', () => {
  for (const pixel of [[5, 10, 40, 255], [240, 245, 254, 255]]) {
    const pixels = new Uint8ClampedArray(pixel);
    const [h, s, l] = coverColor(pixels);
    assert.ok(h > .5 && h < .75);
    assert.ok(s > .4);
    assert.ok(Math.abs(l - lightness(pixels)) < .001);
  }
});

test('black and white covers preserve cloth folds without changing alpha or paper', () => {
  for (const value of [0, 255]) {
    const cover = coverColor(new Uint8ClampedArray([value, value, value, 255]));
    const cloth = new Uint8ClampedArray([80, 110, 90, 180, 151, 168, 155, 255, 170, 195, 180, 255, 243, 235, 212, 255]);
    recolorSpine(cloth, cover);
    assert.ok(lightness(cloth) < lightness(cloth, 4));
    assert.ok(lightness(cloth, 4) < lightness(cloth, 8));
    assert.equal(cloth[3], 180);
    assert.deepEqual(cloth.slice(12), new Uint8ClampedArray([243, 235, 212, 255]));
    assert.equal(cloth[0], cloth[1]);
    assert.equal(cloth[1], cloth[2]);
  }
  assert.deepEqual(coverColor(new Uint8ClampedArray([255, 0, 0, 0])), [0, 0, .7]);
});
