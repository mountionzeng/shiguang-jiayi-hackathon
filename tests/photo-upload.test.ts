import assert from "node:assert/strict";
import test from "node:test";

import {
  beginPhotoUploadSession,
  clearPhotoUploadQueue,
  deleteMyCloudPhotos,
  enqueuePhotoUpload,
  loadCloudPhotoSummary,
  pendingPhotoUploads,
  resumePhotoUploads,
  retryPhotoUpload,
} from "../miniprogram/services/photoCloud";

test("照片上传队列生成 1600 显示图和不超过 100KB 的 768 小图，登记成功后清队", async context => {
  const previous = (globalThis as any).wx;
  context.after(() => { (globalThis as any).wx = previous; });
  const stored = new Map<string, unknown>();
  const compressions: Array<{ width: number; quality: number }> = [];
  const uploads: Array<{ cloudPath: string; filePath: string }> = [];
  const calls: Array<{ name: string; data?: Record<string, unknown> }> = [];
  (globalThis as any).wx = {
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: unknown) => stored.set(key, structuredClone(value)),
    getImageInfo: ({ success }: any) => success({ width: 2400, height: 1600, path: "local.jpg", orientation: "up", type: "jpg" }),
    compressImage: ({ compressedWidth, quality, success }: any) => {
      compressions.push({ width: compressedWidth, quality });
      success({ tempFilePath: `compressed-${compressedWidth}-${quality}.jpg` });
    },
    getFileSystemManager: () => ({
      getFileInfo: ({ filePath, success }: any) => success({
        size: filePath.includes("1600") ? 320000 : filePath.includes("-70") ? 120000 : 80000,
      }),
    }),
    cloud: {
      uploadFile: async ({ cloudPath, filePath }: { cloudPath: string; filePath: string }) => {
        uploads.push({ cloudPath, filePath });
        return { fileID: `cloud://env/${cloudPath}` };
      },
      callFunction: async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
        calls.push({ name, data });
        if (name === "getOpenId") return { result: { openid: "owner-openid" } };
        return { result: { ok: true } };
      },
    },
  };

  enqueuePhotoUpload("photo-abc-123", "wxfile://usr/original.jpg", "book");
  assert.equal(pendingPhotoUploads().length, 1);
  await resumePhotoUploads();

  assert.deepEqual(compressions, [
    { width: 1600, quality: 80 },
    { width: 768, quality: 70 },
    { width: 768, quality: 55 },
  ]);
  assert.equal(uploads.length, 2);
  assert.ok(uploads.every(upload => upload.cloudPath.startsWith("user-photos/family_owner-openid/photo-abc-123/")));
  const register = calls.find(call => call.name === "photoAccess");
  assert.equal(register?.data?.action, "register");
  assert.equal(register?.data?.displayBytes, 320000);
  assert.equal(register?.data?.smallBytes, 80000);
  assert.equal(pendingPhotoUploads().length, 0);
});

test("上传失败保留可重试状态，手动重试清零次数", async context => {
  const previous = (globalThis as any).wx;
  context.after(() => { (globalThis as any).wx = previous; });
  const stored = new Map<string, unknown>();
  (globalThis as any).wx = {
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: unknown) => stored.set(key, structuredClone(value)),
    getImageInfo: ({ fail }: any) => fail(new Error("file missing")),
    cloud: {},
  };
  enqueuePhotoUpload("photo-fail-123", "wxfile://usr/missing.jpg", "backfill");
  await resumePhotoUploads();
  assert.equal(pendingPhotoUploads()[0].status, "failed");
  assert.equal(pendingPhotoUploads()[0].attempts, 1);
  retryPhotoUpload("photo-fail-123");
  assert.equal(pendingPhotoUploads()[0].status, "waiting");
  assert.equal(pendingPhotoUploads()[0].attempts, 0);
  beginPhotoUploadSession();
  assert.equal(pendingPhotoUploads()[0].attempts, 0);
});

test("照片管理读取本人统计并以固定确认词删除，删除后可清空待上传队列", async context => {
  const previous = (globalThis as any).wx;
  context.after(() => { (globalThis as any).wx = previous; });
  const stored = new Map<string, unknown>();
  const calls: Array<{ name: string; data?: Record<string, unknown> }> = [];
  (globalThis as any).wx = {
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: unknown) => stored.set(key, structuredClone(value)),
    cloud: {
      callFunction: async ({ name, data }: { name: string; data?: Record<string, unknown> }) => {
        calls.push({ name, data });
        if (name === "getOpenId") return { result: { openid: "owner-openid" } };
        if (data?.action === "listMine") return { result: { count: 2, bytes: 432100, checking: 1 } };
        return { result: { ok: true } };
      },
    },
  };

  enqueuePhotoUpload("photo-pending-123", "wxfile://usr/pending.jpg", "book");
  assert.deepEqual(await loadCloudPhotoSummary(), { count: 2, bytes: 432100, checking: 1 });
  await deleteMyCloudPhotos();
  clearPhotoUploadQueue();

  const photoCalls = calls.filter(call => call.name === "photoAccess");
  assert.deepEqual(photoCalls.map(call => call.data?.action), ["listMine", "deleteMine"]);
  assert.ok(photoCalls.every(call => call.data?.familyId === "family_owner-openid"));
  assert.equal(photoCalls[1].data?.confirm, "DELETE_MY_CLOUD_PHOTOS");
  assert.equal(pendingPhotoUploads().length, 0);
});
