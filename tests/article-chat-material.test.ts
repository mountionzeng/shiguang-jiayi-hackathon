import assert from 'node:assert/strict';
import test from 'node:test';
import { articleChatMaterial } from '../miniprogram/services/articleChatMaterial';

test('dialogue material includes every user turn and unsent text, never assistant guesses', () => {
  assert.deepEqual(articleChatMaterial([{role:'user',text:'虚构：纸船是蓝的'}, {role:'assistant',text:'是不是你妈妈折的？'}, {role:'user',text:'是我自己折的'}], '灯塔是黄的'), ['虚构：纸船是蓝的\n是我自己折的\n灯塔是黄的']);
  assert.deepEqual(articleChatMaterial([{role:'user',text:'原话'}], '原话'), ['原话']);
  assert.deepEqual(articleChatMaterial([{role:'assistant',text:'建议'}], ''), []);
});
test('long dialogue is segmented without silently losing earlier words', () => {
  const text = '甲'.repeat(1100);
  const segments = articleChatMaterial([], text);
  assert.equal(segments.join(''), text);
  assert.ok(segments.every(part => part.length <= 500));
  assert.throws(() => articleChatMaterial([], '甲'.repeat(4001)), /4000/);
});
