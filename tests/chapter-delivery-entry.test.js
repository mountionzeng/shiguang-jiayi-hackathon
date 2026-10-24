const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const core = require('../cloudfunctions/drinkingTimeBridge/core');
const context = { APPID: 'wx0000000000000000', OPENID: 'test-openid' };
const secret = 's'.repeat(32);
const base = 'https://test.drinkingtime.top';
const id = '123e4567-e89b-42d3-a456-426614174000';
const assetId = 'asset-' + 'a'.repeat(32);
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBhoAAAAASUVORK5CYII=', 'base64');
const asset = { assetId, mime: 'image/png', bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
const pkg = { packageId: 'cp_abcdefgh1234', assets: [asset] };
async function harness(run) {
  const env = { CHAPTER_PACKAGE_ENABLED: 'true', CHAPTER_DELIVERY_ENABLED: 'true', DRINKING_TIME_BRIDGE_BASE_URL: base + '/api/shiguang', DRINKING_TIME_BRIDGE_SECRET: secret };
  const oldEnv = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  const original = Module._load;
  const entry = require.resolve('../cloudfunctions/drinkingTimeBridge/index');
  const calls = [];
  Module._load = function(name, ...rest) {
    if (name === 'wx-server-sdk') return {
      init() {}, getWXContext: () => context,
      database: () => ({ collection: table => ({ doc: () => ({ get: async () => ({ data: table === 'user_accounts' ? { primaryFamilyId: 'family_test' } : { _openid: context.OPENID, familyId: 'family_test', moderation: { suggest: 'pass' } } }) }) }) }),
      downloadFile: async () => ({ fileContent: bytes }),
      uploadFile: async () => ({ fileID: 'cloud://test/inbox/image.png' }),
    };
    if (name === 'node:https') return { request(url, options, callback) {
      const request = new EventEmitter(); let body = '';
      request.write = chunk => { body += chunk; };
      request.destroy = error => request.emit('error', error);
      request.end = chunk => {
        if (chunk) body += chunk;
        calls.push({ url, options, body });
        queueMicrotask(() => {
          const response = new EventEmitter(); response.headers = { 'content-type': 'application/json' }; response.statusCode = 200;
          response.resume = () => {}; response.destroy = () => {};
          let data;
          if (options.method === 'PUT') {
            // Same production Origin gate as the webpage media router.
            if (options.headers.origin !== base) response.statusCode = 403;
            data = { ok: response.statusCode === 200 };
          } else if (url.pathname.endsWith('/inbox')) data = { items: [] };
          else data = { deliveryId: id, repeated: false, uploadTickets: [{ ...asset, path: `/api/chapter-delivery/media/${pkg.packageId}/${assetId}`, token: 'A'.repeat(43), expiresAt: new Date(Date.now() + 600000).toISOString() }] };
          callback(response); response.emit('data', Buffer.from(JSON.stringify(data))); response.emit('end');
        });
      }; return request;
    } };
    return original.call(this, name, ...rest);
  };
  Object.assign(process.env, env);
  try { delete require.cache[entry]; await run(require(entry).main, calls); }
  finally {
    Module._load = original; delete require.cache[entry];
    for (const [key, value] of Object.entries(oldEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}
test('actual cloud entry dispatches chapter inbox with a trusted signed subject', () => harness(async (main, calls) => {
  assert.deepEqual(await main({ action: 'listChapterInbox' }), { items: [] });
  const call = calls[0], body = JSON.parse(call.body);
  assert.equal(body.subject, core.subjectFor(context.APPID, context.OPENID));
  assert.equal(call.options.headers['x-shiguang-signature'], core.signature(secret, '/chapter-delivery/inbox', call.options.headers['x-shiguang-timestamp'], call.options.headers['x-shiguang-nonce'], body));
  await assert.rejects(main({ action: 'unrecognizedAction' }), /UNKNOWN_BRIDGE_ACTION/);
}));
test('cloud runtime userInfo is ignored while signed identity remains context-only', () => harness(async (main, calls) => {
  assert.deepEqual(await main({ action: 'listChapterInbox', userInfo: { openId: 'untrusted-openid', appId: 'untrusted-appid' } }), { items: [] });
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(body, { subject: core.subjectFor(context.APPID, context.OPENID) });
  await assert.rejects(main({ action: 'listChapterInbox', userId: 7 }), /invalid_input/);
  await assert.rejects(main({ action: 'listChapterInbox', subject: 'forged' }), /invalid_input/);
}));
test('actual cloud entry stages and uploads image bytes through the production origin gate', () => harness(async (main, calls) => {
  const assetPhotos = { [assetId]: 'photo-test' };
  const staged = await main({ action: 'stageChapterAssets', package: pkg, assetPhotos, purpose: 'send' });
  const result = await main({ action: 'sendChapter', package: pkg, assetPhotos, assetFileIDs: { [assetId]: 'cloud://test/' + staged.uploads[assetId] }, recipientContactId: 'A'.repeat(43), requestId: id });
  assert.equal(result.deliveryId, id);
  const upload = calls.find(call => call.options.method === 'PUT');
  assert.ok(upload); assert.equal(upload.options.headers.origin, base);
}));
test('disabled delivery rejects before network access', () => harness(async (main, calls) => {
  process.env.CHAPTER_DELIVERY_ENABLED = 'false';
  await assert.rejects(main({ action: 'listChapterInbox' }), /chapter_delivery_disabled/);
  assert.equal(calls.length, 0);
}));
