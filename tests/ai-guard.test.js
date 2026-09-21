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

test("the server release gate defaults closed", async () => {
  await withEnvironment({ AI_SERVER_RELEASE_READY: undefined }, async () => {
    assert.throws(() => guard.assertServerReady(), /尚未完成发布验收/);
  });
  await withEnvironment({ AI_SERVER_RELEASE_READY: "true" }, async () => {
    assert.doesNotThrow(() => guard.assertServerReady());
  });
});
