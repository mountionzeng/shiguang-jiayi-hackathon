import assert from "node:assert/strict";
import test from "node:test";

import { accountServiceTest, formatComputeBalance, saveCurrentAccountName } from "../miniprogram/services/accountService";

test("空白或超长称呼在请求云端前给出输入提示，合法称呼仍交给云端审核", async context => {
  const previousWx = (globalThis as any).wx;
  const calls: Array<{ name: string; data: { action: string; displayName: string } }> = [];
  (globalThis as any).wx = { cloud: { callFunction: async (request: typeof calls[number]) => {
    calls.push(request);
    return { result: { accountLinked: false, profileError: { message: "这个称呼暂时不能使用" } } };
  } } };
  context.after(() => { (globalThis as any).wx = previousWx; });
  for (const name of ["", " \n\t "]) {
    await assert.rejects(saveCurrentAccountName(name), /请告诉我们怎么称呼你/);
  }
  await assert.rejects(saveCurrentAccountName("一二三四五六七八九"), /称呼最多 8 个字/);
  assert.equal(calls.length, 0);
  await assert.rejects(saveCurrentAccountName("  小禾   同学  "), /这个称呼暂时不能使用/);
  assert.deepEqual(calls, [{ name: "getOpenId", data: { action: "updateProfile", displayName: "小禾 同学" } }]);
});

test("账号服务只接受已完成服务端绑定的微信身份", () => {
  const account = accountServiceTest.parseAccount({
    accountLinked: true,
    account: {
      accountId: "account_123",
      primaryFamilyId: "family_123",
      displayName: "岱",
      avatarText: "岱",
      profileComplete: true,
      computeBalanceMicros: 10_000_000,
    },
  });
  assert.equal(account.displayName, "岱");
  assert.equal(account.profileComplete, true);
  assert.equal(account.computeBalanceMicros, 10_000_000);
  assert.equal(account.computeRate, "");
  assert.throws(() => accountServiceTest.parseAccount({ accountLinked: false }), /暂未关联/);
});

test("称呼被内容安全拒绝或检查不可用时，把服务端的原因原样告诉用户", () => {
  assert.throws(
    () => accountServiceTest.parseAccount({ accountLinked: false, profileError: { code: "PROFILE_NAME_REJECTED", message: "这个称呼暂时不能使用" } }),
    /这个称呼暂时不能使用/,
  );
  assert.throws(
    () => accountServiceTest.parseAccount({ accountLinked: false, profileError: { code: "PROFILE_CHECK_UNAVAILABLE", message: "暂时无法检查这个称呼，请稍后再试" } }),
    /稍后再试/,
  );
  assert.throws(() => accountServiceTest.parseAccount({ accountLinked: false, profileError: {} }), /暂未关联/);
});

test("算力余额固定显示两位小数且不多显示不可用额度", () => {
  assert.equal(formatComputeBalance(10_000_000), "10.00 算力");
  assert.equal(formatComputeBalance(409_999), "0.40 算力");
  assert.equal(formatComputeBalance(-1), "0.00 算力");
});
