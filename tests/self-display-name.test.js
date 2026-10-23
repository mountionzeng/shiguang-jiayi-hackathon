const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { fixture } = require('./helpers/story-access-fixture');
const { resolveStoryIdentity } = require('../cloudfunctions/storyBooks/identity');
const { grantIdFor } = require('../cloudfunctions/storyBooks/access');
const { createStoryService } = require('../cloudfunctions/storyBooks/service');
const { createHandlers } = require('../cloudfunctions/storyBooks/flow');
const { receiveTextCopy, appendOwnExperience } = require('../cloudfunctions/storyBooks/copies');
const { sendOwnReturn, listReturns } = require('../cloudfunctions/storyBooks/returns');
const { ownNamesByAccount, ownNamesByPrincipal } = require('../cloudfunctions/storyBooks/displayNames');
const core = require('../cloudfunctions/storyBooks/core');
const account = require('../cloudfunctions/getOpenId/account');
const invite = require('../cloudfunctions/familyInvite/core');

const wrapGet = (repo, get) => ({ ...repo, get });
const failing = (repo, table) => wrapGet(repo, (name, id) => name === table ? Promise.reject(new Error('读取失败')) : repo.get(name, id));
const countingFamilies = (repo, counter) => wrapGet(repo, (name, id) => { if (name === 'families') counter.count += 1; return repo.get(name, id); });
const setName = (f, who, displayName) => f.tables.set(`user_accounts:${who.accountId}`, { ...f.tables.get(`user_accounts:${who.accountId}`), displayName });

/* ---------- 回信：A 发给 B，B 看到 A 本人起的称呼 ---------- */
async function returnSetup({ remark = '小岚的备注' } = {}) {
  const f = fixture();
  const ownerAccount = f.account('owner'), readerAccount = f.account('reader');
  const identity = who => resolveStoryIdentity(f.repo, { APPID: 'wx-original', OPENID: who }, { bootstrapAppId: 'wx-original' });
  const owner = await identity('owner'), reader = await identity('reader');
  const chapters = [{ id: 'chapter-three', title: '共同回忆', memoryIds: [], content: [{ text: '那年的夏天' }] }];
  f.tables.set('stories:family_owner_story-original', { id: 'story-original', familyId: 'family_owner', title: '原书', bookTitle: '原书', writingMode: 'objective', memoryIds: [], version: 3, currentRevisionId: 'revision-source' });
  f.tables.set('biography_drafts:family_owner_revision-source', { familyId: 'family_owner', storyId: 'story-original', revision: { id: 'revision-source', storyId: 'story-original', draft: { title: '原书', chapters, ...core.flatten(chapters), sourceCount: 0, generatedAt: '', generationMode: 'local-demo' } } });
  // 主人邀请时写的备注：接受邀请后记在 applicants[].displayName，回信署名原先读的就是它。
  f.tables.set('story_invitations:invite-1', { applicants: [{ principalId: reader.principalId, displayName: remark, status: 'approved' }] });
  f.tables.set('story_grants:' + grantIdFor('family_owner', 'story-original', reader.principalId), { familyId: 'family_owner', storyId: 'story-original', principalId: reader.principalId, ownerPrincipalId: owner.principalId, status: 'active', version: 1, invitationId: 'invite-1', scope: { type: 'chapters', chapterIds: ['chapter-three'] }, permissions: { read: true, copy: true, forward: false, publish: false } });
  await receiveTextCopy(f.repo, reader, { sourceFamilyId: 'family_owner', sourceStoryId: 'story-original', sourceRevisionId: 'revision-source', chapterIds: ['chapter-three'], requestId: 'receive-request-001', target: { mode: 'new', storyId: 'story-copy', title: '我的夏天' } });
  const read = () => {
    const story = f.tables.get('stories:family_reader_story-copy');
    return { story, chapterId: f.tables.get('biography_drafts:family_reader_' + story.currentRevisionId).revision.draft.chapters[0].id };
  };
  let { story, chapterId } = read();
  await appendOwnExperience(f.repo, reader, { storyId: story.id, revisionId: story.currentRevisionId, expectedVersion: story.version, chapterId, text: '我记得那把蓝伞', requestId: 'append-own-0001' });
  ({ story } = read());
  await sendOwnReturn(f.repo, reader, { storyId: story.id, revisionId: story.currentRevisionId, expectedVersion: story.version, chapterId, requestId: 'send-return-001' });
  return { ...f, owner, reader, ownerAccount, readerAccount };
}

test('A 改名后，B 的回信列表显示 A 的新称呼', async () => {
  const f = await returnSetup();
  assert.equal((await listReturns(f.repo, f.owner)).returns[0].senderName, '小岚的备注', '没改过称呼时显示备注名');
  setName(f, f.readerAccount, '小岚');
  assert.equal((await listReturns(f.repo, f.owner)).returns[0].senderName, '小岚');
  setName(f, f.readerAccount, '岚岚');
  assert.equal((await listReturns(f.repo, f.owner)).returns[0].senderName, '岚岚', '改名后旧回信也跟着变');
});

test('A 没起过本人称呼：显示备注名；备注也没有时显示「一位亲友」', async () => {
  const f = await returnSetup();
  setName(f, f.readerAccount, '   ');
  assert.equal((await listReturns(f.repo, f.owner)).returns[0].senderName, '小岚的备注');
  const bare = await returnSetup({ remark: '' });
  assert.equal((await listReturns(bare.repo, bare.owner)).returns[0].senderName, '一位亲友');
});

test('名字解析失败时回信列表照常返回，显示备注名', async () => {
  const f = await returnSetup();
  setName(f, f.readerAccount, '小岚');
  // story_principals 同时被身份校验读取，所以只在第二次 assertSpaceOwner 之后才让取名字的读取失败。
  for (const table of ['user_accounts', 'story_principals']) {
    let families = 0;
    const lateFailure = wrapGet(f.repo, (name, id) => {
      if (name === 'families') families += 1;
      return families >= 2 && name === table ? Promise.reject(new Error('读取失败')) : f.repo.get(name, id);
    });
    const result = await listReturns(lateFailure, f.owner);
    assert.equal(result.returns.length, 1, `${table} 读取失败时回信列表照常返回`);
    assert.equal(result.returns[0].senderName, '小岚的备注', `${table} 读取失败时显示备注名`);
  }
});

test('回信列表里 assertSpaceOwner 的次数不变：仍然是两次，名字解析发生在第二次之后', async () => {
  const f = await returnSetup();
  setName(f, f.readerAccount, '小岚');
  const counter = { count: 0 }, order = [];
  const repo = wrapGet(f.repo, (name, id) => {
    if (name === 'families') { counter.count += 1; order.push('families'); }
    if (name === 'user_accounts' && id === f.readerAccount.accountId) order.push('name');
    return f.repo.get(name, id);
  });
  await listReturns(repo, f.owner);
  assert.equal(counter.count, 2, 'assertSpaceOwner 读 families，列表里调用两次');
  assert.deepEqual(order, ['families', 'families', 'name']);
});

/* ---------- 改动历史 ---------- */
async function changesSetup() {
  const f = fixture();
  f.account('owner'); const friendAccount = f.account('friend');
  const service = createStoryService(f.repo, { accessEnabled: true, rulesReady: true, invitationsEnabled: true, sharedEditEnabled: true, copyReceiveEnabled: true, bootstrapAppId: 'wx-original', sharedReadFamilyIds: ['family_owner'], approveSharedEdit: async () => true });
  const call = (who, action, input = {}) => service({ APPID: 'wx-original', OPENID: who }, { action, ...input });
  await call('owner', 'create', { storyId: 'story-a', title: '外婆家的夏天', writingMode: 'objective', memoryIds: [], requestId: 'create-story-a' });
  f.tables.get('stories:family_owner_story-a').currentRevisionId = 'revision-a';
  const chapters = [{ id: 'chapter-three', title: '井水西瓜', memoryIds: [], content: [{ text: '井水里的西瓜很凉。' }] }];
  f.tables.set('biography_drafts:family_owner_revision-a', { familyId: 'family_owner', storyId: 'story-a', revision: { id: 'revision-a', storyId: 'story-a', savedAt: '2026-10-15T08:00:00.000Z', draft: { title: '外婆家的夏天', chapters, ...core.flatten(chapters), sourceCount: 0, generatedAt: '', generationMode: 'local-demo' } } });
  const inv = await call('owner', 'inviteCreate', { familyId: 'family_owner', storyId: 'story-a', chapterIds: ['chapter-three'], inviteeName: '小岚', permissions: { read: true, forward: false, edit: true, copy: false } });
  await call('friend', 'inviteAccept', { token: inv.token });
  const read = await call('friend', 'sharedRead', { familyId: 'family_owner', storyId: 'story-a' });
  await call('friend', 'sharedEdit', { familyId: 'family_owner', storyId: 'story-a', chapterId: 'chapter-three', revisionId: read.revisionId, expectedVersion: read.story.version, requestId: 'edit-flow-one', title: '井水西瓜', textBlocks: [{ index: 0, text: '井水里的西瓜很凉，很甜。' }] });
  const changes = repo => createStoryService(repo, { accessEnabled: true, rulesReady: true, invitationsEnabled: true, sharedEditEnabled: true, copyReceiveEnabled: true, bootstrapAppId: 'wx-original', sharedReadFamilyIds: ['family_owner'] })({ APPID: 'wx-original', OPENID: 'owner' }, { action: 'chapterChanges', familyId: 'family_owner', storyId: 'story-a', chapterId: 'chapter-three' });
  return { ...f, friendAccount, changes };
}

test('改动历史显示改动者本人的称呼；没起过时显示备注名；解析失败也照常返回', async () => {
  const f = await changesSetup();
  assert.equal((await f.changes(f.repo)).changes[0].by, '小岚');
  setName(f, f.friendAccount, '岚岚');
  const result = await f.changes(f.repo);
  assert.equal(result.changes[0].by, '岚岚');
  assert.equal(JSON.stringify(result).includes('editorPrincipalId'), false, '内部 id 不返回给客户端');
  assert.equal((await f.changes(failing(f.repo, 'user_accounts'))).changes[0].by, '小岚');
});

test('改动历史里 assertSpaceOwner 只在事务内调用一次，名字解析在事务之外', async () => {
  const f = await changesSetup();
  setName(f, f.friendAccount, '岚岚');
  const counter = { count: 0 };
  let inTransaction = false, nameReadInTransaction = false;
  const repo = {
    ...f.repo,
    transaction: fn => f.repo.transaction(io => {
      inTransaction = true;
      return Promise.resolve(fn(wrapGet(io, (name, id) => {
        if (name === 'families') counter.count += 1;
        if (name === 'user_accounts' && id === f.friendAccount.accountId) nameReadInTransaction = true;
        return io.get(name, id);
      }))).finally(() => { inTransaction = false; });
    }),
  };
  assert.equal((await f.changes(repo)).changes[0].by, '岚岚');
  assert.equal(counter.count, 1);
  assert.equal(nameReadInTransaction, false);
  assert.equal(inTransaction, false);
});

/* ---------- 旧版投稿：读房间时显示作者本人称呼 ---------- */
function roomFixture() {
  const f = fixture();
  f.account('owner', 'family_stable');
  const author = f.account('friend');
  f.tables.set('family_members:family_stable_owner', { familyId: 'family_stable', memberId: 'owner', id: 'owner', name: '岱', relation: '本人', role: 'owner', accountId: 'account_ownerowner' });
  f.tables.set('family_members:family_stable_wx_a', { familyId: 'family_stable', memberId: 'wx_a', id: 'wx_a', name: '备注小岚', relation: '朋友', role: 'contributor', accountId: author.accountId });
  f.tables.set('memories:family_stable_m1', { familyId: 'family_stable', frontendContributionId: 'm1', authorMemberId: 'wx_a', authorName: '写入时的名字', text: '一起回家', scope: 'family' });
  f.tables.set('memories:family_stable_m2', { familyId: 'family_stable', frontendContributionId: 'm2', authorMemberId: 'owner', authorName: '岱', text: '我的记忆', scope: 'family' });
  return { ...f, author };
}
const authorsOf = async repo => Object.fromEntries((await createHandlers(repo).state({ familyId: 'family_stable' })).contributions.map(item => [item.id, item.authorName]));

test('读房间：投稿作者显示本人称呼，没起过时显示备注名，主人自己跳过', async () => {
  const f = roomFixture();
  assert.deepEqual(await authorsOf(f.repo), { m1: '备注小岚', m2: '岱' });
  setName(f, f.author, '小岚');
  // 主人账号即使有不同称呼，主人自己的投稿仍显示主人成员名。
  f.tables.set('user_accounts:account_ownerowner', { displayName: '不应出现' });
  assert.deepEqual(await authorsOf(f.repo), { m1: '小岚', m2: '岱' });
  const response = await createHandlers(f.repo).state({ familyId: 'family_stable' });
  assert.equal(JSON.stringify(response).includes(f.author.accountId), false, 'accountId 不进入响应');
});

test('读房间：名字解析失败时房间照常加载，显示备注名；多位作者的名字只做一轮并行读取', async () => {
  const f = roomFixture();
  setName(f, f.author, '小岚');
  assert.deepEqual(await authorsOf(failing(f.repo, 'user_accounts')), { m1: '备注小岚', m2: '岱' });
  const reads = [];
  let release; const gate = new Promise(resolve => { release = resolve; });
  const slow = wrapGet(f.repo, async (name, id) => { if (name === 'user_accounts' && id.startsWith('account_')) { reads.push(id); await gate; } return f.repo.get(name, id); });
  const pending = authorsOf(slow);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(reads, [f.author.accountId]);
  release();
  assert.equal((await pending).m1, '小岚');
});

test('旧版 familyInvite 房间读取：同样的署名顺序，且读失败不影响加载', async () => {
  const names = await invite.loadOwnNames(async id => id === 'account_a' ? { displayName: ' 小岚 ', secret: 'x' } : id === 'account_boom' ? Promise.reject(new Error('x')) : { displayName: '   ' }, ['account_a', 'account_a', 'account_boom', 'account_blank', '../bad', 7]);
  assert.deepEqual([...names], [['account_a', '小岚']]);
  const memory = { authorName: '写入时', relation: '朋友' }, member = { name: '备注', relation: '朋友' };
  assert.equal(invite.currentMemoryAttribution(memory, member, '本人').authorName, '本人');
  assert.equal(invite.currentMemoryAttribution(memory, member).authorName, '备注');
  assert.equal(invite.currentMemoryAttribution(memory).authorName, '写入时');
});

test('名字批量解析：超过 20 个也一次并行发出，坏 id 与失败项被忽略', async () => {
  let started = 0, release; const gate = new Promise(resolve => { release = resolve; });
  const accountIds = Array.from({ length: 45 }, (_, index) => `account_${index}`);
  const reader = { get: async (table, id) => { started += 1; await gate; return id === 'account_3' ? Promise.reject(new Error('x')) : { displayName: `名${id.slice(8)}` }; } };
  const pending = ownNamesByAccount(reader, [...accountIds, 'bad id', 'account_0']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 45, '没有串行轮次');
  release();
  const names = await pending;
  assert.equal(names.size, 44);
  assert.equal(names.get('account_44'), '名44');
  assert.equal(names.has('account_3'), false);
  const principals = Array.from({ length: 25 }, (_, index) => `principal_${index.toString(16).padStart(32, '0')}`);
  const byPrincipal = await ownNamesByPrincipal({ get: async (table, id) => table === 'story_principals' ? { accountId: `account_${id.slice(-2)}` } : { displayName: `称呼${id.slice(-2)}` } }, principals);
  assert.equal(byPrincipal.size, 25);
  assert.equal(byPrincipal.get(principals[24]), '称呼18');
});

/* ---------- getOpenId：只改自己的主家，称呼过内容安全 ---------- */
function accountDb(seed = {}) {
  const store = new Map(Object.entries(seed)), calls = { where: 0, updates: [] };
  const key = (name, id) => `${name}/${id}`;
  const missing = () => Object.assign(new Error('document.get:fail document does not exist'), { errMsg: 'document.get:fail document does not exist' });
  return {
    store, calls, serverDate: () => 'now', createCollection: async () => {},
    collection: name => ({
      doc: id => ({
        get: async () => { const data = store.get(key(name, id)); if (!data) throw missing(); return { data: structuredClone(data) }; },
        set: async ({ data }) => { store.set(key(name, id), { ...data }); },
        update: async ({ data }) => { if (!store.has(key(name, id))) throw missing(); calls.updates.push(key(name, id)); store.set(key(name, id), { ...store.get(key(name, id)), ...data }); },
      }),
      where: () => { calls.where += 1; return { limit: () => ({ get: async () => ({ data: [] }) }) }; },
    }),
  };
}
const OPENID = 'openid-a', ACCOUNT_ID = account.accountIdFor(OPENID), FAMILY_ID = account.familyIdFor(OPENID);
const profileDb = () => accountDb({
  [`user_accounts/${ACCOUNT_ID}`]: { accountId: ACCOUNT_ID, wxOpenId: OPENID, primaryFamilyId: FAMILY_ID, displayName: '旧称呼', avatarText: '旧', computeBalanceMicros: 5 },
  [`family_members/${FAMILY_ID}_owner`]: { name: '旧称呼', role: 'owner' },
  'family_members/family_b_wx_a': { familyId: 'family_b', accountId: ACCOUNT_ID, name: 'B 起的备注', relation: '朋友' },
});

test('A 改名后，B 家里 A 的成员备注不变，只改自己的主家成员', async () => {
  const db = profileDb();
  const result = await account.updateCurrentProfile(db, { OPENID }, '小岚', async () => 'pass');
  assert.equal(result.displayName, '小岚');
  assert.equal(db.store.get('family_members/family_b_wx_a').name, 'B 起的备注');
  assert.equal(db.store.get(`family_members/${FAMILY_ID}_owner`).name, '小岚');
  assert.equal(db.store.get(`user_accounts/${ACCOUNT_ID}`).displayName, '小岚');
  assert.equal(db.calls.where, 0, '不再按 accountId 扫描别人家的成员');
  assert.deepEqual(db.calls.updates.filter(item => item.startsWith('family_members/')), [`family_members/${FAMILY_ID}_owner`]);
});

test('内容安全拒绝时不保存', async () => {
  const db = profileDb();
  await assert.rejects(account.updateCurrentProfile(db, { OPENID }, '违规词', async () => 'reject'), { code: account.PROFILE_NAME_REJECTED, message: '这个称呼暂时不能使用' });
  assert.equal(db.store.get(`user_accounts/${ACCOUNT_ID}`).displayName, '旧称呼');
  assert.equal(db.store.get(`family_members/${FAMILY_ID}_owner`).name, '旧称呼');
});

test('内容安全服务不可用时不保存，不放行', async () => {
  for (const check of [async () => { throw new Error('网络错误'); }, async () => undefined, async () => 'maybe', undefined]) {
    const db = profileDb();
    await assert.rejects(account.updateCurrentProfile(db, { OPENID }, '小岚', check), { code: account.PROFILE_CHECK_UNAVAILABLE, message: /稍后再试/ });
    assert.equal(db.store.get(`user_accounts/${ACCOUNT_ID}`).displayName, '旧称呼');
    assert.equal(db.store.get(`family_members/${FAMILY_ID}_owner`).name, '旧称呼');
  }
});

test('msgSecCheck 封装：scene 1、version 2、用当前用户 openid；非 pass 或异常都不放行', async () => {
  const sent = [];
  const security = suggest => ({ msgSecCheck: async options => { sent.push(options); return suggest === 'throw' ? Promise.reject(new Error('超时')) : suggest === 'none' ? {} : { result: { suggest } }; } });
  assert.equal(await account.checkDisplayNameWith(security('pass'), '小岚', OPENID), 'pass');
  assert.deepEqual(sent[0], { content: '小岚', version: 2, scene: 1, openid: OPENID });
  assert.equal(await account.checkDisplayNameWith(security('risky'), 'x', OPENID), 'reject');
  assert.equal(await account.checkDisplayNameWith(security('review'), 'x', OPENID), 'reject');
  const rejected = { msgSecCheck: async () => { throw Object.assign(new Error('risky'), { errCode: 87014 }); } };
  assert.equal(await account.checkDisplayNameWith(rejected, 'x', OPENID), 'reject');
  await assert.rejects(account.checkDisplayNameWith(security('throw'), 'x', OPENID), /超时/);
  await assert.rejects(account.checkDisplayNameWith(security('none'), 'x', OPENID), /NO_RESULT/);
});

function loadGetOpenId({ db, suggest = 'pass', securityThrows = false }) {
  const stub = {
    init: () => {}, DYNAMIC_CURRENT_ENV: 'dynamic', database: () => db,
    openapi: { security: { msgSecCheck: async () => { if (securityThrows) throw new Error('服务不可用'); return { result: { suggest } }; } } },
    getWXContext: () => ({ OPENID, APPID: 'appid' }),
  };
  const resolved = require.resolve('../cloudfunctions/getOpenId/index.js');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) { return request === 'wx-server-sdk' ? stub : originalLoad.call(this, request, ...rest); };
  try { return require(resolved).main; } finally { Module._load = originalLoad; delete require.cache[resolved]; }
}

test('getOpenId：改名被拒绝或检查不可用时结构化返回原因；登录失败仍吞掉错误', async () => {
  const quiet = console.warn, quietError = console.error; console.warn = () => {}; console.error = () => {};
  try {
    const rejectedDb = profileDb();
    const rejected = await loadGetOpenId({ db: rejectedDb, suggest: 'risky' })({ action: 'updateProfile', displayName: '违规词' });
    assert.equal(rejected.accountLinked, false);
    assert.deepEqual(rejected.profileError, { code: account.PROFILE_NAME_REJECTED, message: '这个称呼暂时不能使用' });
    assert.equal(rejectedDb.store.get(`user_accounts/${ACCOUNT_ID}`).displayName, '旧称呼');
    const unavailableDb = profileDb();
    const unavailable = await loadGetOpenId({ db: unavailableDb, securityThrows: true })({ action: 'updateProfile', displayName: '小岚' });
    assert.equal(unavailable.profileError.code, account.PROFILE_CHECK_UNAVAILABLE);
    assert.equal(unavailableDb.store.get(`user_accounts/${ACCOUNT_ID}`).displayName, '旧称呼');
    const saved = await loadGetOpenId({ db: profileDb() })({ action: 'updateProfile', displayName: '小岚' });
    assert.equal(saved.accountLinked, true);
    assert.equal(saved.profileError, undefined);
    assert.equal(saved.account.displayName, '小岚');
    // 其他失败（空称呼、登录关联失败）保持原行为：accountLinked=false，没有 profileError。
    const empty = await loadGetOpenId({ db: profileDb() })({ action: 'updateProfile', displayName: '  ' });
    assert.equal(empty.accountLinked, false);
    assert.equal(empty.profileError, undefined);
    const brokenDb = profileDb();
    brokenDb.createCollection = async () => { throw new Error('数据库不可用'); };
    const login = await loadGetOpenId({ db: brokenDb })({ action: 'get' });
    assert.equal(login.accountLinked, false);
    assert.equal(login.profileError, undefined);
    assert.equal(login.account.accountId, ACCOUNT_ID);
  } finally { console.warn = quiet; console.error = quietError; }
});

test('getOpenId 声明了 msgSecCheck 权限', () => {
  assert.deepEqual(require('../cloudfunctions/getOpenId/config.json'), { permissions: { openapi: ['security.msgSecCheck'] } });
});
