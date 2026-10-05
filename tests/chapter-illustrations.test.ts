import assert from 'node:assert/strict';
import test from 'node:test';
import { ManuscriptContent } from '../miniprogram/domain/biography';
import { illustrationAnchor, illustrationPoints, placeIllustration } from '../miniprogram/services/chapterIllustrations';
import { storyImageReferenceId } from '../miniprogram/services/bookImages';

const A = 'family_o-owner_img_req-aaaaaaaa';
const B = 'family_o-owner_img_req-bbbbbbbb';
const textOf = (content: ManuscriptContent[]) => content.map(item => item.text || '').join('');

test('段落定位保留全部原文、换行和原照片，多张插图可独立放置', () => {
  const content: ManuscriptContent[] = [{ text: '第一段。\r\n\r\n第二段。\n' }, { photoId: 'photo-original' }, { text: '最后一段。' }];
  const snapshot = structuredClone(content);
  const points = illustrationPoints(content);
  assert.deepEqual(points.map(item => item.after?.text), [undefined, '第一段。', '第二段。', '最后一段。']);
  const first = placeIllustration(content, A, points[1].after);
  const second = placeIllustration(first, B, points[2].after);
  assert.equal(textOf(second), textOf(content));
  assert.deepEqual(second.filter(item => item.photoId).map(item => item.photoId), [storyImageReferenceId(A), storyImageReferenceId(B), 'photo-original']);
  assert.deepEqual(illustrationAnchor(second, A), points[1].after);
  assert.deepEqual(placeIllustration(second, A, points[1].after), second, '同位置重试不新增或重排图片');
  assert.deepEqual(content, snapshot, '不修改输入或历史版本');
  const removed = placeIllustration(second, A, null, true);
  assert.equal(textOf(removed), textOf(content));
  assert.deepEqual(removed.filter(item => item.photoId).map(item => item.photoId), [storyImageReferenceId(B), 'photo-original']);
});

test('重复段落使用出现次数定位，段落改写、删除或重复数量变化拒绝错放', () => {
  const original = [{ text: '雨。\n雨。\n风。\n' }];
  const after = illustrationPoints(original)[2].after;
  assert.deepEqual(after, { text: '雨。', occurrence: 1, matches: 2 });
  const result = placeIllustration(original, A, after);
  assert.equal(result[0].text, '雨。\n雨。\n');
  assert.throws(() => placeIllustration([{ text: '雨。\n风。\n' }], A, after), /重新选择/);
  assert.throws(() => placeIllustration([{ text: '雪。\n风。\n' }], A, after), /重新选择/);
  const unique = illustrationPoints([{ text: '旧段。\n目标段。\n' }])[2].after;
  assert.equal(placeIllustration([{ text: '新增段。\n旧段。\n目标段。\n' }], A, unique)[0].text, '新增段。\n旧段。\n目标段。\n');
});

test('正文开头支持多图，同一图反复保存不改变其他图的顺序', () => {
  const first = placeIllustration([{ text: '正文。\n' }], A, null);
  const second = placeIllustration(first, B, null);
  assert.deepEqual(second.slice(0, 2), [{ photoId: storyImageReferenceId(A) }, { photoId: storyImageReferenceId(B) }]);
  assert.deepEqual(placeIllustration(second, A, null), second);
});

test('光标曾在段中插图时不会把半句话误当新段落，需重新选择完整段落', () => {
  const old: ManuscriptContent[] = [{ text: '那天，' }, { photoId: storyImageReferenceId(A) }, { text: '我们回家。\n' }];
  const anchor = illustrationAnchor(old, A);
  assert.equal(anchor?.text, '那天，');
  const choices = illustrationPoints(old, A);
  assert.equal(choices[1].after?.text, '那天，我们回家。');
  assert.throws(() => placeIllustration(old, A, anchor), /重新选择/);
  const moved = placeIllustration(old, A, choices[1].after);
  assert.equal(moved[0].text, '那天，我们回家。\n');
});

test('拒绝无效引用和丢失受保护文字来源信息', () => {
  assert.throws(() => placeIllustration([{ text: '正文' }], '../../image', null), /引用无效/);
  const protectedContent = [{ text: '有来源正文', sourceIds: ['source-private'], blockId: 'block-private' }];
  assert.throws(() => placeIllustration(protectedContent, A, null), /受保护来源/);
  assert.throws(() => placeIllustration(protectedContent, A, null, true), /受保护来源/);
  assert.deepEqual(protectedContent[0].sourceIds, ['source-private']);
});
