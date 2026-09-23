const crypto = require("node:crypto");

const VERSION = 1;
const ID = /^[^/.\u0000-\u001f\u007f]{1,512}$/;
const OPENID = /^[0-9A-Za-z_-]{1,128}$/;
const APPID = /^wx[0-9A-Za-z_-]{1,80}$/;
const ACCOUNT_ID = /^account_[0-9a-f]{24}$/;
const FAMILY_ID = /^family_[0-9A-Za-z_-]{1,120}$/;

const MIGRATED_COLLECTIONS = Object.freeze([
  "family_members",
  "source_records",
  "memories",
  "biography_drafts",
  "stories",
  "story_names",
  "story_operations",
  "story_migration_items",
  "generated_artifacts",
  "image_jobs",
  "story_images",
  "story_image_links",
  "story_image_job_links",
  "photos",
  "photo_caption_logs",
]);

function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

function requireString(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function parseConfig(env, side) {
  const config = {
    side,
    secret: String(env.USER_DATA_MIGRATION_SECRET || ""),
    sourceAppId: requireString(env.USER_DATA_MIGRATION_SOURCE_APP_ID, APPID, "MIGRATION_CONFIG_INVALID"),
    sourceOpenid: requireString(env.USER_DATA_MIGRATION_SOURCE_OPENID, OPENID, "MIGRATION_CONFIG_INVALID"),
    sourceAccountId: requireString(env.USER_DATA_MIGRATION_SOURCE_ACCOUNT_ID, ACCOUNT_ID, "MIGRATION_CONFIG_INVALID"),
    sourceFamilyId: requireString(env.USER_DATA_MIGRATION_SOURCE_FAMILY_ID, FAMILY_ID, "MIGRATION_CONFIG_INVALID"),
    targetAppId: requireString(env.USER_DATA_MIGRATION_TARGET_APP_ID, APPID, "MIGRATION_CONFIG_INVALID"),
    targetOpenid: requireString(env.USER_DATA_MIGRATION_TARGET_OPENID, OPENID, "MIGRATION_CONFIG_INVALID"),
    targetAccountId: requireString(env.USER_DATA_MIGRATION_TARGET_ACCOUNT_ID, ACCOUNT_ID, "MIGRATION_CONFIG_INVALID"),
    targetFamilyId: requireString(env.USER_DATA_MIGRATION_TARGET_FAMILY_ID, FAMILY_ID, "MIGRATION_CONFIG_INVALID"),
  };
  if (config.secret.length < 32 || !["source", "target"].includes(side)) fail("MIGRATION_CONFIG_INVALID");
  return config;
}

function assertCaller(context, config) {
  const expectedAppId = config.side === "source" ? config.sourceAppId : config.targetAppId;
  const expectedOpenid = config.side === "source" ? config.sourceOpenid : config.targetOpenid;
  if (context?.APPID !== expectedAppId || context?.OPENID !== expectedOpenid) fail("MIGRATION_FORBIDDEN");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

const digest = value => crypto.createHash("sha256").update(stable(value)).digest("hex");
const signature = (secret, payload) => crypto.createHmac("sha256", secret).update(stable(payload)).digest("hex");
const jsonValue = value => JSON.parse(JSON.stringify(value));
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
}

function equalSignature(left, right) {
  if (!/^[0-9a-f]{64}$/.test(left || "") || !/^[0-9a-f]{64}$/.test(right || "")) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function unsignedEnvelope(envelope) {
  const { signature: ignored, ...payload } = envelope || {};
  return payload;
}

function signEnvelope(payload, secret) {
  const normalized = jsonValue(payload);
  return { ...normalized, signature: signature(secret, normalized) };
}

function verifyEnvelope(envelope, config) {
  if (!envelope || envelope.version !== VERSION || envelope.kind !== "shiguang-user-data-migration") fail("MIGRATION_PACKAGE_INVALID");
  const payload = unsignedEnvelope(envelope);
  if (!equalSignature(envelope.signature, signature(config.secret, payload))) fail("MIGRATION_SIGNATURE_INVALID");
  for (const key of ["sourceAppId", "sourceOpenid", "sourceAccountId", "sourceFamilyId", "targetAppId", "targetOpenid", "targetAccountId", "targetFamilyId"]) {
    if (payload[key] !== config[key]) fail("MIGRATION_PACKAGE_IDENTITY_MISMATCH");
  }
  if (!payload.sourceFamily || !Array.isArray(payload.collections) || !Array.isArray(payload.files)) fail("MIGRATION_PACKAGE_INVALID");
  normalizeSourceDocument("families", payload.sourceFamily, config);
  return payload;
}

function rewriteString(value, context) {
  if ((value.startsWith("{") || value.startsWith("[")) &&
      (value.includes(context.sourceFamilyId) || value.includes(context.sourceOpenid) || value.includes(context.sourceAccountId))) {
    try {
      return JSON.stringify(rewriteValue(JSON.parse(value), context));
    } catch (error) {
      // Fall through to the strict scalar rules. A non-JSON string that still
      // embeds a source identity is rejected after rewriting.
    }
  }
  if (context.fileMap.has(value)) return context.fileMap.get(value);
  if (value === context.sourceOpenid) return context.targetOpenid;
  if (value === context.sourceAccountId) return context.targetAccountId;
  if (value === context.sourceFamilyId) return context.targetFamilyId;
  if (value.startsWith(`${context.sourceFamilyId}_`) || value.startsWith(`${context.sourceFamilyId}__`)) return context.targetFamilyId + value.slice(context.sourceFamilyId.length);
  if (value.includes(context.sourceFamilyId) && /^[0-9A-Za-z_-]+$/.test(value)) return value.split(context.sourceFamilyId).join(context.targetFamilyId);
  return value;
}

function rewriteValue(value, context) {
  if (typeof value === "string") return rewriteString(value, context);
  if (Array.isArray(value)) return value.map(item => rewriteValue(item, context));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteValue(item, context)]));
}

function containsString(value, predicate) {
  if (typeof value === "string") return predicate(value);
  if (Array.isArray(value)) return value.some(item => containsString(item, predicate));
  return Boolean(value && typeof value === "object" && Object.values(value).some(item => containsString(item, predicate)));
}

function normalizeSourceDocument(collection, document, config) {
  if (!document || typeof document !== "object" || Array.isArray(document)) fail("MIGRATION_DOCUMENT_INVALID");
  requireString(document._id, ID, "MIGRATION_DOCUMENT_INVALID");
  const documentFamilyId = collection === "families" ? document._id : document.familyId;
  if (documentFamilyId !== config.sourceFamilyId) fail("MIGRATION_CROSS_FAMILY_DOCUMENT");
  const clone = cloneValue(document);
  if (collection === "photos") {
    if (clone._openid !== config.sourceOpenid) fail("MIGRATION_CROSS_ACCOUNT_DOCUMENT");
  }
  return clone;
}

function fillMissing(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return target;
  const output = cloneValue(target);
  for (const [key, value] of Object.entries(source)) {
    if (["_id", "_openid", "ownerAccountId", "familyId"].includes(key)) continue;
    if (output[key] === undefined) output[key] = cloneValue(value);
    else if (output[key] && value && typeof output[key] === "object" && typeof value === "object" && !Array.isArray(output[key]) && !Array.isArray(value)) {
      output[key] = fillMissing(output[key], value);
    }
  }
  return output;
}

function referencedCloudFiles(value, output = new Set()) {
  if (typeof value === "string" && value.startsWith("cloud://")) output.add(value);
  else if (Array.isArray(value)) value.forEach(item => referencedCloudFiles(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach(item => referencedCloudFiles(item, output));
  return output;
}

function targetDocumentId(sourceId, config) {
  return rewriteString(sourceId, { ...config, fileMap: new Map() });
}

function prepareDocuments(payload, config, fileMappings, allowedCollections = null) {
  const fileMap = new Map(fileMappings.map(item => [item.sourceFileID, item.targetFileID]));
  const seen = new Set();
  const prepared = [];
  for (const group of payload.collections) {
    if (!group || !MIGRATED_COLLECTIONS.includes(group.name) || !Array.isArray(group.documents)) fail("MIGRATION_PACKAGE_INVALID");
    if (allowedCollections && !allowedCollections.has(group.name)) continue;
    for (const source of group.documents) {
      const document = normalizeSourceDocument(group.name, source, config);
      const id = targetDocumentId(document._id, config);
      const key = `${group.name}:${id}`;
      if (seen.has(key)) fail("MIGRATION_DUPLICATE_DOCUMENT");
      seen.add(key);
      const rewritten = rewriteValue(document, { ...config, fileMap });
      rewritten._id = id;
      rewritten.familyId = config.targetFamilyId;
      if (group.name === "photos") rewritten._openid = config.targetOpenid;
      else delete rewritten._openid;
      if (containsString(rewritten, value => value.includes(config.sourceFamilyId) || value === config.sourceOpenid || value === config.sourceAccountId)) fail("MIGRATION_SOURCE_IDENTITY_REMAINS");
      const unmapped = [...referencedCloudFiles(rewritten)].filter(fileID => payload.files.some(file => file.sourceFileID === fileID));
      if (unmapped.length) fail("MIGRATION_FILE_UNMAPPED");
      prepared.push({ collection: group.name, id, sourceId: document._id, document: rewritten });
    }
  }
  return prepared;
}

function identityPlan(config) {
  const principalId = `principal_${digest(["user-data-migration", config.targetAccountId, config.targetFamilyId]).slice(0, 32)}`;
  const aliasId = digest([config.targetAppId, config.targetOpenid]);
  return { principalId, aliasId, spaceId: config.targetFamilyId };
}

function sanitizeForComparison(value) {
  if (Array.isArray(value)) return value.map(sanitizeForComparison);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["_openid", "_createTime", "_updateTime"].includes(key)).map(([key, item]) => [key, sanitizeForComparison(item)]));
}

function sameStableMember(existing, incoming) {
  const existingId = existing?.memberId || existing?.id;
  const incomingId = incoming?.memberId || incoming?.id;
  return typeof existingId === "string" && existingId === incomingId && existing.familyId === incoming.familyId;
}

function familyWritePlan(family, payload, config) {
  const sourceFamily = normalizeSourceDocument("families", payload.sourceFamily, config);
  const familyMerged = fillMissing(family, rewriteValue(sourceFamily, { ...config, fileMap: new Map() }));
  familyMerged._id = config.targetFamilyId;
  familyMerged._openid = config.targetOpenid;
  familyMerged.ownerAccountId = config.targetAccountId;
  return stable(sanitizeForComparison(familyMerged)) === stable(sanitizeForComparison(family)) ? null : familyMerged;
}

async function createImportPlan(repo, envelope, config, fileMappings = [], options = {}) {
  const payload = verifyEnvelope(envelope, config);
  const requiredFiles = payload.files.map(file => file.sourceFileID).sort();
  const mappingSources = fileMappings.map(file => file.sourceFileID).sort();
  if (new Set(mappingSources).size !== mappingSources.length || stable(requiredFiles) !== stable(mappingSources)) fail("MIGRATION_FILE_UNMAPPED");
  for (const mapping of fileMappings) {
    if (!mapping || typeof mapping.targetFileID !== "string" || !mapping.targetFileID.startsWith("cloud://") || mapping.targetFileID === mapping.sourceFileID) fail("MIGRATION_FILE_UNMAPPED");
  }
  let allowedCollections = null;
  if (Array.isArray(options.collections)) {
    allowedCollections = new Set(options.collections);
    if ([...allowedCollections].some(name => !MIGRATED_COLLECTIONS.includes(name))) fail("MIGRATION_PACKAGE_INVALID");
  }
  let documents = prepareDocuments(payload, config, fileMappings, allowedCollections);
  if (options.documentOffset !== undefined || options.documentLimit !== undefined) {
    const offset = Number(options.documentOffset ?? 0);
    const limit = Number(options.documentLimit ?? documents.length);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      fail("MIGRATION_PACKAGE_INVALID");
    }
    documents = documents.slice(offset, offset + limit);
  }
  const identity = identityPlan(config);
  let alias, principal, space, familyWrite = null;
  if (!options.skipIdentityChecks) {
    const [account, family, existingAlias, existingPrincipal, existingSpace] = await Promise.all([
      repo.get("user_accounts", config.targetAccountId), repo.get("families", config.targetFamilyId),
      repo.get("story_identity_aliases", identity.aliasId), repo.get("story_principals", identity.principalId),
      repo.get("story_principal_spaces", identity.spaceId),
    ]);
    alias = existingAlias;
    principal = existingPrincipal;
    space = existingSpace;
    if (!account || account.accountId !== config.targetAccountId || account.primaryFamilyId !== config.targetFamilyId || account.wxOpenId !== config.targetOpenid) fail("MIGRATION_TARGET_ACCOUNT_INVALID");
    if (!family || family._id !== config.targetFamilyId || family.ownerAccountId !== config.targetAccountId || family._openid !== config.targetOpenid) fail("MIGRATION_TARGET_FAMILY_INVALID");
    const expectedIdentity = {
      alias: { status: "active", appId: config.targetAppId, principalId: identity.principalId },
      principal: { status: "active", accountId: config.targetAccountId, familyId: config.targetFamilyId },
      space: { status: "active", principalId: identity.principalId, accountId: config.targetAccountId },
    };
    for (const [name, existing, expected] of [["alias", alias, expectedIdentity.alias], ["principal", principal, expectedIdentity.principal], ["space", space, expectedIdentity.space]]) {
      if (existing && Object.entries(expected).some(([key, value]) => existing[key] !== value)) fail("MIGRATION_IDENTITY_CONFLICT", name);
    }
    familyWrite = familyWritePlan(family, payload, config);
  }
  // Keep the read-only preflight below the Mini Program call timeout while
  // avoiding an unbounded burst against Cloud Database.
  let existingDocuments;
  if (typeof repo.all === "function" && !options.pointReads) {
    const names = [...new Set(documents.map(item => item.collection))];
    const groups = await Promise.all(names.map(async name => [name, await repo.all(name, config.targetFamilyId)]));
    const existingByKey = new Map(groups.flatMap(([name, rows]) => rows.map(row => [`${name}:${row._id}`, row])));
    existingDocuments = documents.map(item => existingByKey.get(`${item.collection}:${item.id}`));
  } else {
    existingDocuments = [];
    for (let offset = 0; offset < documents.length; offset += 20) {
      existingDocuments.push(...await Promise.all(documents.slice(offset, offset + 20)
        .map(item => repo.get(item.collection, item.id))));
    }
  }
  const writes = [], alreadyPresent = [], preservedExisting = [], conflicts = [];
  for (let index = 0; index < documents.length; index += 1) {
    const item = documents[index], existing = existingDocuments[index];
    if (!existing) writes.push(item);
    else if (stable(sanitizeForComparison(existing)) === stable(sanitizeForComparison(item.document))) alreadyPresent.push(item);
    else if (item.collection === "family_members" && sameStableMember(existing, item.document)) preservedExisting.push(item);
    else conflicts.push({ collection: item.collection, id: item.id, sourceId: item.sourceId });
  }
  if (conflicts.length) fail("MIGRATION_DOCUMENT_CONFLICT", stable(conflicts));
  return {
    version: VERSION,
    packageDigest: digest(unsignedEnvelope(envelope)),
    sourceFamilyId: config.sourceFamilyId,
    targetFamilyId: config.targetFamilyId,
    identity,
    identityWrites: options.skipIdentityChecks ? [] : [!alias && "alias", !principal && "principal", !space && "space"].filter(Boolean),
    familyWrite,
    documents, writes, alreadyPresent, preservedExisting, conflicts,
    counts: Object.fromEntries(MIGRATED_COLLECTIONS.map(name => [name, {
      package: documents.filter(item => item.collection === name).length,
      write: writes.filter(item => item.collection === name).length,
      existing: alreadyPresent.filter(item => item.collection === name).length,
      preserved: preservedExisting.filter(item => item.collection === name).length,
    }])),
    files: payload.files,
  };
}

module.exports = {
  VERSION, MIGRATED_COLLECTIONS, assertCaller, createImportPlan, digest, fail, familyWritePlan, identityPlan,
  parseConfig, prepareDocuments, referencedCloudFiles, signEnvelope, stable, verifyEnvelope,
};
