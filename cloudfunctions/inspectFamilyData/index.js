const cloud = require("wx-server-sdk");

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
};

function sanitizeDocumentPart(value) {
  return String(value).replace(/[^0-9A-Za-z_-]/g, "_");
}

function currentFamilyId(openid) {
  return `family_${sanitizeDocumentPart(openid)}`;
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

async function main() {
  const context = cloud.getWXContext();
  const openid = String(context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");

  const userFamilyId = currentFamilyId(openid);
  const [currentUser, demoFamily] = await Promise.all([
    inspectFamilyId(userFamilyId),
    inspectFamilyId(DEMO_FAMILY_ID),
  ]);

  return {
    ok: true,
    userFamilyId,
    demoFamilyId: DEMO_FAMILY_ID,
    currentUser,
    demoFamily,
  };
}

module.exports = { main };
