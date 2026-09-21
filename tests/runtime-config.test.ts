import assert from "node:assert/strict";
import test from "node:test";
import { CLOUD_AI_RELEASE_READY, cloudEnvForAppId } from "../miniprogram/config/runtime";

test("云环境只按已登记的 AppID 解析", () => {
  assert.equal(cloudEnvForAppId("wx6be512f0fe129b62"), "cloud1-d0g8c8yg0513a6068");
  assert.equal(cloudEnvForAppId("wx86ae3e9d507ce52d"), "cloud1-d5ghzk30ve609f544");
  assert.equal(cloudEnvForAppId("wx0000000000000000"), undefined);
  assert.equal(cloudEnvForAppId(""), undefined);
});

test("企业预览版的 AI 发布闸门默认关闭", () => {
  assert.equal(CLOUD_AI_RELEASE_READY, false);
});

test("小程序启动时未知 AppID 不初始化云环境，已登记 AppID 才初始化", async () => {
  type AppDefinition = {
    globalData: { cloudReady: boolean; aiReady: boolean };
    onLaunch(): void;
  };
  let definition: AppDefinition | undefined;
  let appId = "wx0000000000000000";
  const cloudInitCalls: Array<{ env: string; traceUser: boolean }> = [];
  const priorApp = (globalThis as typeof globalThis & { App?: unknown }).App;
  const priorWx = (globalThis as typeof globalThis & { wx?: unknown }).wx;
  (globalThis as typeof globalThis & { App: (value: AppDefinition) => void }).App = value => { definition = value; };
  (globalThis as typeof globalThis & { wx: unknown }).wx = {
    cloud: { init: (options: { env: string; traceUser: boolean }) => { cloudInitCalls.push(options); } },
    getAccountInfoSync: () => ({ miniProgram: { appId } }),
    getStorageSync: () => [],
    setStorageSync: () => undefined,
    onNetworkStatusChange: () => undefined,
  };
  try {
    await import("../miniprogram/app");
    assert.ok(definition);

    const pendingApp = { globalData: { cloudReady: false, aiReady: false } };
    definition.onLaunch.call(pendingApp);
    assert.deepEqual(cloudInitCalls, []);
    assert.equal(pendingApp.globalData.cloudReady, false);

    appId = "wx86ae3e9d507ce52d";
    const configuredApp = { globalData: { cloudReady: false, aiReady: false } };
    definition.onLaunch.call(configuredApp);
    assert.deepEqual(cloudInitCalls, [{ env: "cloud1-d5ghzk30ve609f544", traceUser: false }]);
    assert.equal(configuredApp.globalData.cloudReady, true);
    assert.equal(configuredApp.globalData.aiReady, false);
  } finally {
    (globalThis as typeof globalThis & { App?: unknown }).App = priorApp;
    (globalThis as typeof globalThis & { wx?: unknown }).wx = priorWx;
  }
});
