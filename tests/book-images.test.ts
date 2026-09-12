import assert from "node:assert/strict";
import test from "node:test";
import { contentFromDelta, contentToDelta, saveLocalPhoto, readLocalPhoto } from "../miniprogram/services/bookImages";

test("native editor photo stays between text blocks and never serializes a device path", () => {
  const content = contentFromDelta({ ops: [{ insert: "前文\n" }, { insert: { image: "wxfile://saved/p.jpg" } }, { insert: "\n后文\n" }] }, { "wxfile://saved/p.jpg": "photo-123-a" });
  assert.deepEqual(content, [{ text: "前文\n" }, { photoId: "photo-123-a" }, { text: "\n后文\n" }]);
  assert.ok(!JSON.stringify(content).includes("wxfile"));
  assert.deepEqual(contentToDelta(content, { "photo-123-a": "wxfile://saved/p.jpg" }).ops[1].insert, { image: "wxfile://saved/p.jpg" });
});

test("missing local photos remain recoverable references; unknown pasted image URLs cannot be saved", () => {
  const content = [{ photoId: "photo-123-a" }];
  const delta = contentToDelta(content, {});
  assert.deepEqual(contentFromDelta(delta, {}), [...content, { text: "\n" }]);
  assert.throws(() => contentFromDelta({ ops: [{ insert: { image: "https://untrusted.invalid/x.jpg" } }] }, {}), /照片按钮/);
});

test("photo is copied out of temporary storage and can be looked up after reopening", async context => {
  const previous = (globalThis as any).wx;
  context.after(() => { (globalThis as any).wx = previous; });
  const stored = new Map<string, unknown>();
  (globalThis as any).wx = {
    env: { USER_DATA_PATH: "wxfile://usr" },
    getFileSystemManager: () => ({ saveFile: ({ success }: any) => success({ savedFilePath: "wxfile://usr/saved.jpg" }), accessSync: () => {} }),
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: unknown) => stored.set(key, value),
  };
  const photo = await saveLocalPhoto("wxfile://temporary/selected.jpg");
  assert.equal(await readLocalPhoto(photo.id), "wxfile://usr/saved.jpg");
  assert.equal(await readLocalPhoto("../wrong"), "");
});

test("existing WeChat saved-file paths outside USER_DATA_PATH remain visible", async context => {
  const previous = (globalThis as any).wx;
  context.after(() => { (globalThis as any).wx = previous; });
  let path = "wxfile://store_abc123.jpg";
  let checked = "";
  (globalThis as any).wx = {
    env: { USER_DATA_PATH: "wxfile://usr" },
    getStorageSync: () => path,
    getFileSystemManager: () => ({
      accessSync: (value: string) => { checked = value; },
      getSavedFileList: ({ success }: any) => success({ fileList: [
        { filePath: "wxfile://store_abc123.jpg" }, { filePath: "http://store/abc123.jpg" },
      ] }),
    }),
  };
  for (const saved of ["wxfile://store_abc123.jpg", "http://store/abc123.jpg", "wxfile://usr/photo.jpg"]) {
    path = saved;
    assert.equal(await readLocalPhoto("photo-123-a"), saved);
    assert.equal(checked, saved);
  }
  for (const unsafe of ["https://example.com/photo.jpg", "http://store.example.com/photo.jpg", "wxfile://usr/../secret", "wxfile://tmp_abc.jpg"]) {
    path = unsafe;
    checked = "";
    assert.equal(await readLocalPhoto("photo-123-a"), "");
    assert.equal(checked, "", "do not access external or untrusted file paths");
  }
});

test("new photos explicitly request a persistent user path and verify it before returning", async context => {
  const previous = (globalThis as any).wx;
  context.after(() => { (globalThis as any).wx = previous; });
  const stored = new Map<string, unknown>();
  let requested = "";
  let checked = "";
  (globalThis as any).wx = {
    env: { USER_DATA_PATH: "wxfile://usr" },
    getFileSystemManager: () => ({
      saveFile: ({ filePath, success }: any) => { requested = filePath; success({ savedFilePath: filePath }); },
      accessSync: (path: string) => { checked = path; },
    }),
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: unknown) => stored.set(key, value),
  };
  const photo = await saveLocalPhoto("wxfile://tmp_123.png");
  assert.equal(requested, `wxfile://usr/${photo.id}.png`);
  assert.equal(photo.path, requested);
  assert.equal(checked, requested);
  assert.equal(await readLocalPhoto(photo.id), requested);
});
