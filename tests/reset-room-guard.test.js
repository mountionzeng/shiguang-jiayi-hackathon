const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

/*
 * resetCurrentUserRoom 会删数据库记录，并 cloud.deleteFile 真删云存储里的
 * 照片与配图文件——文件删了连官方回档都救不回（回档只回数据库）。
 * 2026-09 它在毫无护栏的情况下把线上唯一的真实房间清空过一次。
 * 这组测试盯死一件事：没有齐全的确认，就一个字节都不许删。
 */
function loadResetFunction({ openid = 'openid-1' } = {}) {
  const calls = { removed: [], deletedFiles: [], set: [] };
  const emptyQuery = {
    where: () => emptyQuery,
    limit: () => emptyQuery,
    skip: () => emptyQuery,
    orderBy: () => emptyQuery,
    field: () => emptyQuery,
    get: async () => ({ data: [] }),
    count: async () => ({ total: 0 }),
  };
  const collection = name => ({
    ...emptyQuery,
    doc: id => ({
      get: async () => ({ data: { _id: id } }),
      set: async value => { calls.set.push([name, id, value]); },
      remove: async () => { calls.removed.push([name, id]); },
      update: async () => {},
    }),
  });
  const stub = {
    init: () => {},
    DYNAMIC_CURRENT_ENV: 'dynamic',
    database: () => ({ collection, command: { in: value => value }, serverDate: () => 'now' }),
    getWXContext: () => ({ OPENID: openid, APPID: 'appid' }),
    deleteFile: async ({ fileList }) => { calls.deletedFiles.push(...fileList); return { fileList: [] }; },
  };

  const resolved = require.resolve('../cloudfunctions/resetCurrentUserRoom/index.js');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'wx-server-sdk') return stub;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return { main: require(resolved).main, calls };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

// 函数在「调用时」读 process.env，所以环境变量必须罩住 main() 那一刻，而不是加载那一刻。
async function withEnv(env, run) {
  const original = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const key of Object.keys(env)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

function assertNothingDestroyed(calls) {
  assert.deepEqual(calls.removed, [], '不得删除任何文档');
  assert.deepEqual(calls.deletedFiles, [], '不得删除任何云存储文件');
  assert.deepEqual(calls.set, [], '不得写回空房间');
}

test('不带确认口令时只做预演，一个字节都不删', async () => {
  const { main, calls } = loadResetFunction();
  const result = await withEnv({ ALLOW_ROOM_RESET: 'yes' }, () => main({}));
  assert.equal(result.dryRun, true, '默认必须是预演');
  assertNothingDestroyed(calls);
});

test('口令对但没指名道姓写出 familyId，仍然只是预演', async () => {
  const { main, calls } = loadResetFunction();
  const result = await withEnv({ ALLOW_ROOM_RESET: 'yes' }, () => main({ confirm: 'RESET_MY_ROOM' }));
  assert.equal(result.dryRun, true);
  assertNothingDestroyed(calls);
});

test('口令与 familyId 都对，但环境开关没打开时拒绝执行', async () => {
  const { main, calls } = loadResetFunction();
  const { familyId } = await main({});
  await withEnv({ ALLOW_ROOM_RESET: '' }, () => assert.rejects(
    () => main({ confirm: 'RESET_MY_ROOM', confirmFamilyId: familyId }),
    error => error.code === 'ROOM_RESET_DISABLED',
  ));
  assertNothingDestroyed(calls);
});

test('房间在保护名单里时，连开关打开也拒绝', async () => {
  const { main, calls } = loadResetFunction();
  const { familyId } = await main({});
  await withEnv({ ALLOW_ROOM_RESET: 'yes', PROTECTED_FAMILY_IDS: familyId }, () => assert.rejects(
    () => main({ confirm: 'RESET_MY_ROOM', confirmFamilyId: familyId }),
    error => error.code === 'ROOM_PROTECTED',
  ));
  assertNothingDestroyed(calls);
});

test('三件事齐全时才真正执行，证明测试本身没有空转', async () => {
  const { main, calls } = loadResetFunction();
  const { familyId } = await main({});
  const result = await withEnv({ ALLOW_ROOM_RESET: 'yes' },
    () => main({ confirm: 'RESET_MY_ROOM', confirmFamilyId: familyId }));
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, undefined, '齐全时不应再是预演');
  assert.ok(calls.removed.length > 0, '齐全时确实会删除文档——说明前几条测试拦下的是真刀');
});
