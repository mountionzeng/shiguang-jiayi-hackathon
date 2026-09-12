import assert from "node:assert/strict";
import test from "node:test";

import { accountServiceTest } from "../miniprogram/services/accountService";

test("账号服务只接受已完成服务端绑定的微信身份", () => {
  const account = accountServiceTest.parseAccount({
    accountLinked: true,
    account: {
      accountId: "account_123",
      primaryFamilyId: "family_123",
      displayName: "岱",
      avatarText: "岱",
      profileComplete: true,
    },
  });
  assert.equal(account.displayName, "岱");
  assert.equal(account.profileComplete, true);
  assert.throws(() => accountServiceTest.parseAccount({ accountLinked: false }), /暂未关联/);
});
