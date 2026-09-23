const cloud = require("wx-server-sdk");
const crypto = require("node:crypto");
const {
  VERSION, MIGRATED_COLLECTIONS, assertCaller, createImportPlan, digest, fail, familyWritePlan,
  identityPlan, parseConfig, referencedCloudFiles, signEnvelope, verifyEnvelope,
} = require("./core");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function missing(error) {
  return /does not exist|not found|cannot find document|DOCUMENT_NOT_EXIST/i.test(String(error?.message || error?.errMsg || error));
}

const repo = {
  async get(collection, id) {
    try { return (await db.collection(collection).doc(id).get()).data; }
    catch (error) { if (missing(error)) return undefined; throw error; }
  },
  async set(collection, id, document) {
    const { _id: ignored, ...data } = document;
    await db.collection(collection).doc(id).set({ data });
  },
  async update(collection, id, document) {
    const { _id: ignoredId, _openid: ignoredOpenid, ...data } = document;
    await db.collection(collection).doc(id).update({ data });
  },
  async all(collection, familyId) {
    const rows = [];
    for (let offset = 0; ; offset += 100) {
      const response = await db.collection(collection).where({ familyId }).orderBy("_id", "asc").skip(offset).limit(100).get();
      rows.push(...response.data);
      if (response.data.length < 100) return rows;
      if (rows.length >= 1000) fail("MIGRATION_EXPORT_TOO_LARGE");
    }
  },
};

function filePath(fileID, sourceFamilyId, targetFamilyId) {
  const slash = fileID.indexOf("/", "cloud://".length);
  if (slash < 0) fail("MIGRATION_FILE_INVALID");
  const sourcePath = fileID.slice(slash + 1);
  const marker = `/${sourceFamilyId}/`;
  if (!sourcePath.includes(marker)) fail("MIGRATION_CROSS_FAMILY_FILE");
  return sourcePath.replace(marker, `/${targetFamilyId}/`);
}

async function exportPackage(config) {
  const [sourceFamily, ...groups] = await Promise.all([
    repo.get("families", config.sourceFamilyId),
    ...MIGRATED_COLLECTIONS.map(async name => ({ name, documents: await repo.all(name, config.sourceFamilyId) })),
  ]);
  // Historical family shells can predate client-created `_openid`. The pinned
  // caller, account mapping and ownerAccountId remain mandatory; if `_openid`
  // exists it must still match the configured source account.
  if (!sourceFamily || sourceFamily._id !== config.sourceFamilyId ||
      (sourceFamily._openid !== undefined && sourceFamily._openid !== config.sourceOpenid) ||
      sourceFamily.ownerAccountId !== config.sourceAccountId) {
    fail("MIGRATION_SOURCE_IDENTITY_INVALID");
  }
  const account = await repo.get("user_accounts", config.sourceAccountId);
  if (!account || account.accountId !== config.sourceAccountId || account.primaryFamilyId !== config.sourceFamilyId || account.wxOpenId !== config.sourceOpenid) {
    fail("MIGRATION_SOURCE_IDENTITY_INVALID");
  }
  const documents = groups.flatMap(group => group.documents);
  if (documents.some(document => document.familyId !== config.sourceFamilyId)) fail("MIGRATION_CROSS_FAMILY_DOCUMENT");
  const fileIDs = [...referencedCloudFiles(documents)].sort();
  const files = [];
  let totalFileBytes = 0;
  for (const sourceFileID of fileIDs) {
    const downloaded = await cloud.downloadFile({ fileID: sourceFileID });
    const content = Buffer.from(downloaded.fileContent);
    totalFileBytes += content.length;
    if (totalFileBytes > 5 * 1024 * 1024) fail("MIGRATION_EXPORT_TOO_LARGE");
    files.push({
      sourceFileID,
      targetPath: filePath(sourceFileID, config.sourceFamilyId, config.targetFamilyId),
      bytes: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      base64: content.toString("base64"),
    });
  }
  const payload = {
    version: VERSION,
    kind: "shiguang-user-data-migration",
    exportedAt: new Date().toISOString(),
    sourceAppId: config.sourceAppId, sourceOpenid: config.sourceOpenid,
    sourceAccountId: config.sourceAccountId, sourceFamilyId: config.sourceFamilyId,
    targetAppId: config.targetAppId, targetOpenid: config.targetOpenid,
    targetAccountId: config.targetAccountId, targetFamilyId: config.targetFamilyId,
    sourceFamily,
    collections: groups,
    files,
  };
  return signEnvelope(payload, config.secret);
}

function placeholderMappings(payload) {
  return payload.files.map(file => ({
    sourceFileID: file.sourceFileID,
    targetFileID: `cloud://dry-run.invalid/${file.targetPath}`,
  }));
}

function summary(plan, dryRun, nextCursor = 0, complete = false) {
  return {
    ok: true, dryRun, packageDigest: plan.packageDigest,
    sourceFamilyId: plan.sourceFamilyId, targetFamilyId: plan.targetFamilyId,
    identity: plan.identity, identityWrites: plan.identityWrites,
    familyWillMerge: Boolean(plan.familyWrite),
    counts: plan.counts,
    files: plan.files.map(file => ({ sourceFileID: file.sourceFileID, targetPath: file.targetPath, bytes: file.bytes, sha256: file.sha256 })),
    totalWrites: plan.writes.length,
    alreadyPresent: plan.alreadyPresent.length,
    preservedExisting: plan.preservedExisting.length,
    nextCursor, complete,
  };
}

async function loadProgress(config, packageDigest) {
  const id = `${config.targetFamilyId}_migration_${packageDigest.slice(0, 32)}`;
  return { id, document: await repo.get("story_operations", id) };
}

async function uploadFiles(payload, config, progress) {
  const mappings = [...(progress.fileMappings || [])];
  const mapped = new Set(mappings.map(item => item.sourceFileID));
  for (const file of payload.files) {
    if (mapped.has(file.sourceFileID)) continue;
    const content = Buffer.from(file.base64, "base64");
    if (content.length !== file.bytes || crypto.createHash("sha256").update(content).digest("hex") !== file.sha256) fail("MIGRATION_FILE_INVALID");
    if (file.targetPath !== filePath(file.sourceFileID, config.sourceFamilyId, config.targetFamilyId)) fail("MIGRATION_FILE_INVALID");
    const uploaded = await cloud.uploadFile({ cloudPath: file.targetPath, fileContent: content });
    if (!uploaded?.fileID || uploaded.fileID === file.sourceFileID) fail("MIGRATION_FILE_UPLOAD_FAILED");
    mappings.push({ sourceFileID: file.sourceFileID, targetFileID: uploaded.fileID, targetPath: file.targetPath, bytes: file.bytes, sha256: file.sha256 });
  }
  return mappings;
}

async function writeIdentity(plan, config) {
  const createdAt = new Date().toISOString();
  const entries = {
    alias: ["story_identity_aliases", plan.identity.aliasId, { status: "active", appId: config.targetAppId, principalId: plan.identity.principalId, createdAt }],
    principal: ["story_principals", plan.identity.principalId, { status: "active", accountId: config.targetAccountId, familyId: config.targetFamilyId, createdAt }],
    space: ["story_principal_spaces", plan.identity.spaceId, { status: "active", principalId: plan.identity.principalId, accountId: config.targetAccountId, createdAt }],
  };
  for (const name of ["principal", "space", "alias"]) {
    if (plan.identityWrites.includes(name)) await repo.set(...entries[name]);
  }
}

async function applyPackage(envelope, config, event) {
  if (process.env.USER_DATA_MIGRATION_WRITE_ENABLED !== "true" || event.confirm !== "IMPORT_MY_LEGACY_DATA") fail("MIGRATION_WRITE_DISABLED");
  const payload = verifyEnvelope(envelope, config);
  const packageDigest = digest(payload);
  if (event.packageDigest !== packageDigest) fail("MIGRATION_CONFIRMATION_MISMATCH");
  const progressRef = await loadProgress(config, packageDigest);
  const progress = progressRef.document || { familyId: config.targetFamilyId, kind: "user-data-migration", packageDigest, cursor: 0, fileMappings: [], status: "pending" };
  const preflightMappings = progress.fileMappings.length === payload.files.length ? progress.fileMappings : placeholderMappings(payload);
  await createImportPlan(repo, envelope, config, preflightMappings);
  progress.fileMappings = await uploadFiles(payload, config, progress);
  const plan = await createImportPlan(repo, envelope, config, progress.fileMappings);
  await writeIdentity(plan, config);
  if (plan.familyWrite) await repo.update("families", config.targetFamilyId, plan.familyWrite);
  const batchSize = Math.max(1, Math.min(20, Number(event.batchSize) || 20));
  const remaining = plan.writes.slice(0, batchSize);
  for (const item of remaining) {
    const existing = await repo.get(item.collection, item.id);
    if (existing) fail("MIGRATION_DOCUMENT_CONFLICT");
    await repo.set(item.collection, item.id, item.document);
    progress.cursor += 1;
    progress.updatedAt = new Date().toISOString();
    await repo.set("story_operations", progressRef.id, progress);
  }
  const finalPlan = await createImportPlan(repo, envelope, config, progress.fileMappings);
  progress.status = finalPlan.writes.length === 0 ? "complete" : "pending";
  progress.updatedAt = new Date().toISOString();
  await repo.set("story_operations", progressRef.id, progress);
  return summary(finalPlan, false, progress.cursor, progress.status === "complete");
}

async function main(event = {}) {
  const role = String(process.env.USER_DATA_MIGRATION_ROLE || "");
  const action = String(event.action || "");
  const config = parseConfig(process.env, role);
  assertCaller(cloud.getWXContext(), config);
  if (role === "target" && action === "ping") return { ok: true, role, writeEnabled: process.env.USER_DATA_MIGRATION_WRITE_ENABLED === "true" };
  if (role === "source" && action === "export") return { ok: true, envelope: await exportPackage(config) };
  if (role === "target" && action === "dryRun") {
    const payload = verifyEnvelope(event.envelope, config);
    const progress = await loadProgress(config, digest(payload));
    const mappings = progress.document?.fileMappings?.length === payload.files.length ? progress.document.fileMappings : placeholderMappings(payload);
    const plan = await createImportPlan(repo, event.envelope, config, mappings);
    return summary(plan, true, progress.document?.cursor || 0, progress.document?.status === "complete");
  }
  if (role === "target" && action === "dryRunIdentity") {
    const payload = verifyEnvelope(event.envelope, config);
    const plan = await createImportPlan(repo, event.envelope, config, placeholderMappings(payload), { collections: [] });
    return summary(plan, true, 0, false);
  }
  if (role === "target" && action === "dryRunIdentityPart") {
    const part = String(event.part || "");
    const payload = verifyEnvelope(event.envelope, config);
    const identity = identityPlan(config);
    if (part === "account") {
      const account = await repo.get("user_accounts", config.targetAccountId);
      if (!account || account.accountId !== config.targetAccountId || account.primaryFamilyId !== config.targetFamilyId || account.wxOpenId !== config.targetOpenid) fail("MIGRATION_TARGET_ACCOUNT_INVALID");
      return { ok: true, part, valid: true };
    }
    if (part === "family") {
      const family = await repo.get("families", config.targetFamilyId);
      if (!family || family._id !== config.targetFamilyId || family.ownerAccountId !== config.targetAccountId || family._openid !== config.targetOpenid) fail("MIGRATION_TARGET_FAMILY_INVALID");
      return { ok: true, part, valid: true, familyWillMerge: Boolean(familyWritePlan(family, payload, config)) };
    }
    const definitions = {
      alias: ["story_identity_aliases", identity.aliasId, { status: "active", appId: config.targetAppId, principalId: identity.principalId }],
      principal: ["story_principals", identity.principalId, { status: "active", accountId: config.targetAccountId, familyId: config.targetFamilyId }],
      space: ["story_principal_spaces", identity.spaceId, { status: "active", principalId: identity.principalId, accountId: config.targetAccountId }],
    };
    if (!definitions[part]) fail("MIGRATION_PACKAGE_INVALID");
    const [collection, id, expected] = definitions[part];
    const existing = await repo.get(collection, id);
    if (existing && Object.entries(expected).some(([key, value]) => existing[key] !== value)) fail("MIGRATION_IDENTITY_CONFLICT", part);
    return { ok: true, part, valid: true, willWrite: !existing };
  }
  if (role === "target" && action === "dryRunCollection") {
    const collection = String(event.collection || "");
    if (!MIGRATED_COLLECTIONS.includes(collection)) fail("MIGRATION_PACKAGE_INVALID");
    const payload = verifyEnvelope(event.envelope, config);
    const mappings = placeholderMappings(payload);
    const plan = await createImportPlan(repo, event.envelope, config, mappings, {
      collections: [collection],
      pointReads: true,
      skipIdentityChecks: true,
      documentOffset: event.documentOffset,
      documentLimit: event.documentLimit,
    });
    return summary(plan, true, 0, false);
  }
  if (role === "target" && action === "apply") return applyPackage(event.envelope, config, event);
  fail("MIGRATION_ACTION_FORBIDDEN");
}

exports.main = async event => {
  try { return await main(event); }
  catch (error) { return { ok: false, error: error.code || "MIGRATION_FAILED", message: error.message || "迁移失败" }; }
};
exports.mainUnsafeForTests = main;
