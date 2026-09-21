const cloud = require("wx-server-sdk");
const crypto = require("node:crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const DEMO_FAMILY_ID = "demo-family";

const COLLECTIONS = {
  families: "families",
  familyMembers: "family_members",
  sourceRecords: "source_records",
  memories: "memories",
  biographyDrafts: "biography_drafts",
  assets: "assets",
  aiTasks: "ai_tasks",
  generatedArtifacts: "generated_artifacts",
  imageJobs: "image_jobs",
  storyImages: "story_images",
  photos: "photos",
  photoCaptionLogs: "photo_caption_logs",
  stories: "stories",
  storyNames: "story_names",
  storyMigrationItems: "story_migration_items",
  storyImageLinks: "story_image_links",
  storyImageJobLinks: "story_image_job_links",
};

/*
 * familyId 由 openid 推导。原先用 replace 把非法字符悄悄换成下划线，
 * 这意味着两个不同的 openid 可能被洗成同一个 familyId——两个用户共用一个房间，
 * 故事互相串门。微信 openid 实际就是 [0-9A-Za-z_-]{28}，永远不触发替换，
 * 所以这是一个没有守卫的假设，正是用户变多以后才会咬人的那种。
 * 改为校验：不合规就报错，把一次静默的房间合并换成一声响亮的失败。
 * 与 drinkingTimeBridge/egress.js 已有的做法保持一致。
 */
function assertOpenid(openid) {
  if (typeof openid !== "string" || !/^[0-9A-Za-z_-]{1,128}$/.test(openid)) throw new Error("INVALID_OPENID");
  return openid;
}

/*
 * 这是诊断工具，返回全环境各集合的文档总数、demo 家庭与 legacy room 内容。
 * 原先没有任何调用方限制，任何登录用户都能调出来。用户自己那部分本就由
 * 调用方 openid 推导、只回给本人，不受影响；全环境信息则收进白名单。
 * 白名单放在云函数环境变量 INSPECT_ALLOWED_OPENIDS（逗号分隔），不写进代码。
 */
const INSPECT_ALLOWLIST = String(process.env.INSPECT_ALLOWED_OPENIDS || "")
  .split(",").map(value => value.trim()).filter(Boolean);
const canInspectEnvironment = openid => INSPECT_ALLOWLIST.includes(openid);

function currentFamilyId(openid) {
  return `family_${assertOpenid(openid)}`;
}

function collectionMissing(error) {
  const message = String(error && error.errMsg ? error.errMsg : error);
  return (
    message.includes("collection not exists") ||
    message.includes("Db or Table not exist") ||
    message.includes("DATABASE_COLLECTION_NOT_EXIST")
  );
}

async function countWhere(collectionName, query) {
  try {
    const response = await db.collection(collectionName).where(query).count();
    return response.total || 0;
  } catch (error) {
    if (collectionMissing(error)) return 0;
    throw error;
  }
}

async function familyDocExists(familyId) {
  try {
    await db.collection(COLLECTIONS.families).doc(familyId).get();
    return 1;
  } catch (error) {
    const message = String(error && error.errMsg ? error.errMsg : error);
    if (
      collectionMissing(error) ||
      message.includes("does not exist") ||
      message.includes("document.get:fail")
    ) {
      return 0;
    }
    throw error;
  }
}

async function familyMetadata(familyId) {
  try {
    const response = await db.collection(COLLECTIONS.families).doc(familyId).get();
    const family = response.data || {};
    return {
      exists: true,
      storyBooksStatus: family.storyBooks && family.storyBooks.status || null,
      storyBooksCursor: family.storyBooks && family.storyBooks.cursor || 0,
      storyBooksTotal: family.storyBooks && family.storyBooks.total || 0,
      hasOwnerAccountId: Boolean(family.ownerAccountId),
    };
  } catch (error) {
    const message = String(error && error.errMsg ? error.errMsg : error);
    if (collectionMissing(error) || message.includes("does not exist") || message.includes("document.get:fail")) {
      return { exists: false };
    }
    throw error;
  }
}

async function getDocument(collectionName, documentId) {
  try {
    return (await db.collection(collectionName).doc(documentId).get()).data;
  } catch (error) {
    const message = String(error && error.errMsg ? error.errMsg : error);
    if (collectionMissing(error) || message.includes("does not exist") || message.includes("document.get:fail")) return undefined;
    throw error;
  }
}

async function inspectIdentity(context, userFamilyId) {
  const appId = String(context.APPID || "");
  const openid = String(context.OPENID || "");
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  const accountId = `account_${hash(openid).slice(0, 24)}`;
  const aliasId = hash(JSON.stringify([appId, openid]));
  const [account, alias] = await Promise.all([
    getDocument("user_accounts", accountId),
    getDocument("story_identity_aliases", aliasId),
  ]);
  const principal = alias && alias.principalId
    ? await getDocument("story_principals", alias.principalId)
    : undefined;
  const identityFamilyId = principal && principal.familyId;
  return {
    accountExists: Boolean(account),
    aliasExists: Boolean(alias),
    principalExists: Boolean(principal),
    accountFamilyMatchesComputed: Boolean(account && account.primaryFamilyId === userFamilyId),
    storyFamilyMatchesAccount: Boolean(account && identityFamilyId && identityFamilyId === account.primaryFamilyId),
    storyFamilyMatchesComputed: Boolean(identityFamilyId && identityFamilyId === userFamilyId),
    storyFamily: identityFamilyId ? await inspectFamilyId(identityFamilyId) : null,
    storyFamilyMetadata: identityFamilyId ? await familyMetadata(identityFamilyId) : null,
  };
}

async function inspectStagedMigration(familyId) {
  const tables = ["stories", "story_names", "biography_drafts", "story_migration_items", "story_image_links", "story_image_job_links"];
  const rows = [];
  for (const table of tables) {
    let offset = 0;
    while (true) {
      const response = await db.collection(table).where({ familyId }).skip(offset).limit(100).get();
      rows.push(...response.data.filter(row => row.migrationSourceDigest && row.migrationDocumentId));
      if (response.data.length < 100) break;
      offset += 100;
    }
  }
  const stories = await db.collection("stories").where({ familyId }).limit(100).get();
  const pending = await db.collection("story_migration_items").where({ familyId }).limit(100).get();
  const pendingKinds = {};
  pending.data.forEach(row => {
    const kind = String(row.item && row.item.kind || "unknown");
    pendingKinds[kind] = (pendingKinds[kind] || 0) + 1;
  });
  return {
    count: rows.length,
    digestCount: new Set(rows.map(row => row.migrationSourceDigest)).size,
    documentIdsMatch: rows.every(row => row._id === row.migrationDocumentId),
    isFinalBatchShape: rows.length > 0 && rows.length % 80 !== 0,
    stories: {
      total: stories.data.length,
      active: stories.data.filter(row => !row.deletedAt).length,
      withRevision: stories.data.filter(row => row.currentRevisionId).length,
      linkedMemories: stories.data.reduce((sum, row) => sum + (Array.isArray(row.memoryIds) ? row.memoryIds.length : 0), 0),
    },
    pending: {
      total: pending.data.length,
      resolved: pending.data.filter(row => row.item && row.item.resolvedStoryId).length,
      kinds: pendingKinds,
      chapters: pending.data.filter(row => row.item && row.item.chapter).length,
      chaptersWithText: pending.data.filter(row => row.item && row.item.chapter &&
        Array.isArray(row.item.chapter.content) && row.item.chapter.content.some(block => String(block && block.text || "").trim())).length,
    },
  };
}

async function inspectFamilyId(familyId) {
  const counts = {
    families: await familyDocExists(familyId),
  };

  await Promise.all(
    Object.entries(COLLECTIONS)
      .filter(([key]) => key !== "families")
      .map(async ([key, collectionName]) => {
        counts[key] = await countWhere(collectionName, { familyId });
      }),
  );

  return counts;
}

async function countAll(collectionName) {
  try {
    const response = await db.collection(collectionName).count();
    return response.total || 0;
  } catch (error) {
    if (collectionMissing(error)) return 0;
    throw error;
  }
}

async function inspectLegacyRoom() {
  try {
    const response = await db.collection("family_rooms").doc("demo-room").get();
    const state = (response.data && response.data.state) || {};
    return {
      exists: true,
      members: Array.isArray(state.members) ? state.members.length : 0,
      memories: Array.isArray(state.contributions) ? state.contributions.length : 0,
      hasDraft: Boolean(state.draft),
      personalDrafts: state.personalDrafts && typeof state.personalDrafts === "object"
        ? Object.keys(state.personalDrafts).length
        : 0,
      manuscriptRevisions: Array.isArray(state.manuscriptRevisions)
        ? state.manuscriptRevisions.length
        : 0,
    };
  } catch (error) {
    const message = String(error && error.errMsg ? error.errMsg : error);
    if (
      collectionMissing(error) ||
      message.includes("does not exist") ||
      message.includes("document.get:fail")
    ) {
      return { exists: false };
    }
    throw error;
  }
}

async function main() {
  const context = cloud.getWXContext();
  const openid = String(context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");

  const userFamilyId = currentFamilyId(openid);
  const environmentAllowed = canInspectEnvironment(openid);
  const [currentUser, currentUserMetadata, stagedMigration, storyIdentity, demoFamily, legacyRoom, environmentTotals] = await Promise.all([
    inspectFamilyId(userFamilyId),
    familyMetadata(userFamilyId),
    inspectStagedMigration(userFamilyId),
    inspectIdentity(context, userFamilyId),
    environmentAllowed ? inspectFamilyId(DEMO_FAMILY_ID) : undefined,
    environmentAllowed ? inspectLegacyRoom() : undefined,
    environmentAllowed ? Promise.all(Object.entries(COLLECTIONS).map(async ([key, collectionName]) => [
      key,
      await countAll(collectionName),
    ])).then(entries => Object.fromEntries(entries)) : undefined,
  ]);

  return {
    ok: true,
    userFamilyId,
    demoFamilyId: DEMO_FAMILY_ID,
    environmentAllowed,
    currentUser,
    currentUserMetadata,
    stagedMigration,
    storyIdentity,
    demoFamily,
    legacyRoom,
    environmentTotals,
  };
}

module.exports = { main };
