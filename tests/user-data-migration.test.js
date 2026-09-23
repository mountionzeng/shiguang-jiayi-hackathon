const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MIGRATED_COLLECTIONS, assertCaller, createImportPlan, parseConfig, signEnvelope,
} = require("../cloudfunctions/userDataMigration/core");

const env = {
  USER_DATA_MIGRATION_SECRET: "s".repeat(48),
  USER_DATA_MIGRATION_SOURCE_APP_ID: "wx-source",
  USER_DATA_MIGRATION_SOURCE_OPENID: "old-owner",
  USER_DATA_MIGRATION_SOURCE_ACCOUNT_ID: "account_111111111111111111111111",
  USER_DATA_MIGRATION_SOURCE_FAMILY_ID: "family_old-owner",
  USER_DATA_MIGRATION_TARGET_APP_ID: "wx-target",
  USER_DATA_MIGRATION_TARGET_OPENID: "new-owner",
  USER_DATA_MIGRATION_TARGET_ACCOUNT_ID: "account_222222222222222222222222",
  USER_DATA_MIGRATION_TARGET_FAMILY_ID: "family_new-owner",
};
const config = parseConfig(env, "target");

function packageWith(overrides = {}) {
  const groups = Object.fromEntries(MIGRATED_COLLECTIONS.map(name => [name, []]));
  groups.family_members.push({ _id: "family_old-owner_owner", familyId: "family_old-owner", memberId: "owner", name: "旧主人" });
  groups.memories.push({ _id: "family_old-owner_memory-old", familyId: "family_old-owner", id: "memory-old", text: "旧记忆", requesterOpenid: "old-owner", accountId: config.sourceAccountId });
  groups.source_records.push({ _id: "src_family_old-owner_memory-old", familyId: "family_old-owner", sourceRecordId: "src_family_old-owner_memory-old" });
  groups.biography_drafts.push({
    _id: "family_old-owner_revision-a", familyId: "family_old-owner", storyId: "story-a",
    revision: { id: "revision-a", storyId: "story-a", draft: { chapters: [{ id: "chapter-a", content: [{ photoId: "photo-a" }] }] } },
  });
  groups.stories.push({ _id: "family_old-owner_story-a", familyId: "family_old-owner", id: "story-a", currentRevisionId: "revision-a", memoryIds: ["memory-old"] });
  groups.story_operations.push({
    _id: "family_old-owner_operation-a",
    familyId: "family_old-owner",
    fingerprint: JSON.stringify({ familyId: "family_old-owner", requesterOpenid: "old-owner" }),
  });
  groups.photos.push({
    _id: "family_old-owner__photo-a", familyId: "family_old-owner", photoId: "photo-a", _openid: "old-owner",
    displayFileID: "cloud://old.bucket/user-photos/family_old-owner/photo-a/display.jpg",
  });
  const payload = {
    version: 1, kind: "shiguang-user-data-migration", exportedAt: "2026-09-22T00:00:00.000Z",
    sourceAppId: config.sourceAppId, sourceOpenid: config.sourceOpenid,
    sourceAccountId: config.sourceAccountId, sourceFamilyId: config.sourceFamilyId,
    targetAppId: config.targetAppId, targetOpenid: config.targetOpenid,
    targetAccountId: config.targetAccountId, targetFamilyId: config.targetFamilyId,
    sourceFamily: { _id: config.sourceFamilyId, _openid: config.sourceOpenid, ownerAccountId: config.sourceAccountId, name: "旧家庭", storyBooks: { status: "active", total: 48 } },
    collections: MIGRATED_COLLECTIONS.map(name => ({ name, documents: groups[name] })),
    files: [{
      sourceFileID: "cloud://old.bucket/user-photos/family_old-owner/photo-a/display.jpg",
      targetPath: "user-photos/family_new-owner/photo-a/display.jpg", bytes: 3, sha256: "a".repeat(64), base64: "YWJj",
    }],
    ...overrides,
  };
  return signEnvelope(payload, config.secret);
}

function fixture(extra = []) {
  const rows = new Map([
    ["user_accounts:account_222222222222222222222222", { _id: config.targetAccountId, accountId: config.targetAccountId, wxOpenId: config.targetOpenid, primaryFamilyId: config.targetFamilyId }],
    ["families:family_new-owner", { _id: config.targetFamilyId, _openid: config.targetOpenid, ownerAccountId: config.targetAccountId, name: "企业家庭" }],
    ["family_members:family_new-owner_owner", { _id: "family_new-owner_owner", familyId: config.targetFamilyId, memberId: "owner", name: "企业主人", role: "owner" }],
    ["memories:family_new-owner_enterprise-memory", { _id: "family_new-owner_enterprise-memory", familyId: config.targetFamilyId, text: "企业已有记忆" }],
    ["source_records:src_family_new-owner_enterprise-memory", { _id: "src_family_new-owner_enterprise-memory", familyId: config.targetFamilyId, text: "企业已有原始记录" }],
    ...extra,
  ]);
  return {
    rows,
    repo: {
      async get(collection, id) { return rows.get(`${collection}:${id}`); },
      async all(collection, familyId) {
        return [...rows.entries()]
          .filter(([key, value]) => key.startsWith(`${collection}:`) && value.familyId === familyId)
          .map(([, value]) => value);
      },
    },
  };
}

const mappings = [{
  sourceFileID: "cloud://old.bucket/user-photos/family_old-owner/photo-a/display.jpg",
  targetFileID: "cloud://new.bucket/user-photos/family_new-owner/photo-a/display.jpg",
}];

test("only the configured server-side WeChat context is authorized", () => {
  assert.doesNotThrow(() => assertCaller({ APPID: "wx-target", OPENID: "new-owner" }, config));
  for (const context of [
    { APPID: "wx-target", OPENID: "other-user" },
    { APPID: "wx-other", OPENID: "new-owner" },
  ]) assert.throws(() => assertCaller(context, config), { code: "MIGRATION_FORBIDDEN" });
  assert.doesNotThrow(() => assertCaller({ APPID: "wx-target", OPENID: "new-owner", familyId: "family_old-owner", claimedOpenid: "old-owner" }, config),
    "forged request fields do not replace the platform-owned APPID and OPENID");
});

test("dry-run rewrites every source family reference and preserves enterprise records", async () => {
  const { repo, rows } = fixture();
  const plan = await createImportPlan(repo, packageWith(), config, mappings);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.writes.length, 6);
  assert.equal(plan.preservedExisting.length, 1);
  assert.equal(plan.counts.family_members.preserved, 1);
  assert.equal(plan.familyWrite.name, "企业家庭", "target family values win");
  assert.deepEqual(plan.familyWrite.storyBooks, { status: "active", total: 48 }, "missing source metadata is merged");
  assert.equal(rows.get("memories:family_new-owner_enterprise-memory").text, "企业已有记忆");
  assert.equal(rows.get("source_records:src_family_new-owner_enterprise-memory").text, "企业已有原始记录");
  for (const item of plan.documents) {
    assert.equal(item.document.familyId, config.targetFamilyId);
    assert.ok(!JSON.stringify(item.document).includes(config.sourceFamilyId));
    assert.ok(!JSON.stringify(item.document).includes(config.sourceOpenid));
    assert.ok(!JSON.stringify(item.document).includes(config.sourceAccountId));
  }
  const memory = plan.documents.find(item => item.collection === "memories").document;
  assert.equal(memory.requesterOpenid, config.targetOpenid);
  assert.equal(memory.accountId, config.targetAccountId);
  const photo = plan.documents.find(item => item.collection === "photos").document;
  assert.equal(photo._openid, config.targetOpenid);
  assert.equal(photo.displayFileID, mappings[0].targetFileID);
  const operation = plan.documents.find(item => item.collection === "story_operations").document;
  assert.deepEqual(JSON.parse(operation.fingerprint), { familyId: config.targetFamilyId, requesterOpenid: config.targetOpenid });
});

test("collection dry-runs can be bounded into deterministic point-read batches", async () => {
  const { repo } = fixture();
  const reads = [];
  const pointRepo = {
    ...repo,
    async get(collection, id) {
      reads.push(collection);
      return repo.get(collection, id);
    },
  };
  const plan = await createImportPlan(pointRepo, packageWith(), config, mappings, {
    collections: ["stories"],
    pointReads: true,
    skipIdentityChecks: true,
    documentOffset: 0,
    documentLimit: 1,
  });
  assert.equal(plan.documents.length, 1);
  assert.equal(plan.documents[0].collection, "stories");
  assert.equal(plan.counts.stories.package, 1);
  assert.equal(plan.counts.memories.package, 0);
  assert.deepEqual(reads, ["stories"], "per-collection calls avoid repeating the separately completed identity preflight");
  assert.deepEqual(plan.identityWrites, []);
});

test("a signed package containing another family's document is rejected", async () => {
  const envelope = packageWith();
  const payload = { ...envelope };
  delete payload.signature;
  payload.collections = structuredClone(payload.collections);
  payload.collections.find(group => group.name === "stories").documents[0].familyId = "family_someone-else";
  const signed = signEnvelope(payload, config.secret);
  await assert.rejects(createImportPlan(fixture().repo, signed, config, mappings), { code: "MIGRATION_CROSS_FAMILY_DOCUMENT" });
});

test("tampering and missing photo mappings fail closed", async () => {
  const tampered = packageWith();
  tampered.collections[0].documents[0].name = "篡改";
  await assert.rejects(createImportPlan(fixture().repo, tampered, config, mappings), { code: "MIGRATION_SIGNATURE_INVALID" });
  await assert.rejects(createImportPlan(fixture().repo, packageWith(), config, []), { code: "MIGRATION_FILE_UNMAPPED" });
  await assert.rejects(createImportPlan(fixture().repo, packageWith(), config, [{ ...mappings[0], targetFileID: mappings[0].sourceFileID }]), { code: "MIGRATION_FILE_UNMAPPED" });
});

test("rerun is idempotent while a same-ID content conflict is reported", async () => {
  const first = await createImportPlan(fixture().repo, packageWith(), config, mappings);
  const exactRows = first.documents.map(item => [`${item.collection}:${item.id}`, structuredClone(item.document)]);
  const rerun = await createImportPlan(fixture(exactRows).repo, packageWith(), config, mappings);
  assert.equal(rerun.writes.length, 0);
  assert.equal(rerun.alreadyPresent.length, first.documents.length);

  const storyIndex = first.documents.findIndex(item => item.collection === "stories");
  const conflicting = structuredClone(exactRows[storyIndex][1]);
  conflicting.title = "企业同 ID 的另一条故事";
  await assert.rejects(createImportPlan(fixture([[exactRows[storyIndex][0], conflicting]]).repo, packageWith(), config, mappings), { code: "MIGRATION_DOCUMENT_CONFLICT" });
});

test("an existing identity can only point to this exact enterprise account and family", async () => {
  const probe = await createImportPlan(fixture().repo, packageWith(), config, mappings);
  const aliasKey = `story_identity_aliases:${probe.identity.aliasId}`;
  await assert.rejects(createImportPlan(fixture([[aliasKey, { status: "active", appId: config.targetAppId, principalId: "principal_ffffffffffffffffffffffffffffffff" }]]).repo, packageWith(), config, mappings), { code: "MIGRATION_IDENTITY_CONFLICT" });
});
