import test from 'node:test';
import assert from 'node:assert/strict';
import { articleChapter, changeArticleText, moveArticleModule } from '../miniprogram/services/articleModules';
import { articleEditorPages } from '../miniprogram/services/articleEditorLayout';

test('long manually narrowed text grows beyond the print page without clipping following content', () => {
  let chapter = articleChapter({ id: 'resize', title: '', memoryIds: [], content: [{text: '原文'}, {text: '后面的文字'}] });
  const module = chapter.layout.pages[0].modules[0];
  chapter = moveArticleModule(chapter, module.id, -500, 0, true);
  const text = '粘贴后的文字不能被裁掉。'.repeat(100);
  chapter = changeArticleText(chapter, chapter.content[0].blockId, text).chapter;
  const stored = JSON.stringify(chapter);
  const page = articleEditorPages(chapter, .32, {})[0];
  const first = page.modules[0], second = page.modules[1];
  assert.ok(first.height > 1200 * .32);
  assert.ok(second.top > first.top + first.height);
  assert.ok(page.height > second.top + second.height);
  assert.equal(first.text, text);
  assert.equal(first.width, 304 * .32);
  assert.equal(JSON.stringify(chapter), stored, 'responsive geometry does not invalidate the persisted print canvas');
  const reopened = articleEditorPages(articleChapter(JSON.parse(stored)), .32, {})[0];
  assert.equal(reopened.modules[0].height, first.height);
});

test('native wrap measurements size modules, shrink after deletion and expire when text or width changes', () => {
  const chapter = articleChapter({ id: 'native', title: '', memoryIds: [], content: [{text: 'A long English paragraph '.repeat(30)}] });
  const first = articleEditorPages(chapter, .35, {})[0].modules[0];
  const measured = { [first.id]: {key: first.measurementKey, height: 350} };
  assert.equal(articleEditorPages(chapter, .35, {}, measured)[0].modules[0].height, 358);
  const smaller = changeArticleText(chapter, chapter.content[0].blockId, '短句').chapter;
  assert.ok(articleEditorPages(smaller, .35, {}, measured)[0].modules[0].height < 100);
  const narrower = articleEditorPages(chapter, .2, {}, measured)[0].modules[0];
  assert.notEqual(narrower.measurementKey, first.measurementKey);
  assert.notEqual(narrower.height, 358);
  assert.match(narrower.fontStyle, /font-size:12px/);
});
