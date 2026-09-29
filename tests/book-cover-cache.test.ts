import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheBookCover, cachedBookCover } from '../miniprogram/services/bookCoverCache';
import { renderBookCover } from '../miniprogram/services/bookFrameColor';

function installCacheMock(context: test.TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'wx');
  const stored = new Map<string, unknown>();
  const files = new Set<string>();
  let failSave = false;
  const fs = {
    accessSync(path: string) { if (!files.has(path)) throw new Error('evicted'); },
    saveFile(options: { filePath: string; success: (result: {savedFilePath: string}) => void; fail: (error: Error) => void }) {
      if (failSave) { options.fail(new Error('storage full')); return; }
      files.add(options.filePath); options.success({ savedFilePath: options.filePath });
    },
    unlink(options: { filePath: string }) { files.delete(options.filePath); },
  };
  Object.defineProperty(globalThis, 'wx', { configurable: true, value: {
    env: { USER_DATA_PATH: '/user' },
    getStorageSync: (key: string) => structuredClone(stored.get(key)),
    setStorageSync: (key: string, value: unknown) => stored.set(key, structuredClone(value)),
    getFileSystemManager: () => fs,
  }});
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, 'wx', previous);
    else delete (globalThis as any).wx;
  });
  return { files, stored, failSave: () => { failSave = true; } };
}

test('saved book preview survives a fresh lookup and bypasses canvas and download work', async context => {
  installCacheMock(context);
  const path = await cacheBookCover('story-a:cover-a', '/temp/render.png');
  assert.equal(cachedBookCover('story-a:cover-a'), path);
  // No selector or image-download mock: either would throw if invoked on a cache hit.
  assert.equal(await renderBookCover({} as any, 'https://expired.example/cover', 'story-a:cover-a'), path);
  assert.equal(cachedBookCover('story-a:cover-new'), '', 'replaced covers must render again');
  assert.equal(cachedBookCover('story-b:cover-a'), '', 'stories must not share preview identities');
});

test('evicted files and full storage degrade to a cache miss or current temporary image', async context => {
  const mock = installCacheMock(context);
  const path = await cacheBookCover('story-a:cover-a', '/temp/render.png');
  mock.files.delete(path);
  assert.equal(cachedBookCover('story-a:cover-a'), '');
  mock.failSave();
  assert.equal(await cacheBookCover('story-a:cover-a', '/temp/retry.png'), '/temp/retry.png');
});

test('preview retention is bounded and never deletes original photos', async context => {
  const mock = installCacheMock(context);
  mock.files.add('/user/photo-original.png');
  mock.stored.set('shiguang-book-preview-v1', [{ key: 'untrusted', path: '/user/photo-original.png' }]);
  for (let i = 0; i < 14; i++) await cacheBookCover(`story:${i}`, `/temp/${i}.png`);
  assert.equal(cachedBookCover('story:0'), '');
  assert.ok(cachedBookCover('story:13'));
  assert.equal(mock.files.size, 13);
  assert.ok(mock.files.has('/user/photo-original.png'));
});
