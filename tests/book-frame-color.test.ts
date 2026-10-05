import test from 'node:test';
import assert from 'node:assert/strict';
import { coverColor, recolorFrame, recolorSpine, softenLeftSeam } from '../miniprogram/services/bookFrameColor';

test('yellow cover softly tints the frame without changing silhouette or texture contrast', () => {
  const cover = new Uint8ClampedArray([210, 165, 72, 255, 215, 172, 80, 255, 255, 255, 255, 255]);
  const frame = new Uint8ClampedArray([80, 110, 90, 255, 120, 160, 135, 180, 160, 190, 175, 0]);
  const original = frame.slice();
  recolorFrame(frame, coverColor(cover));
  for (const i of [0, 4]) {
    assert.ok(frame[i] >= frame[i + 1] && frame[i + 1] >= frame[i + 2], 'green must become muted warm paper');
    assert.ok(frame[i] - frame[i + 2] < 50, 'tint stays soft rather than saturated');
    const light = (data: Uint8ClampedArray) => Math.max(...data.slice(i, i + 3)) + Math.min(...data.slice(i, i + 3));
    assert.ok(Math.abs(light(frame) - light(original)) <= 1, 'preserve original light/shadow texture');
    assert.equal(frame[i + 3], original[i + 3], 'preserve the feathered seam alpha');
  }
  assert.deepEqual(frame.slice(8), original.slice(8), 'transparent cover opening remains unchanged');
});

test('blue and neutral covers stay calm and do not inherit any green frame hue', () => {
  const frame = () => new Uint8ClampedArray([80, 110, 90, 255]);
  const blue = frame();
  recolorFrame(blue, coverColor(new Uint8ClampedArray([40, 70, 170, 255])));
  assert.ok(blue[2] > blue[1] && blue[1] > blue[0]);
  assert.ok(blue[2] - blue[0] < 50);
  const grey = frame();
  recolorFrame(grey, coverColor(new Uint8ClampedArray([160, 160, 160, 255])));
  assert.equal(grey[0], grey[1]);
  assert.equal(grey[1], grey[2]);
});

test('left seam fades smoothly without changing colour, binding cord, outer rim or cover centre', () => {
  const width = 480, height = 745;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  softenLeftSeam(pixels, width, height);
  const alpha = (x: number, y = 300) => pixels[(y * width + x) * 4 + 3];
  assert.equal(alpha(45), 255, 'binding cord stays opaque');
  assert.equal(alpha(60, 0), 255, 'top rim stays intact');
  assert.equal(alpha(60, 744), 255, 'bottom rim stays intact');
  assert.equal(alpha(240), 255, 'cover centre is untouched');
  assert.ok(alpha(55) > alpha(60) && alpha(60) > alpha(65) && alpha(65) > alpha(70));
  assert.ok(alpha(74) < 3, 'no hard inner edge');
  assert.equal(pixels[(300 * width + 65) * 4], 255, 'seam does not recolour the image');
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
      assert.ok(Math.max(...pixels.slice(i, i + 3)) - Math.min(...pixels.slice(i, i + 3)) < 55);
    }
    if (color[0] === .09) assert.ok(pixels[0] > pixels[1] && pixels[1] > pixels[2]);
    if (color[0] === .6) assert.ok(pixels[2] > pixels[1] && pixels[1] > pixels[0]);
  }
});
