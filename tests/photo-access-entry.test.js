const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const core = require('../cloudfunctions/photoAccess/core');

const openid = 'new-photo-owner';
const accountId = `account_${crypto.createHash('sha256').update(openid).digest('hex').slice(0, 24)}`;
const familyId = `family_${openid}`;
const photoId = 'photo-1720000000000-abc123';
const event = { action: 'register', familyId, photoId, source: 'import',
  displayFileID: `cloud://env/user-photos/${familyId}/${photoId}/display.jpg`,
  smallFileID: `cloud://env/user-photos/${familyId}/${photoId}/small.jpg`,
  width: 100, height: 100, displayBytes: 100, smallBytes: 50 };
function harness(overrides = {}) {
  const records = {
    [`user_accounts/${accountId}`]: { accountId, wxOpenId: openid, status: 'active', primaryFamilyId: familyId },
    [`families/${familyId}`]: { ownerAccountId: accountId, _openid: openid },
    ...overrides,
  };
  let writes = 0;
  const db = { command: {}, async createCollection() {}, serverDate: () => new Date(),
    collection(name) {
      const query = { where() { return this; }, orderBy() { return this; }, skip() { return this; }, limit() { return this; }, async get() { return { data: [] }; } };
      return { ...query, doc(id) { const key = `${name}/${id}`; return {
        async get() { if (!records[key]) throw new Error('not found'); return { data: records[key] }; },
        async set({data}) { writes++; records[key] = data; }, async update() {},
      }; } };
    },
  };
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ SOURCE: 'wx_client', OPENID: openid }),
    async getTempFileURL({fileList}) { return { fileList: fileList.map(item => ({...item, tempFileURL: 'https://example.test/photo.jpg'})) }; },
    openapi: { security: { async mediaCheckAsync() { return {traceId:'test-trace'}; } } },
  };
  const sandbox = {module:{exports:{}}, process:{env:{}}, console,
    require(name) { return name === 'wx-server-sdk' ? cloud : name === './core' ? core : require(name); }};
  vm.runInNewContext(fs.readFileSync(require.resolve('../cloudfunctions/photoAccess/index'), 'utf8'), sandbox);
  return { run: () => sandbox.module.exports.main(event), writes: () => writes };
}
test('new owner can register received photos before creating a member profile', async () => {
  const h = harness(); const result = await h.run();
  assert.equal(result.ok, true); assert.equal(h.writes(), 1);
});
for (const [label, overrides] of [
  ['missing family', {[`families/${familyId}`]: null}],
  ['another account owns family', {[`families/${familyId}`]: { ownerAccountId:'other', _openid:openid }}],
  ['another WeChat owns family', {[`families/${familyId}`]: { ownerAccountId:accountId, _openid:'other' }}],
  ['inactive account', {[`user_accounts/${accountId}`]: {accountId, wxOpenId:openid, status:'disabled', primaryFamilyId:familyId}}],
  ['forged account binding', {[`user_accounts/${accountId}`]: {accountId, wxOpenId:'other', status:'active', primaryFamilyId:familyId}}],
]) test(`profile-free photo registration rejects ${label}`, async () => {
  const h = harness(overrides); assert.equal((await h.run()).error.code, 'FORBIDDEN'); assert.equal(h.writes(), 0);
});
