import assert from "node:assert/strict";
import test from "node:test";
import { cloudEnvForAppId } from "../miniprogram/config/runtime";

test("云环境只按已登记的 AppID 解析", () => {
  assert.equal(cloudEnvForAppId("wx6be512f0fe129b62"), "cloud1-d0g8c8yg0513a6068");
  assert.equal(cloudEnvForAppId("wx-new-account"), undefined);
  assert.equal(cloudEnvForAppId(""), undefined);
});
