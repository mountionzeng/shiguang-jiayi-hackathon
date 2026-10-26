import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

function harness() {
  const stored = new Map<string, any>();
  const uploads: string[] = [], writes: string[] = [], sends: any[] = [];
  let failSend = false;
  const wx = {
    env: { USER_DATA_PATH: '/saved' },
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: any) => stored.set(key, value),
    getFileSystemManager: () => ({
      writeFile: ({filePath, success}: any) => { writes.push(filePath); success(); },
      unlink() {},
    }),
    cloud: {
      uploadFile: async ({cloudPath}: any) => { uploads.push(cloudPath); return {fileID: 'cloud://test/package'}; },
      callFunction: async ({data}: any) => {
        sends.push(structuredClone(data));
        if (failSend) throw new Error('network unavailable');
        return {result: {deliveryId: 'delivery-test', uploadTickets: [], repeated: false}};
      },
    },
  };
  function load(name: string, flow?: any) {
    const filename = resolve('miniprogram/services/' + name + '.ts');
    const nativeRequire = createRequire(filename);
    const api: any = {};
    const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
    }).outputText;
    vm.runInNewContext(source, {exports: api, wx, require(id: string) {
      if (id === './chapterPackageFlow') return flow;
      const value = nativeRequire(id);
      if (id === './chapterPackageService') return {...value, chapterPackageEnabled: () => true};
      if (id === '../config/runtime') return {...value, CHAPTER_DELIVERY_ENABLED: true};
      return value;
    }});
    return api;
  }
  const flow = load('chapterPackageFlow');
  return {flow, delivery: load('chapterDelivery', flow), stored, uploads, writes, sends,
    fail(value: boolean) { failSend = value; }};
}

const chapter = {id: 'chapter-text', title: '虚构纸船', memoryIds: [], content: [{text: '纸船从桥下经过。\n'}]};

test('sending a text chapter uses one business request without uploading a redundant JSON export', async () => {
  const h = harness();
  h.stored.set('chapterPackage.lastExport', {fileID: 'cloud://old/explicit-export'});
  await h.delivery.sendChapter(chapter, '我', '虚构故事', undefined, 'contact-test');
  assert.deepEqual(h.uploads, []);
  assert.deepEqual(h.writes, []);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].action, 'sendChapter');
  assert.equal(h.stored.get('chapterPackage.lastExport').fileID, 'cloud://old/explicit-export');
  assert.equal(h.stored.get('chapterDelivery.outbox.v1').length, 0);
});

test('failed delivery retains the same package and request for retry without creating a JSON export', async () => {
  const h = harness();
  h.fail(true);
  await assert.rejects(h.delivery.sendChapter(chapter, '我', '虚构故事', undefined, 'contact-test'), /network unavailable/);
  const pending = h.stored.get('chapterDelivery.outbox.v1')[0];
  assert.ok(pending.package.packageId);
  h.fail(false);
  await h.delivery.sendChapter({...chapter, content: [{text: '更晚的文字'}]}, '我', '虚构故事', undefined, 'contact-test');
  assert.equal(h.sends[1].requestId, pending.requestId);
  assert.deepEqual(h.sends[1].package, h.sends[0].package);
  assert.deepEqual(h.uploads, []);
  assert.equal(h.stored.get('chapterDelivery.outbox.v1').length, 0);
});

test('explicit package export still uploads JSON and records its import recovery handle', async () => {
  const h = harness();
  const result = await h.flow.exportChapterToCloud(chapter, '我', '虚构故事');
  assert.deepEqual(h.uploads, [result.cloudPath]);
  assert.equal(h.writes.length, 1);
  assert.equal(result.fileID, 'cloud://test/package');
  assert.equal(h.stored.get('chapterPackage.lastExport').fileID, result.fileID);
  assert.equal(h.stored.get('chapterPackage.lastExport').chapterId, chapter.id);
});
