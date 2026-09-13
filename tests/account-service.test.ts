import assert from "node:assert/strict";
import test from "node:test";

import { accountServiceTest, formatComputeBalance } from "../miniprogram/services/accountService";

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
  assert.equal(account.computeRate, "¥1 = 2 算力");
  assert.throws(() => accountServiceTest.parseAccount({ accountLinked: false }), /暂未关联/);
});

test("算力余额固定显示两位小数且不多显示不可用额度", () => {
  assert.equal(formatComputeBalance(10_000_000), "10.00 算力");
  assert.equal(formatComputeBalance(409_999), "0.40 算力");
  assert.equal(formatComputeBalance(-1), "0.00 算力");
});
