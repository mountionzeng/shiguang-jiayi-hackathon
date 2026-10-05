import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCurrentAccount, saveCurrentAccountName } from '../miniprogram/services/accountService';
import { chapterDraftScope } from '../miniprogram/services/chapterDraft';

function install(context: any) {
  const previousWx = (globalThis as any).wx, previousApp = (globalThis as any).getApp;
  const calls: Array<{ data?: any; resolve: (value: any) => void; reject: (error: Error) => void }> = [];
  (globalThis as any).wx = { cloud: { callFunction: ({ data }: any) => new Promise((resolve, reject) => calls.push({ data, resolve, reject })) } };
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: true } });
  context.after(() => { (globalThis as any).wx = previousWx; (globalThis as any).getApp = previousApp; });
  return calls;
}
const account = (id: string) => ({ result: { accountLinked: true, account: { accountId: id, primaryFamilyId: 'family-' + id, displayName: id } } });

test('parallel account reads share a request; later reads and profile changes revalidate', async context => {
  const calls = install(context);
  const first = loadCurrentAccount(), second = loadCurrentAccount();
  assert.equal(calls.length, 1);
  calls[0].resolve(account('first'));
  assert.equal((await first).accountId, 'first'); await second;
  const stale = loadCurrentAccount();
  const renamed = saveCurrentAccountName('new name');
  assert.equal(calls[2].data.action, 'updateProfile'); calls[2].resolve(account('new')); await renamed;
  const fresh = loadCurrentAccount(); assert.equal(calls.length, 4);
  calls[1].resolve(account('stale')); await stale;
  assert.equal(loadCurrentAccount(), fresh, 'old read completion must not clear the new pending read');
  calls[3].resolve(account('current')); assert.equal((await fresh).accountId, 'current');
});

test('draft identity is revalidated after completion, mode changes and failed reads', async context => {
  const calls = install(context), cloud = wx.cloud;
  (wx as any).cloud = undefined; assert.equal(await chapterDraftScope(), 'local'); (wx as any).cloud = cloud;
  const first = chapterDraftScope(), same = chapterDraftScope(); assert.equal(calls.length, 1);
  calls[0].resolve({ result: { openid: 'alice', account: { primaryFamilyId: 'a' } } });
  assert.equal(await first, JSON.stringify(['alice', 'a'])); assert.equal(await same, await first);
  const changed = chapterDraftScope(); assert.equal(calls.length, 2);
  calls[1].resolve({ result: { openid: 'bob', account: { primaryFamilyId: 'b' } } });
  assert.equal(await changed, JSON.stringify(['bob', 'b']));
  const failed = chapterDraftScope(); calls[2].reject(new Error('network')); await assert.rejects(failed, /network/);
  const retry = chapterDraftScope(); assert.equal(calls.length, 4);
  calls[3].resolve({ result: { openid: 'bob' } }); assert.equal(await retry, JSON.stringify(['bob', '']));
});
