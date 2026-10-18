import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSendSnapshot, snapshotFromState, selectSendText, SendSelection, stageSendSnapshot, takeStagedSendSnapshot } from '../miniprogram/services/bookSend';
import { createDemoRoomStateForTests } from './fixtures';
import { makeRevision } from '../miniprogram/services/manuscript';
import { draftWithChapters } from '../miniprogram/services/chapters';
import { createContribution, memoryAiRevisions } from '../miniprogram/domain/biography';

function fixture() {
  const state = createDemoRoomStateForTests();
  const draft = draftWithChapters({ title: '全书', paragraphs: [], sourceCount: 0, generatedAt: '', generationMode: 'local-demo' }, [
    { id: 'chapter-one', title: '第一段日子', memoryIds: [], content: [{ text: '原文🌿\n\n下一段' }, { photoId: 'photo-private' }, { text: '图片后面的字' }] },
    { id: 'chapter-two', title: '第二段日子', memoryIds: [], content: [{ text: '第二章全文，不可丢失。' }] },
  ]);
  const revision = { ...makeRevision('owner', draft, '', 'draft', '已保存'), storyId: 'story-test' };
  state.manuscriptRevisions = [revision];
  state.stories = [{ id: 'story-test', familyId: 'family-test', title: '全书', currentRevisionId: revision.id, version: 3,
    protagonistMemberIds: [], memoryIds: [], createdAt: '', updatedAt: '' }];
  return { state, expected: { storyId: 'story-test', revisionId: revision.id, version: 3 } };
}
const selection: SendSelection = { scope: 'book', chapterIds: [], textChapterId: '', text: '' };

test('发送只读当前版本，历史版本不阻塞正文，读取前后仍核对账号', async () => {
  const { state, expected } = fixture();
  const previousWx = (globalThis as any).wx;
  const previousApp = (globalThis as any).getApp;
  const reads: any[] = [];
  let account = 'owner';
  let switchDuringRead = false;
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: true } });
  (globalThis as any).wx = { cloud: { callFunction: async ({ name, data }: any) => {
    if (name === 'getOpenId') return { result: { openid: account } };
    reads.push(data);
    assert.equal(data.view, 'home', '发送正文不得下载全部历史版本');
    if (switchDuringRead) account = 'other-owner';
    return { result: { ...state, roomStateVersion: 1, personalDrafts: {}, personalDraftSourceFingerprints: {}, deletedStories: [] } };
  } } };
  try {
    const snapshot = await loadSendSnapshot(expected);
    assert.equal(snapshot.chapters[1].text, '第二章全文，不可丢失。');
    assert.equal(reads.length, 1);
    switchDuringRead = true;
    await assert.rejects(loadSendSnapshot(expected), /账号已切换/);
  } finally {
    (globalThis as any).wx = previousWx;
    (globalThis as any).getApp = previousApp;
  }
});

test('整书预览保留完整正文和空行，不自动加入私密照片', () => {
  const { state, expected } = fixture();
  const snapshot = snapshotFromState(state, expected, 'account-a');
  const result = selectSendText(snapshot, selection);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, '原文🌿\n\n下一段\n图片后面的字');
  assert.equal(result[1].text, '第二章全文，不可丢失。');
  assert.equal(JSON.stringify(result).includes('photo-private'), false);
  result[0].text = '修改预览对象';
  assert.match(snapshot.chapters[0].text, /^原文/);
  assert.match(state.manuscriptRevisions![0].draft.chapters![0].content[0].text!, /^原文/);
});

test('章节多选保留书稿顺序，重复ID不重复正文，未知章节不能静默丢弃', () => {
  const { state, expected } = fixture(), snapshot = snapshotFromState(state, expected, 'a');
  assert.deepEqual(selectSendText(snapshot, { ...selection, scope: 'chapters', chapterIds: ['chapter-two', 'chapter-one', 'chapter-two'] }).map(c => c.id), ['chapter-one', 'chapter-two']);
  assert.throws(() => selectSendText(snapshot, { ...selection, scope: 'chapters', chapterIds: ['missing'] }), /重新选择/);
});

test('直接选段必须属于当前保存原文，不接受改写文本或其他章节文字', () => {
  const { state, expected } = fixture(), snapshot = snapshotFromState(state, expected, 'a');
  const input = { ...selection, scope: 'text' as const, textChapterId: 'chapter-one', text: '🌿\n\n下一段' };
  assert.equal(selectSendText(snapshot, input)[0].text, input.text);
  assert.equal(selectSendText(snapshot, input)[0].characterCount, Array.from(input.text).length);
  assert.throws(() => selectSendText(snapshot, { ...input, text: '伪造正文' }), /原文/);
  assert.throws(() => selectSendText(snapshot, { ...input, textChapterId: 'chapter-two' }), /原文/);
});

test('版本更新、删除和受保护副本不能进入发送快照', () => {
  const { state, expected } = fixture();
  assert.throws(() => snapshotFromState(state, { ...expected, version: 2 }, 'a'), /更新/);
  assert.throws(() => snapshotFromState(state, { ...expected, revisionId: 'old' }, 'a'), /更新/);
  state.stories![0].sourcePolicyRequired = true;
  assert.throws(() => snapshotFromState(state, expected, 'a'), /副本/);
  state.stories![0].sourcePolicyRequired = false; state.stories![0].deletedAt = 'today';
  assert.throws(() => snapshotFromState(state, expected, 'a'), /无法读取/);
});

test('刚看过的发送文字只交接一次，账号、版本或时效不符即丢弃', () => {
  const { state, expected } = fixture();
  const snapshot = snapshotFromState(state, expected, 'account-a');
  stageSendSnapshot(snapshot, 1000);
  assert.deepEqual(takeStagedSendSnapshot(expected, 'account-a', 1001), snapshot);
  assert.equal(takeStagedSendSnapshot(expected, 'account-a', 1002), undefined);
  for (const [version, scope, now] of [[expected, 'other', 1001], [{ ...expected, version: 4 }, 'account-a', 1001], [expected, 'account-a', 31001]] as const) {
    stageSendSnapshot(snapshot, 1000);
    assert.equal(takeStagedSendSnapshot(version, scope, now), undefined);
    assert.equal(takeStagedSendSnapshot(expected, 'account-a', 1002), undefined);
  }
});

type PageDefinition = Record<string, any>;
let book: PageDefinition;
async function bookPage() {
  if (!book) {
    (globalThis as any).Page = (value: PageDefinition) => { book = value; };
    await import('../miniprogram/pages/book/book');
  }
  const page: PageDefinition = { ...book, data: structuredClone(book.data), story: { id: 'story-test', version: 3 } };
  page.setData = (patch: PageDefinition) => Object.assign(page.data, patch);
  Object.assign(page.data, { view: 'contents', draft: {}, savedRevisionId: 'revision-before' });
  return page;
}
const sendEvent = (destination = 'social') => ({ currentTarget: { dataset: { destination } } });

test('发送等保存完成后用新版本跳转，重复点击只开一次', async () => {
  const page = await bookPage();
  let saved!: (success: boolean) => void;
  page.finishEditing = () => new Promise<boolean>(resolve => { saved = resolve; });
  const urls: string[] = [];
  (globalThis as any).wx = { navigateTo: ({ url, success }: any) => { urls.push(url); success(); } };
  const first = page.chooseSend(sendEvent());
  await page.chooseSend(sendEvent());
  assert.equal(urls.length, 0);
  page.data.savedRevisionId = 'revision-after'; page.story.version = 4;
  saved(true); await first;
  assert.equal(urls.length, 1);
  assert.match(urls[0], /social\/index\?storyId=story-test&revisionId=revision-after&version=4$/);
  assert.equal(page.data.preparingSend, false);
});

test('保存失败保留编辑页与正文，不启动任何发送', async () => {
  const page = await bookPage(); let calls = 0;
  page.bodyBuffer = '尚未保存的完整正文'; page.data.editing = true;
  page.finishEditing = async () => false;
  (globalThis as any).wx = { navigateTo: () => { calls++; } };
  await page.chooseSend(sendEvent('family'));
  assert.equal(calls, 0); assert.equal(page.bodyBuffer, '尚未保存的完整正文'); assert.equal(page.data.editing, true);
});

test('发送给家人等待保存后打开图文预览，亲友权限仍有独立入口', async () => {
  const page = await bookPage();
  let saved!: (success: boolean) => void;
  page.finishEditing = () => new Promise<boolean>(resolve => { saved = resolve; });
  const urls: string[] = [];
  (globalThis as any).wx = { navigateTo: ({ url, success }: any) => { urls.push(url); success?.(); } };
  const pending = page.chooseSend(sendEvent('family'));
  await page.chooseSend(sendEvent('family'));
  assert.deepEqual(urls, []);
  page.data.savedRevisionId = 'revision-after'; page.story.version = 4;
  saved(true); await pending;
  assert.deepEqual(urls, ['/packages/story-sharing/pages/social/index?storyId=story-test&revisionId=revision-after&version=4&destination=family']);
  assert.equal(page.data.preparingSend, false);
  page.canLeaveEditor = () => true;
  page.data.storyId = 'story-test';
  page.selectTool({ currentTarget: { dataset: { action: 'invite' } } });
  assert.equal(urls[1], '/packages/story-sharing/pages/invite/index?storyId=story-test');
});

test('离页或切章后到达的保存回执不再跳转', async () => {
  const page = await bookPage(); let saved!: (value: boolean) => void, calls = 0;
  page.finishEditing = () => new Promise(resolve => { saved = resolve; });
  (globalThis as any).wx = { navigateTo: () => { calls++; } };
  const task = page.chooseSend(sendEvent()); page.onHide(); saved(true); await task;
  assert.equal(calls, 0);
  const task2 = page.chooseSend(sendEvent()); page.data.view = 'chapter'; saved(true); await task2;
  assert.equal(calls, 0);
});

test('受保护副本即使直接调用handler也不能发送', async () => {
  const page = await bookPage(); let calls = 0;
  page.data.protectedCopy = true; page.finishEditing = async () => { calls++; return true; };
  await page.chooseSend(sendEvent()); assert.equal(calls, 0);
});

let social: PageDefinition;
async function socialPage() {
  if (!social) {
    (globalThis as any).Page = (value: PageDefinition) => { social = value; };
    await import('../miniprogram/packages/story-sharing/pages/social/index');
  }
  const page: PageDefinition = { ...social, data: structuredClone(social.data), hidden: false };
  page.setData = (patch: PageDefinition) => Object.assign(page.data, patch);
  const { state, expected } = fixture();
  page.expected = expected; page.snapshot = snapshotFromState(state, expected, 'a');
  page.data.chapters = page.snapshot.chapters.map((c: any) => ({ ...c, checked: false }));
  return page;
}

test('分享先显示刚看过的文字，云端核对期间不能发送，核对失败清空文字', async () => {
  const page = await socialPage();
  const previousWx = (globalThis as any).wx;
  const previousApp = (globalThis as any).getApp;
  let rejectIdentity!: (error: Error) => void;
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: true } });
  (globalThis as any).wx = { cloud: { callFunction: async () => ({ result: { openid: 'owner' } }) } };
  const { cachedAccountScope, currentFamilyId } = await import('../miniprogram/services/cloudRoomStorage');
  await currentFamilyId();
  (globalThis as any).wx.cloud.callFunction = () => new Promise((_resolve, reject) => { rejectIdentity = reject; });
  const staged = { ...page.snapshot, accountScope: cachedAccountScope()! };
  stageSendSnapshot(staged);
  try {
    const pending = page.refresh();
    assert.equal(page.data.title, staged.title);
    assert.equal(page.data.chapters[1].text, '第二章全文，不可丢失。');
    assert.equal(page.data.loading, true);
    assert.equal(page.snapshot, undefined, 'display handoff is not a verified export snapshot');
    assert.equal(page.data.exportAvailable, false);
    await page.previewSelection();
    assert.equal(page.data.preview, false);
    rejectIdentity(new Error('身份核对失败'));
    await pending;
    assert.equal(page.data.title, '');
    assert.deepEqual(page.data.chapters, []);
    assert.equal(page.data.loading, false);
    assert.match(page.data.notice, /身份核对失败/);
  } finally {
    (globalThis as any).wx = previousWx;
    (globalThis as any).getApp = previousApp;
  }
});

test('家人图文预览保留来源版本，普通社交与记忆入口沿用默认目的地', async () => {
  (globalThis as any).wx = { hideShareMenu() {} };
  const family = await socialPage();
  family.onLoad({ storyId: 'story-test', revisionId: 'revision-after', version: '4', destination: 'family' });
  assert.equal(family.data.destination, 'family');
  assert.deepEqual(family.expected, { storyId: 'story-test', revisionId: 'revision-after', version: 4 });
  const other = await socialPage();
  other.onLoad({ memoryId: 'memory-one' });
  assert.equal(other.data.destination, 'social');
  assert.deepEqual(other.expectedMemory, { memoryId: 'memory-one' });
});

async function familyCardPage() {
  const page = await socialPage();
  Object.assign(page.data, { destination: 'family', preview: true, scope: 'chapters', familyInviteAvailable: true,
    inviteeName: '小岚', imagePaths: ['rendered-cover'], familyCardImageUrl: 'https://approved-cover' });
  page.data.chapters[1].checked = true;
  page.exportSelection = { storyId: 'story-test' }; page.descriptor = { id: 'export-one', chapters: [page.snapshot.chapters[1]] };
  page.verifySnapshot = async () => {};
  return page;
}

test('支持新版服务时邀请只调用一次服务器，失败不降级重建，离页不留下可分享卡片',async()=>{
  const {storySharing}=await import('../miniprogram/services/storySharing');
  const original=storySharing.prepare;
  try {
    for (const mode of ['ok','error','hide']) {
      const page=await familyCardPage();page.preparedInvitationAvailable=true;
      page.verifySnapshot=async()=>{throw new Error('新版不应再次下载完整快照');};
      let calls=0;
      storySharing.prepare=async(selection,id,scope,name)=>{
        calls++;
        assert.equal(selection,page.exportSelection);assert.equal(id,page.descriptor.id);
        assert.equal(scope,page.snapshot.accountScope);assert.equal(name,'小岚');
        if(mode==='error')throw new Error('未确认');
        if(mode==='hide'){page.hidden=true;page.epoch++;}
        return {token:'token',invitationId:'id',descriptorId:id,imageUrl:'https://approved-cover'};
      };
      await page.prepareFamilyInvitation();
      assert.equal(calls,1);
      assert.equal(page.data.familyShareReady,mode==='ok');
      if(mode==='ok')assert.match(page.familyShare.path,/token=token/);
      if(mode==='error')assert.match(page.data.familyInviteNotice,/避免重复生成/);
    }
  } finally {storySharing.prepare=original;}
});

test('图文卡片只邀请已选章节，允许自己的副本与回信，不授予改原稿权限', async () => {
  const page = await familyCardPage();
  const { storySharing, sharingHome } = await import('../miniprogram/services/storySharing');
  const { bookExportApi } = await import('../miniprogram/services/bookExport');
  const originals = { capabilities: storySharing.capabilities, create: storySharing.create, material: bookExportApi.material };
  const calls: unknown[][] = [];
  storySharing.capabilities = async () => ({ invitations: true, copy: true, sharedEdit: false, familyId: 'family-owner' });
  storySharing.create = async (...args: any[]) => { calls.push(args); return { token: 'a'.repeat(48), invitationId: 'invite-one' }; };
  bookExportApi.material = async () => ({ descriptor: page.descriptor, coverUrl: 'https://approved-cover-refreshed' });
  try {
    assert.deepEqual(page.onShareAppMessage(), sharingHome);
    await page.prepareFamilyInvitation();
    assert.deepEqual(calls, [['family-owner', 'story-test', ['chapter-two'], false, false, true, '小岚']]);
    assert.deepEqual(page.onShareAppMessage(), { title: '全书', imageUrl: 'https://approved-cover-refreshed',
      path: '/packages/story-sharing/pages/invite/index?token=' + 'a'.repeat(48) });
    await page.prepareFamilyInvitation();
    assert.equal(calls.length, 1, '已准备好的邀请不重复创建');
    page.enterInviteeName({ detail: { value: '另一位朋友' } });
    assert.equal(page.data.familyShareReady, false);
    assert.deepEqual(page.onShareAppMessage(), sharingHome);
  } finally { Object.assign(storySharing, { capabilities: originals.capabilities, create: originals.create }); bookExportApi.material = originals.material; }
});

test('邀请核对与素材并行，但全部通过且末次账号版本核对完成才创建', async () => {
  const page = await familyCardPage();
  const { storySharing } = await import('../miniprogram/services/storySharing');
  const { bookExportApi } = await import('../miniprogram/services/bookExport');
  const originals = { capabilities: storySharing.capabilities, create: storySharing.create, material: bookExportApi.material };
  let releaseFirst!: () => void, releaseLast!: () => void, releaseMaterial!: (value: any) => void, releaseCaps!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const last = new Promise<void>(resolve => { releaseLast = resolve; });
  const material = new Promise<any>(resolve => { releaseMaterial = resolve; });
  const capsReady = new Promise<void>(resolve => { releaseCaps = resolve; });
  const events: string[] = [];
  let verifies = 0;
  page.verifySnapshot = () => { events.push('verify-' + ++verifies); return verifies === 1 ? first : last; };
  storySharing.capabilities = async () => { events.push('caps'); await capsReady; return { invitations: true, copy: true, sharedEdit: false, familyId: 'family-owner' }; };
  bookExportApi.material = () => { events.push('material'); return material; };
  storySharing.create = async () => { events.push('create'); return { token: 'a'.repeat(48), invitationId: 'invite-one' }; };
  const pending = page.prepareFamilyInvitation();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...events], ['verify-1', 'caps', 'material'], '身份版本读取期间应同时准备已授权素材');
    releaseMaterial({ descriptor: page.descriptor, coverUrl: 'https://approved-cover' });
    releaseFirst();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(verifies, 1); assert.equal(events.includes('create'), false);
    releaseCaps();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(verifies, 2); assert.equal(events.includes('create'), false);
    releaseLast(); await pending;
    assert.equal(events.filter(event => event === 'create').length, 1);
    assert.equal(page.data.familyShareReady, true);
  } finally {
    releaseFirst(); releaseLast(); releaseCaps(); releaseMaterial({ descriptor: page.descriptor, coverUrl: '' }); await pending;
    Object.assign(storySharing, { capabilities: originals.capabilities, create: originals.create }); bookExportApi.material = originals.material;
  }
});

test('邀请并行检查失败仍等待另一支收尾，防止重试与晚到的校验相互覆盖', async () => {
  const page = await familyCardPage();
  const { storySharing } = await import('../miniprogram/services/storySharing');
  const { bookExportApi } = await import('../miniprogram/services/bookExport');
  const originals = { capabilities: storySharing.capabilities, create: storySharing.create, material: bookExportApi.material };
  let release!: () => void, verifies = 0, materials = 0, created = 0;
  const verification = new Promise<void>(resolve => { release = resolve; });
  page.verifySnapshot = () => { verifies++; return verification; };
  storySharing.capabilities = async () => ({ invitations: true, copy: true, sharedEdit: false, familyId: 'family-owner' });
  bookExportApi.material = async () => { materials++; throw new Error('素材审核未通过'); };
  storySharing.create = async () => { created++; throw new Error('must not create'); };
  const pending = page.prepareFamilyInvitation();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(materials, 1); assert.equal(page.data.invitationBusy, true);
    await page.prepareFamilyInvitation();
    assert.equal(verifies, 1); assert.equal(materials, 1);
    release(); await pending;
    assert.equal(created, 0); assert.equal(page.data.familyShareReady, false);
    assert.equal(page.data.invitationBusy, false);
    assert.match(page.data.familyInviteNotice, /素材审核未通过/);
  } finally {
    release(); await pending;
    Object.assign(storySharing, { capabilities: originals.capabilities, create: originals.create }); bookExportApi.material = originals.material;
  }
});

test('邀请初次或末次版本核对失败、校验中离页，均不创建邀请', async () => {
  const { storySharing, sharingHome } = await import('../miniprogram/services/storySharing');
  const { bookExportApi } = await import('../miniprogram/services/bookExport');
  const originals = { capabilities: storySharing.capabilities, create: storySharing.create, material: bookExportApi.material };
  const previousWx = (globalThis as any).wx;
  (globalThis as any).wx = { getFileSystemManager: () => ({ unlink() {} }) };
  let created = 0;
  storySharing.capabilities = async () => ({ invitations: true, copy: true, sharedEdit: false, familyId: 'family-owner' });
  storySharing.create = async () => { created++; throw new Error('must not create'); };
  try {
    for (const failAt of ['first', 'last', 'hide']) {
      const page = await familyCardPage();
      const descriptor = page.descriptor;
      let verifies = 0;
      page.verifySnapshot = async () => {
        verifies++;
        if ((failAt === 'first' && verifies === 1) || (failAt === 'last' && verifies === 2)) throw new Error('账号或书稿已改变');
      };
      bookExportApi.material = async () => {
        if (failAt === 'hide') page.onHide();
        return { descriptor, coverUrl: 'https://approved-cover' };
      };
      await page.prepareFamilyInvitation();
      assert.equal(created, 0); assert.equal(page.data.familyShareReady, false);
      assert.deepEqual(page.onShareAppMessage(), sharingHome);
      if (failAt !== 'hide') assert.match(page.data.familyInviteNotice, /账号或书稿已改变/);
    }
  } finally {
    Object.assign(storySharing, { capabilities: originals.capabilities, create: originals.create }); bookExportApi.material = originals.material;
    (globalThis as any).wx = previousWx;
  }
});

test('邀请或收入权限未开时不创建卡片，不绕过云端门禁', async () => {
  const { storySharing, sharingHome } = await import('../miniprogram/services/storySharing');
  const originalCaps = storySharing.capabilities, originalCreate = storySharing.create;
  let created = 0;
  storySharing.create = async () => { created++; throw new Error('must not create'); };
  try {
    for (const disabled of ['invitations', 'copy']) {
      const page = await familyCardPage();
      storySharing.capabilities = async () => ({ invitations: disabled !== 'invitations', copy: disabled !== 'copy', sharedEdit: false, familyId: 'family-owner' });
      await page.prepareFamilyInvitation();
      assert.equal(created, 0); assert.equal(page.data.familyShareReady, false);
      assert.match(page.data.familyInviteNotice, /尚未开放/);
      assert.deepEqual(page.onShareAppMessage(), sharingHome);
    }
  } finally { storySharing.capabilities = originalCaps; storySharing.create = originalCreate; }
});

test('一段文字不能暗中变成整章阅读邀请', async () => {
  const page = await familyCardPage();
  page.data.scope = 'text'; page.data.selectedText = '原文';
  page.verifySnapshot = async () => { throw new Error('should not verify'); };
  await page.prepareFamilyInvitation();
  assert.equal(page.data.familyShareReady, false);
  assert.match(page.data.familyInviteNotice, /整章/);
  page.data.scope = 'chapters';
  page.chooseScope({ currentTarget: { dataset: { scope: 'text' } } });
  assert.equal(page.data.scope, 'chapters');
});

test('预览后选择漂移或版本核对失败，均不能生成邀请', async () => {
  const page = await familyCardPage();
  page.data.chapters[0].checked = true;
  await page.prepareFamilyInvitation();
  assert.match(page.data.familyInviteNotice, /与预览不一致/);
  assert.equal(page.data.familyShareReady, false);
  page.data.chapters[0].checked = false;
  page.verifySnapshot = async () => { throw new Error('书稿版本已经更新'); };
  await page.prepareFamilyInvitation();
  assert.match(page.data.familyInviteNotice, /版本已经更新/);
  assert.equal(page.data.invitationBusy, false); assert.equal(page.data.familyShareReady, false);
});

test('离页后晚到的邀请不能恢复私人卡片，重复点击不会重复创建', async () => {
  const page = await familyCardPage();
  const { storySharing, sharingHome } = await import('../miniprogram/services/storySharing');
  const { bookExportApi } = await import('../miniprogram/services/bookExport');
  const originals = { capabilities: storySharing.capabilities, create: storySharing.create, material: bookExportApi.material };
  let complete!: (value: any) => void, started!: () => void, calls = 0;
  const created = new Promise<void>(resolve => { started = resolve; });
  storySharing.capabilities = async () => ({ invitations: true, copy: true, sharedEdit: false, familyId: 'family-owner' });
  storySharing.create = () => { calls++; started(); return new Promise(resolve => { complete = resolve; }); };
  bookExportApi.material = async () => ({ descriptor: page.descriptor, coverUrl: 'https://approved-cover' });
  (globalThis as any).wx = { getFileSystemManager: () => ({ unlink() {} }) };
  try {
    const pending = page.prepareFamilyInvitation(); await created;
    await page.prepareFamilyInvitation(); assert.equal(calls, 1);
    page.onHide(); complete({ token: 'a'.repeat(48), invitationId: 'invite-one' }); await pending;
    assert.equal(page.data.familyShareReady, false); assert.equal(page.data.inviteeName, '');
    assert.deepEqual(page.onShareAppMessage(), sharingHome);
  } finally { Object.assign(storySharing, { capabilities: originals.capabilities, create: originals.create }); bookExportApi.material = originals.material; }
});

test('切换章节后晚到的原生选区不能污染新章选择', async () => {
  const page = await socialPage(); let complete!: (result: any) => void;
  page.data.editorReady = true;
  page.editor = { getSelectionText: ({ success }: any) => { complete = success; }, setContents: ({ success }: any) => success() };
  page.captureSelection(); page.chooseTextChapter({ detail: { value: '1' } }); complete({ text: '原文' });
  assert.equal(page.data.selectedText, ''); assert.equal(page.data.characterCount, 0);
});

test('离页清掉私人快照并忽略晚到封面结果', async () => {
  const page = await socialPage();
  const { storyCoverApi } = await import('../miniprogram/services/storyCoverService');
  const previous = storyCoverApi.resolveUrl; let complete!: (url: string) => void;
  storyCoverApi.resolveUrl = () => new Promise(resolve => { complete = resolve; });
  try {
    const task = page.resolveCover(page.snapshot, page.epoch);
    page.onHide(); complete('https://late-image'); await task;
    assert.equal(page.snapshot, undefined); assert.equal(page.data.coverUrl, ''); assert.deepEqual(page.data.chapters, []);
  } finally { storyCoverApi.resolveUrl = previous; }
});

test('预览前账号复核失败时清除旧账号的正文和封面', async () => {
  const page = await socialPage(); const { state } = fixture();
  // Align the version with this fresh fixture while retaining the old account snapshot.
  state.manuscriptRevisions![0].id = page.expected.revisionId;
  state.stories![0].currentRevisionId = page.expected.revisionId;
  page.data.scope = 'book'; page.data.coverUrl = 'previous-private-cover'; page.data.title = 'previous-private-title';
  (globalThis as any).wx = { getStorageSync: (key: string) => key === 'shiguang-family-room-v5' ? structuredClone(state) : '', setStorageSync() {} };
  await page.previewSelection();
  assert.equal(page.snapshot, undefined); assert.deepEqual(page.data.chapters, []);
  assert.equal(page.data.title, ''); assert.equal(page.data.coverUrl, ''); assert.equal(page.data.preview, false);
  assert.match(page.data.notice, /账号/);
});

test('导出未开放时不读取云端导出素材、不渲染图片', async () => {
  const page=await socialPage(); page.data.preview=true;page.data.exportAvailable=false;
  page.verifySnapshot=()=>{throw new Error('should not run');};
  await page.generateImages(); assert.deepEqual(page.data.imagePaths,[]);
});

test('没有封面时可以从图片预览进入 AI 封面制作页', async () => {
  const page = await socialPage(); const urls: string[] = [];
  (globalThis as any).wx = { navigateTo: ({ url }: any) => urls.push(url) };
  page.makeCover();
  assert.equal(page.returningFromCover, true);
  assert.deepEqual(urls, ['/pages/story-cover/story-cover?storyId=story-test']);
});

test('相册部分失败后续存只保存剩余图片，每次重试重新核对权限', async () => {
  const page=await socialPage();const {bookExportApi}=await import('../miniprogram/services/bookExport');
  const original=bookExportApi.material; let verified=0;const saved:string[]=[];
  page.verifySnapshot=async()=>{};page.exportSelection={};page.descriptor={id:'descriptor'};
  page.data.imagePaths=['cover','page1','page2'];
  bookExportApi.material=async()=>{verified++;return {descriptor:page.descriptor,coverUrl:''};};
  (globalThis as any).wx={saveImageToPhotosAlbum:({filePath,success,fail}:any)=>{if(filePath==='page1'&&saved.length===1){saved.push('failed');fail({errMsg:'permission deny'});}else{saved.push(filePath);success();}}};
  try {
    await page.saveImages();assert.deepEqual(page.data.savedIndices,[0]);assert.match(page.data.notice,/允许保存/);
    await page.saveImages();assert.deepEqual(saved,['cover','failed','page1','page2']);assert.equal(verified,2);
    assert.deepEqual(page.data.savedIndices,[0,1,2]);
  } finally {bookExportApi.material=original;}
});

test('相册保存没有回调时停止转圈并允许重试', async () => {
  const page=await socialPage();const {bookExportApi}=await import('../miniprogram/services/bookExport');
  const original=bookExportApi.material;
  page.verifySnapshot=async()=>{};page.exportSelection={};page.descriptor={id:'descriptor'};
  page.data.imagePaths=['cover'];page.albumSaveTimeoutMs=1;
  bookExportApi.material=async()=>({descriptor:page.descriptor,coverUrl:''});
  (globalThis as any).wx={saveImageToPhotosAlbum:()=>undefined};
  try {
    await page.saveImages();
    assert.equal(page.data.albumSaving,false);
    assert.deepEqual(page.data.savedIndices,[]);
    assert.match(page.data.notice,/没有响应.*再试一次/);
  } finally {bookExportApi.material=original;}
});

test('离页停止后续相册写入并清理临时图片', async () => {
  const page=await socialPage();const {bookExportApi}=await import('../miniprogram/services/bookExport');
  const original=bookExportApi.material;const removed:string[]=[],saved:string[]=[];
  page.verifySnapshot=async()=>{};page.exportSelection={};page.descriptor={id:'descriptor'};page.data.imagePaths=['cover','page1'];
  bookExportApi.material=async()=>({descriptor:page.descriptor,coverUrl:''});
  (globalThis as any).wx={getFileSystemManager:()=>({unlink:({filePath}:any)=>removed.push(filePath)}),saveImageToPhotosAlbum:({filePath,success}:any)=>{saved.push(filePath);page.onHide();success();}};
  try{await page.saveImages();assert.deepEqual(saved,['cover']);assert.deepEqual(removed,['cover','page1']);assert.deepEqual(page.data.imagePaths,[]);assert.equal(page.snapshot,undefined);}
  finally{bookExportApi.material=original;}
});

test('导出权限撤销后不写相册并清掉已有图片',async()=>{
  const page=await socialPage();const {bookExportApi}=await import('../miniprogram/services/bookExport');const original=bookExportApi.material;
  page.verifySnapshot=async()=>{};page.exportSelection={};page.descriptor={id:'descriptor'};page.data.imagePaths=['private'];
  const removed:string[]=[];(globalThis as any).wx={getFileSystemManager:()=>({unlink:({filePath}:any)=>removed.push(filePath)}),saveImageToPhotosAlbum:()=>{throw new Error('must not save');}};
  bookExportApi.material=async()=>{throw new Error('权限已撤销');};
  try{await page.saveImages();assert.deepEqual(removed,['private']);assert.deepEqual(page.data.imagePaths,[]);assert.match(page.data.notice,/撤销/);}finally{bookExportApi.material=original;}
});
test('每张成品图在再次核对权限后可直接打开微信图片分享菜单',async()=>{
  const page=await socialPage();const {bookExportApi}=await import('../miniprogram/services/bookExport');const original=bookExportApi.material;
  page.verifySnapshot=async()=>{};page.exportSelection={};page.descriptor={id:'descriptor'};page.data.imagePaths=['cover','page1'];
  const shared:string[]=[];let verified=0;
  bookExportApi.material=async()=>{verified++;return {descriptor:page.descriptor,coverUrl:''};};
  (globalThis as any).wx={showShareImageMenu:({path,success}:any)=>{shared.push(path);success();}};
  try{
    await page.shareImage({currentTarget:{dataset:{index:1}}});
    assert.equal(verified,1);assert.deepEqual(shared,['page1']);assert.match(page.data.notice,/朋友圈/);assert.equal(page.data.sharingIndex,-1);
  }finally{bookExportApi.material=original;}
});

test('社交页可从记忆来源进入并在预览前重验云端版本', async () => {
  const page = await socialPage();
  const calls: any[] = [];
  (globalThis as any).wx = {
    hideShareMenu() {},
    cloud: { callFunction: async ({ data }: any) => {
      calls.push(data);
      if (data.action === 'capabilities') return { result: { bookExport: true } };
      assert.equal(data.memoryId, 'memory-one');
      assert.equal(JSON.stringify(data).includes('伪造正文'), false);
      return { result: { source: { kind: 'memory', memoryId: 'memory-one', revisionId: 'revision-ai',
        sourceVersion: 'a'.repeat(64), title: '雨天', text: '屋檐下听雨。', containsAiText: true } } };
    } },
  };
  page.onLoad({ memoryId: 'memory-one', revisionId: 'revision-ai', text: '伪造正文' });
  page.hidden = false;
  await page.refreshMemory();
  assert.equal(page.data.sourceKind, 'memory');
  assert.equal(page.data.title, '雨天');
  assert.equal(page.data.characterCount, Array.from('屋檐下听雨。').length);
  await page.previewSelection();
  assert.equal(page.data.preview, true);
  assert.equal(page.data.previewChapters[0].text, '屋檐下听雨。');
  assert.deepEqual(calls.filter(call => call.action === 'memoryExportSource').map(call => call.expectedSourceVersion), [undefined, 'a'.repeat(64)]);
});

let archive: PageDefinition;
async function archivePage() {
  if (!archive) {
    const previous = (globalThis as any).Page;
    (globalThis as any).Page = (value: PageDefinition) => { archive = value; };
    try { await import('../miniprogram/pages/archive/archive'); }
    finally { (globalThis as any).Page = previous; }
  }
  const page: PageDefinition = { ...archive, data: structuredClone(archive.data) };
  page.setData = (patch: PageDefinition) => Object.assign(page.data, patch);
  return page;
}

test('归档页发送记忆只传来源标识；未保存草稿先预览保存，保存后继续发送', async () => {
  const page = await archivePage();
  const state = createDemoRoomStateForTests();
  const memory = createContribution({ id: 'memory-one', authorMemberId: 'owner', authorName: '林岚', relation: '自己',
    text: '屋檐下听雨。', scope: 'personal', visibility: 'private' });
  state.contributions.push(memory);
  const urls: string[] = [], toasts: string[] = [];
  const stored = new Map<string, any>([
    ['shiguang-family-room-v5', state],
    ['shiguang-current-member-v1', 'owner'],
  ]);
  (globalThis as any).wx = {
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: any) => stored.set(key, value),
    navigateTo: ({ url }: any) => urls.push(url),
    showToast: ({ title }: any) => toasts.push(title),
  };
  page.showEditor(memory);
  page.sendMemorySocial();
  assert.equal(urls.length, 1);
  assert.match(urls[0], /memoryId=memory-one/);
  assert.equal(urls[0].includes('屋檐'), false);

  urls.length = 0;
  page.startDocumentEdit();
  page.onEditText({ detail: { value: '还没保存的新正文。' } });
  page.setData({ chatMessages: page.data.chatMessages.concat([
    { id: 'chat-user', role: 'user', text: '只作为聊天补充的线索。', label: '' },
    { id: 'chat-ai', role: 'assistant', text: '未采纳的 AI 回答不能进正文。', label: '文字 AI 生成' },
  ]) });
  page.sendMemorySocial();
  assert.deepEqual(urls, []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.previewOpen, true);
  assert.match(page.data.previewText, /还没保存的新正文/);
  assert.match(page.data.previewText, /只作为聊天补充的线索/);
  assert.equal(page.data.previewText.includes('未采纳的 AI 回答不能进正文'), false);
  assert.match(toasts[toasts.length - 1], /保存后继续发送/);

  await page.savePreview({ currentTarget: { dataset: { mode: 'update-current' } } });
  assert.equal(urls.length, 1);
  const routedUrl = urls[0] as string;
  assert.match(routedUrl, /memoryId=memory-one/);
  assert.match(routedUrl, /revisionId=revision-/);
  assert.equal(routedUrl.includes('还没保存的新正文'), false);
  assert.equal(routedUrl.includes('只作为聊天补充'), false);
  const saved = (stored.get('shiguang-family-room-v5').contributions as any[]).find(item => item.id === 'memory-one');
  assert.equal(memoryAiRevisions(saved).slice(-1)[0].id, decodeURIComponent(routedUrl.match(/revisionId=([^&]+)/)![1]));
  assert.equal(saved.text.includes('未采纳的 AI 回答不能进正文'), false);
});


test('记忆成品图直接发送也会重新核对记忆版本与导出权限', async () => {
  const page = await socialPage();
  const { bookExportApi } = await import('../miniprogram/services/bookExport');
  const original = bookExportApi.material;
  const source = { memoryId: 'memory-one', sourceVersion: 'v1' };
  const checks: string[] = [], shared: string[] = [];
  page.snapshot = undefined; page.memorySource = source;
  page.exportSelection = { sourceKind: 'memory' }; page.descriptor = { id: 'memory-export' };
  page.data.imagePaths = ['memory-image'];
  page.verifyMemorySource = async (value: unknown) => { assert.equal(value, source); checks.push('source'); };
  bookExportApi.material = async () => { checks.push('permission'); return { descriptor: page.descriptor, coverUrl: '' }; };
  (globalThis as any).wx = { showShareImageMenu: ({ path, success }: any) => { shared.push(path); success(); } };
  try {
    await page.shareImage({ currentTarget: { dataset: { index: 0 } } });
    assert.deepEqual(checks, ['source', 'permission']); assert.deepEqual(shared, ['memory-image']);
    page.verifyMemorySource = async () => { throw new Error('版本已更新'); };
    (globalThis as any).wx.getFileSystemManager = () => ({ unlink() {} });
    await page.shareImage({ currentTarget: { dataset: { index: 0 } } });
    assert.deepEqual(shared, ['memory-image']); assert.deepEqual(page.data.imagePaths, []);
  } finally { bookExportApi.material = original; }
});

test('章节发送先保存当前章节，成功后打开同一图文预览入口', async () => {
  const page = await bookPage();
  page.data.view = 'chapter'; page.activeChapterId = 'chapter-one';
  let saved!: (value: boolean) => void;
  page.finishEditing = () => new Promise(resolve => { saved = resolve; });
  const urls: string[] = [];
  (globalThis as any).wx = { navigateTo: ({ url, success }: any) => { urls.push(url); success(); } };
  const task = page.chooseSend(sendEvent('family'));
  assert.equal(typeof saved, 'function');
  assert.deepEqual(urls, []);
  page.data.savedRevisionId = 'revision-chapter-saved'; page.story.version = 4;
  saved(true); await task;
  assert.deepEqual(urls, ['/packages/story-sharing/pages/social/index?storyId=story-test&revisionId=revision-chapter-saved&version=4&destination=family']);
});

test('章节发送等待期间切到另一章，不用迟到的保存回执跳转', async () => {
  const page = await bookPage();
  page.data.view = 'chapter'; page.activeChapterId = 'chapter-one';
  let saved!: (value: boolean) => void;
  page.finishEditing = () => new Promise(resolve => { saved = resolve; });
  let calls = 0;
  (globalThis as any).wx = { navigateTo: () => { calls++; } };
  const task = page.chooseSend(sendEvent('social'));
  assert.equal(typeof saved, 'function');
  page.activeChapterId = 'chapter-two'; saved(true); await task;
  assert.equal(calls, 0); assert.equal(page.data.preparingSend, false);
});

test('更多、发送与图片菜单互斥，选择工具后不留遮罩', async () => {
  const page = await bookPage();
  (globalThis as any).wx = { hideKeyboard() {} };
  page.data.photoMenu = 'main';
  page.showMore(); assert.equal(page.data.moreOpen, true); assert.equal(page.data.photoMenu, '');
  page.toggleSend(); assert.equal(page.data.sendOpen, true); assert.equal(page.data.moreOpen, false);
  page.canLeaveEditor = () => true; page.openImages = () => {};
  page.data.photoMenu = 'main';
  page.selectTool({ currentTarget: { dataset: { action: 'images' } } });
  assert.equal(page.data.sendOpen, false); assert.equal(page.data.photoMenu, ''); assert.equal(page.data.moreOpen, false);
});

test('合并后的公开故事卡入口先保存再跳转，保存失败不跳转', async () => {
  const page = await bookPage(), urls: string[] = [];
  (globalThis as any).wx = { navigateTo: ({ url, success }: any) => { urls.push(url); success(); } };
  page.finishEditing = async () => false;
  await page.chooseSend(sendEvent('card')); assert.deepEqual(urls, []);
  page.finishEditing = async () => true;
  await page.chooseSend(sendEvent('card'));
  assert.deepEqual(urls, ['/packages/story-sharing/pages/card/index?storyId=story-test']);
});
