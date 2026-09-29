import test from 'node:test';
import assert from 'node:assert/strict';
import { coverColor, recolorFrame, softenLeftSeam } from '../miniprogram/services/bookFrameColor';

test('yellow cover replaces green hue without changing frame silhouette or texture contrast', () => {
  const cover = new Uint8ClampedArray([210, 165, 72, 255, 215, 172, 80, 255, 255, 255, 255, 255]);
  const frame = new Uint8ClampedArray([80, 110, 90, 255, 120, 160, 135, 180, 160, 190, 175, 0]);
  const original = frame.slice();
  recolorFrame(frame, coverColor(cover));
  for (const i of [0, 4]) {
    assert.ok(frame[i] > frame[i + 1] && frame[i + 1] > frame[i + 2], 'green must become warm gold');
    const light = (data: Uint8ClampedArray) => Math.max(...data.slice(i, i + 3)) + Math.min(...data.slice(i, i + 3));
    assert.ok(Math.abs(light(frame) - light(original)) <= 1, 'preserve original light/shadow texture');
    assert.equal(frame[i + 3], original[i + 3], 'preserve the feathered seam alpha');
  }
  assert.deepEqual(frame.slice(8), original.slice(8), 'transparent cover opening remains unchanged');
});

test('blue and neutral covers do not inherit any green frame hue', () => {
  const frame = () => new Uint8ClampedArray([80, 110, 90, 255]);
  const blue = frame();
  recolorFrame(blue, coverColor(new Uint8ClampedArray([40, 70, 170, 255])));
  assert.ok(blue[2] > blue[1] && blue[1] > blue[0]);
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
