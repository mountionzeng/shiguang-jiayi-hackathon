const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const guard = require("../cloudfunctions/chatInterview/aiGuard.js");

function databaseFixture(records) {
  const db = {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              const value = records.get(`${name}:${id}`);
              if (!value) throw new Error("not found");
              return { data: value };
            },
            async update({ data }) {
              const key = `${name}:${id}`;
              const current = records.get(key);
              if (!current) throw new Error("not found");
              records.set(key, { ...current, ...data });
            },
            async set({ data }) {
              records.set(`${name}:${id}`, { ...data });
            },
          };
        },
      };
    },
    async runTransaction(operation) { return operation(db); },
  };
  return db;
}

function withEnvironment(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  });
  return Promise.resolve().then(run).finally(() => {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });
}

test("AI cloud functions carry their own guard module for independent deployment", () => {
  for (const name of ["chatInterview", "generateBiography", "organizeMemory"]) {
    const source = fs.readFileSync(path.join(__dirname, `../cloudfunctions/${name}/aiGuard.js`), "utf8");
    assert.match(source, /resolveActiveIdentity/);
    assert.doesNotMatch(source, /require\(["']\.\.\//, `${name} cannot depend on a sibling cloud function`);
  }
});

test("AI identity follows the migrated account mapping and fails after revocation", async () => {
  const appId = "wx86ae3e9d507ce52d";
  const openid = "new-enterprise-openid";
  const accountDocumentId = guard.accountDocumentIdFor(openid);
  const accountId = "account_111111111111111111111111";
  const familyId = "family_old-stable-room";
  const records = new Map([
    [`user_accounts:${accountDocumentId}`, { accountId, primaryFamilyId: familyId, wxOpenId: openid, status: "active" }],
    [`families:${familyId}`, { ownerAccountId: accountId }],
  ]);
  const db = databaseFixture(records);

  await withEnvironment({ WECHAT_APP_ID: appId }, async () => {
    const identity = await guard.resolveActiveIdentity(db, { APPID: appId, OPENID: openid });
    assert.equal(identity.familyId, familyId);
    assert.notEqual(identity.familyId, `family_${openid}`);
    records.get(`user_accounts:${accountDocumentId}`).status = "revoked";
    await assert.rejects(() => guard.assertIdentityStillActive(db, identity), /权限已经变化/);
  });
});

test("AI usage reservations enforce a durable interval and daily ceiling", async () => {
  const openid = "rate-limited-openid";
  const accountDocumentId = guard.accountDocumentIdFor(openid);
  const identity = {
    openid,
    accountDocumentId,
    accountId: "account_222222222222222222222222",
    familyId: "family_rate-room",
  };
  const records = new Map([[`user_accounts:${accountDocumentId}`, {
    accountId: identity.accountId,
    primaryFamilyId: identity.familyId,
    wxOpenId: openid,
    status: "active",
  }]]);
  const db = databaseFixture(records);

  await withEnvironment({ AI_DAILY_REQUEST_LIMIT: 2, AI_MIN_INTERVAL_MS: 1000 }, async () => {
    await guard.reserveAiRequest(db, identity, "chatInterview", 10_000);
    await assert.rejects(() => guard.reserveAiRequest(db, identity, "chatInterview", 10_500), /操作太频繁/);
    await guard.reserveAiRequest(db, identity, "organizeMemory", 11_000);
    await assert.rejects(() => guard.reserveAiRequest(db, identity, "generateBiography", 12_000), /使用次数已达到上限/);
  });
});

test("AI moderation checks every chunk and fails closed", async () => {
  const calls = [];
  const cloud = { openapi: { security: { msgSecCheck: async request => {
    calls.push(request);
    return { result: { suggest: "pass" } };
  } } } };
  await guard.moderateText(cloud, "openid-a", "字".repeat(2_600), "标题");
  assert.equal(calls.length, 2);
  assert.equal(Array.from(calls[0].content).length, 2_500);
  assert.equal(calls[1].title, undefined);

  const risky = { openapi: { security: { msgSecCheck: async () => ({ result: { suggest: "risky" } }) } } };
  await assert.rejects(() => guard.moderateText(risky, "openid-a", "不安全内容"), /暂时不能交给 AI/);
  await assert.rejects(() => guard.moderateText({}, "openid-a", "普通内容"), /检查暂时不可用/);
});

test("AI moderation reuses same-day hashed verdicts without storing the checked text", async () => {
  for (const name of ["chatInterview", "generateBiography", "organizeMemory", "personalMemory"]) {
    const deployedGuard = require(`../cloudfunctions/${name}/aiGuard.js`);
    const records = new Map();
    const db = databaseFixture(records);
    let passCalls = 0;
    const passCloud = { openapi: { security: { msgSecCheck: async () => {
      passCalls += 1;
      return { result: { suggest: "pass" } };
    } } } };

    await deployedGuard.moderateText(passCloud, "openid-a", "重复的安全文本", "缓存标题", { db, nowMs: 1_800_000 });
    await deployedGuard.moderateText(passCloud, "openid-a", "重复的安全文本", "缓存标题", { db, nowMs: 1_900_000 });
    assert.equal(passCalls, 1, `${name} should not spend quota for the same same-day text twice`);
    assert.doesNotMatch(JSON.stringify([...records]), /重复的安全文本|缓存标题|openid-a/);

    await deployedGuard.moderateText(passCloud, "openid-a", "重复的安全文本", "缓存标题", { db, nowMs: 90_000_000 });
    assert.equal(passCalls, 2, `${name} should re-check on a different China day`);

    let riskyCalls = 0;
    const riskyCloud = { openapi: { security: { msgSecCheck: async () => {
      riskyCalls += 1;
      return { result: { suggest: "risky" } };
    } } } };
    await assert.rejects(
      () => deployedGuard.moderateText(riskyCloud, "openid-a", "重复的风险文本", "缓存标题", { db, nowMs: 2_000_000 }),
      /暂时不能交给 AI/,
    );
    const failIfCalled = { openapi: { security: { msgSecCheck: async () => { throw new Error("should not call provider"); } } } };
    await assert.rejects(
      () => deployedGuard.moderateText(failIfCalled, "openid-a", "重复的风险文本", "缓存标题", { db, nowMs: 2_100_000 }),
      /暂时不能交给 AI/,
    );
    assert.equal(riskyCalls, 1, `${name} should reuse same-day rejected verdicts`);
  }
});

test("AI moderation falls back to paid Tencent moderation when WeChat quota is exhausted", async () => {
  for (const name of ["chatInterview", "generateBiography", "organizeMemory", "personalMemory"]) {
    const deployedGuard = require(`../cloudfunctions/${name}/aiGuard.js`);
    const records = new Map();
    const db = databaseFixture(records);
    let wechatCalls = 0;
    let paidCalls = 0;
    const cloud = { openapi: { security: { msgSecCheck: async () => {
      wechatCalls += 1;
      throw { errCode: 45009, errMsg: "reach max api daily quota limit" };
    } } } };
    const paidModeration = async ({ content, dataId }) => {
      paidCalls += 1;
      assert.equal(content, "测试标题\n虚构的按量审核文本");
      assert.match(dataId, /^mod_[0-9a-f]{48}$/);
      return { available: true, status: "pass", suggestion: "Pass" };
    };

    await deployedGuard.moderateText(cloud, "openid-a", "虚构的按量审核文本", "测试标题", { db, nowMs: 2_000_000, paidModeration });
    await deployedGuard.moderateText(cloud, "openid-a", "虚构的按量审核文本", "测试标题", { db, nowMs: 2_100_000, paidModeration });
    assert.equal(wechatCalls, 1, `${name} should cache the paid pass verdict`);
    assert.equal(paidCalls, 1, `${name} should use paid moderation only once`);
    assert.match(JSON.stringify([...records]), /tencent-tms/);
    assert.doesNotMatch(JSON.stringify([...records]), /虚构的按量审核文本|测试标题|openid-a/);
  }
});

test("AI moderation keeps paid Review and Block results closed", async () => {
  const records = new Map();
  const db = databaseFixture(records);
  const cloud = { openapi: { security: { msgSecCheck: async () => {
    throw { errCode: 45009, errMsg: "reach max api daily quota limit" };
  } } } };
  const paidModeration = async () => ({ available: true, status: "reject", suggestion: "Review" });
  await assert.rejects(
    () => guard.moderateText(cloud, "openid-a", "需要复核的虚构文字", "测试标题", { db, nowMs: 2_000_000, paidModeration }),
    { code: "AI_CONTENT_REJECTED" },
  );
  await assert.rejects(
    () => guard.moderateText({}, "openid-a", "需要复核的虚构文字", "测试标题", { db, nowMs: 2_100_000, paidModeration }),
    { code: "AI_CONTENT_REJECTED" },
  );
});

test("AI moderation checks content beyond 10,000 code points", async () => {
  for (const name of ["chatInterview", "generateBiography", "organizeMemory"]) {
    const deployedGuard = require(`../cloudfunctions/${name}/aiGuard.js`);
    const calls = [];
    const cloud = { openapi: { security: { msgSecCheck: async request => {
      calls.push(request);
      return { result: { suggest: request.content.includes("尾部风险") ? "risky" : "pass" } };
    } } } };

    await assert.rejects(
      () => deployedGuard.moderateText(cloud, "openid-a", `${"🙂".repeat(10_001)}尾部风险`, "长文本"),
      /暂时不能交给 AI/,
    );
    assert.equal(calls.length, 5, `${name} must moderate the tail chunk`);
    assert.match(calls[4].content, /尾部风险$/);
  }
});

test("AI moderation distinguishes exhausted daily quota without logging private SDK details or retrying", async context => {
  const logs = [];
  const previousWarn = console.warn;
  console.warn = (...args) => logs.push(args);
  context.after(() => { console.warn = previousWarn; });
  for (const name of ["chatInterview", "organizeMemory", "personalMemory"]) {
    const deployedGuard = require(`../cloudfunctions/${name}/aiGuard.js`);
    for (const error of [
      { errCode: 45009, errMsg: "private request content" },
      { errcode: "45009", message: "private request content" },
      new Error("openapi.security.msgSecCheck:fail reach max api daily quota limit rid: private-request-id"),
    ]) {
      let calls = 0;
      const cloud = { openapi: { security: { msgSecCheck: async () => { calls += 1; throw error; } } } };
      await assert.rejects(() => deployedGuard.moderateText(cloud, "private-openid", "字".repeat(5001)), failure => {
        assert.equal(failure.code, "AI_CONTENT_CHECK_QUOTA_EXHAUSTED");
        assert.match(failure.message, /内容安全检查额度已用完/);
        return true;
      });
      assert.equal(calls, 1, "quota exhaustion must not trigger repeated checks");
    }
    const cloud = { openapi: { security: { msgSecCheck: async () => { throw { errCode: 45011, errMsg: "private-openid" }; } } } };
    await assert.rejects(() => deployedGuard.moderateText(cloud, "private-openid", "普通内容"), { code: "AI_CONTENT_CHECK_UNAVAILABLE" });
  }
  assert.doesNotMatch(JSON.stringify(logs), /private-|private request|普通内容/);
  assert.match(JSON.stringify(logs), /daily-quota-exhausted/);
});

test("the server release gate defaults closed", async () => {
  await withEnvironment({ AI_SERVER_RELEASE_READY: undefined }, async () => {
    assert.throws(() => guard.assertServerReady(), /尚未完成发布验收/);
  });
  await withEnvironment({ AI_SERVER_RELEASE_READY: "true" }, async () => {
    assert.doesNotThrow(() => guard.assertServerReady());
  });
});

test("AI consent version gate rejects missing or stale authorization and accepts current or newer", () => {
  for (const name of ["chatInterview", "generateBiography", "organizeMemory"]) {
    const deployedGuard = require(`../cloudfunctions/${name}/aiGuard.js`);
    assert.throws(() => deployedGuard.assertConsentVersion(undefined, 1), /请先同意在线 AI 使用授权/);
    assert.throws(() => deployedGuard.assertConsentVersion({}, 1), /请先同意在线 AI 使用授权/);
    assert.throws(() => deployedGuard.assertConsentVersion({ aiConsent: { version: 0 } }, 1), /请先同意在线 AI 使用授权/);
    assert.doesNotThrow(() => deployedGuard.assertConsentVersion({ aiConsent: { version: 1 } }, 1));
    assert.doesNotThrow(() => deployedGuard.assertConsentVersion({ aiConsent: { version: 2 } }, 1));
    assert.equal(deployedGuard.AI_CONSENT_VERSION, 1, `${name} must export the required consent version`);
  }
});

test("recordAiConsent writes version and acceptedAt onto the caller's user_accounts document", async () => {
  const recordAiConsent = require("../cloudfunctions/recordAiConsent/index.js");
  const openid = "consent-openid";
  const accountDocumentId = guard.accountDocumentIdFor(openid);
  const records = new Map([
    [`user_accounts:${accountDocumentId}`, { accountId: "account_111111111111111111111111", primaryFamilyId: "family_x", wxOpenId: openid, status: "active" }],
  ]);
  const db = databaseFixture(records);

  const result = await recordAiConsent.main({ version: 1 }, { skipGuard: true, db, openid });
  assert.equal(result.version, 1);
  assert.match(result.acceptedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(records.get(`user_accounts:${accountDocumentId}`).aiConsent, { version: 1, acceptedAt: result.acceptedAt });
});

test("recordAiConsent rejects a missing or non-positive version and an unlinked account", async () => {
  const recordAiConsent = require("../cloudfunctions/recordAiConsent/index.js");
  const db = databaseFixture(new Map());
  await assert.rejects(() => recordAiConsent.main({}, { skipGuard: true, db, openid: "any" }), /CONSENT_VERSION_REQUIRED/);
  await assert.rejects(() => recordAiConsent.main({ version: 0 }, { skipGuard: true, db, openid: "any" }), /CONSENT_VERSION_REQUIRED/);
  await assert.rejects(
    () => recordAiConsent.main({ version: 1 }, { skipGuard: true, db, openid: "unlinked-openid" }),
    /账号还没有关联到企业小程序/,
  );
});
