const test = require('node:test');
const assert = require('node:assert/strict');

const { familyIdFor: accountFamilyId } = require('../cloudfunctions/getOpenId/account.js');
const { familyIdFor: imagesFamilyId } = require('../cloudfunctions/storyImages/core.js');
const { fallbackFamilyId: audioFamilyId } = require('../cloudfunctions/storyAudio/identity.js');

/*
 * 每个用户的房间是 family_<openid>。原先七处都用
 *   openid.replace(/[^0-9A-Za-z_-]/g, "_")
 * 把非法字符悄悄换成下划线，于是两个不同的 openid 可能被洗成同一个 familyId——
 * 两个用户共用一个房间，故事互相串门。
 * 微信 openid 实际就是 [0-9A-Za-z_-]{28}，永远不触发替换，所以这是一个
 * 没有守卫的假设，正是用户变多以后才会咬人的那种。现在改为校验。
 */
const DERIVATIONS = [
  ['getOpenId/account.js', accountFamilyId],
  ['storyImages/core.js', imagesFamilyId],
  ['storyAudio/identity.js', audioFamilyId],
];

test('真实形态的 openid 推导结果不变', () => {
  for (const [name, derive] of DERIVATIONS) {
    assert.equal(derive('ogGIUxhQqqwJhzqPm0AtlfU9CaBo'), 'family_ogGIUxhQqqwJhzqPm0AtlfU9CaBo', name);
    assert.equal(derive('a-b_c123'), 'family_a-b_c123', name);
  }
});

test('曾经会撞成同一个房间的两个 openid，现在不会再共用房间', () => {
  for (const [name, derive] of DERIVATIONS) {
    // 旧实现：'abc def' 与 'abc_def' 都被洗成 family_abc_def —— 同一个房间。
    assert.equal(derive('abc_def'), 'family_abc_def', name);
    assert.throws(() => derive('abc def'), /INVALID_OPENID/, `${name}：带空格的 openid 必须报错而不是被洗成别人的房间`);
  }
});

test('各种不合规的 openid 一律报错，不再被悄悄洗成某个房间', () => {
  const bad = ['', '   ', 'a/b', 'a.b', '../../etc', '张三', 'a\u0000b', 'x'.repeat(129), null, undefined, 42, {}];
  for (const [name, derive] of DERIVATIONS) {
    for (const value of bad) {
      assert.throws(() => derive(value), /INVALID_OPENID/, `${name}：${JSON.stringify(value)} 应当报错`);
    }
  }
});

test('三处推导规则完全一致，同一个 openid 不会分裂出两个房间', () => {
  for (const openid of ['ogGIUxhQqqwJhzqPm0AtlfU9CaBo', 'a-b_c123', 'Z'.repeat(128)]) {
    const results = DERIVATIONS.map(([, derive]) => derive(openid));
    assert.equal(new Set(results).size, 1, `${openid} 在不同云函数里得到了不同的 familyId：${results.join(' / ')}`);
  }
});
