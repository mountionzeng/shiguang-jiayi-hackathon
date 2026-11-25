const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { loginDisplayName } = require('../cloudfunctions/drinkingTimeBridge/loginProfile');
const openid = 'caller-openid';
function db(data) { return { collection(table) {
  assert.equal(table, 'user_accounts');
  return { doc(id) {
    assert.equal(id, 'account_' + createHash('sha256').update(openid).digest('hex').slice(0,24));
    return { get: async () => ({ data }) };
  } };
} }; }
test('uses only the authenticated caller profile', async () => {
  assert.equal(await loginDisplayName(db({ wxOpenId: openid, status: 'active', displayName: '岱' }), { OPENID: openid }), '岱');
});
test('rejects mismatched, inactive, missing and oversized profiles', async () => {
  for (const data of [undefined, { wxOpenId: 'other', status:'active',displayName:'错' },
    {wxOpenId:openid,status:'deleted',displayName:'旧'}, {wxOpenId:openid,status:'active',displayName:'一二三四五六七八九'}]) {
    assert.equal(await loginDisplayName(db(data), { OPENID: openid }), undefined);
  }
});
