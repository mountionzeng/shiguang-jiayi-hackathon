const test = require('node:test');
const assert = require('node:assert/strict');
const {createTextModerator} = require('../cloudfunctions/storyBooks/moderation');
const {errorCode} = require('../cloudfunctions/storyBooks/errors');

/*
 * 回归：检测服务自己坏了，不能说成用户的内容违规。
 * 原实现在 security 缺失、openid 无效、msgSecCheck 抛错时一律返回 false，
 * 调用方按 `!== true` 提示「这段内容没有通过内容安全检测，请修改后重试」，
 * 用户改多少遍都没用，而且不留日志。
 */
test('检测服务故障抛 MODERATION_UNAVAILABLE，不再被当成内容违规', async () => {
  await assert.rejects(
    () => createTextModerator(undefined)('一段回忆', 'openid-1'),
    error => error.code === 'MODERATION_UNAVAILABLE',
  );
  await assert.rejects(
    () => createTextModerator({})('一段回忆', 'openid-1'),
    error => error.code === 'MODERATION_UNAVAILABLE',
  );
  await assert.rejects(
    () => createTextModerator({msgSecCheck: async () => ({})})('一段回忆', '非法 openid!'),
    error => error.code === 'MODERATION_UNAVAILABLE',
  );
  await assert.rejects(
    () => createTextModerator({msgSecCheck: async () => {throw new Error('网络超时');}})('一段回忆', 'openid-1'),
    error => error.code === 'MODERATION_UNAVAILABLE',
  );
  assert.equal(errorCode(Object.assign(new Error('暂时不可用'), {code: 'MODERATION_UNAVAILABLE'})), 'MODERATION_UNAVAILABLE');
});

test('内容确实违规时仍然返回 false，用户改文字可以解决', async () => {
  const moderate = createTextModerator({msgSecCheck: async () => ({result: {suggest: 'risky'}})});
  assert.equal(await moderate('需要修改的内容', 'openid-1'), false);
});

test('内容通过时返回 true，空内容不打扰检测服务', async () => {
  let calls = 0;
  const moderate = createTextModerator({msgSecCheck: async () => {calls += 1; return {result: {suggest: 'pass'}};}});
  assert.equal(await moderate('平常的一段回忆', 'openid-1'), true);
  assert.equal(await moderate('   ', 'openid-1'), true);
  assert.equal(calls, 1, '空内容不应该调用检测接口');
});

test('storyBooks 直连检测不可用时复用共享内容安全云函数', async () => {
  const calls = [];
  const moderate = createTextModerator({
    msgSecCheck: async () => { throw new Error('direct openapi unavailable'); },
  }, async request => {
    calls.push(request);
    return { result: { ok: true, suggest: 'pass', label: 100 } };
  });
  assert.equal(await moderate('平常的一段回忆', 'openid-1', '公开故事卡片'), true);
  assert.deepEqual(calls, [{
    name: 'contentSecurityCheck',
    data: { content: '平常的一段回忆', scene: 4, openid: 'openid-1', title: '公开故事卡片' },
  }]);
});

test('共享内容安全云函数故障时仍然抛 MODERATION_UNAVAILABLE', async () => {
  const moderate = createTextModerator(undefined, async () => ({ result: { ok: false, error: 'CHECK_UNAVAILABLE' } }));
  await assert.rejects(
    () => moderate('平常的一段回忆', 'openid-1', '公开故事卡片'),
    error => error.code === 'MODERATION_UNAVAILABLE',
  );
});
