const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

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

async function removeFamilyDoc(familyId) {
  try {
    await db.collection(COLLECTIONS.families).doc(familyId).remove();
  } catch (error) {
    const message = String(error && error.errMsg ? error.errMsg : error);
    if (
      !collectionMissing(error) &&
      !message.includes("does not exist") &&
      !message.includes("document.remove:fail")
    ) {
      throw error;
    }
  }
}

async function clearCollectionByFamilyId(collectionName, familyId) {
  let removed = 0;
  while (true) {
    let response;
    try {
      response = await db.collection(collectionName).where({ familyId }).limit(100).get();
    } catch (error) {
      if (collectionMissing(error)) return removed;
      throw error;
    }
    const records = response.data || [];
    if (records.length === 0) return removed;
    await Promise.all(
      records
        .map((record) => record._id)
        .filter(Boolean)
        .map((id) => db.collection(collectionName).doc(id).remove()),
    );
    removed += records.length;
  }
}

async function countWhere(collectionName, familyId) {
  try {
    const response = await db.collection(collectionName).where({ familyId }).count();
    return response.total || 0;
  } catch (error) {
    if (collectionMissing(error)) return 0;
    throw error;
  }
}

async function inspectFamilyId(familyId) {
  const counts = {};
  await Promise.all(
    Object.entries(COLLECTIONS).map(async ([key, collectionName]) => {
      if (key === "families") {
        try {
          await db.collection(collectionName).doc(familyId).get();
          counts[key] = 1;
        } catch (error) {
          counts[key] = 0;
        }
        return;
      }
      counts[key] = await countWhere(collectionName, familyId);
    }),
  );
  return counts;
}

async function saveEmptyRoom(familyId) {
  await db.collection(COLLECTIONS.families).doc(familyId).set({
    data: {
      roomName: "我的拾光房间",
      protagonistName: "",
      updatedAt: db.serverDate(),
    },
  });
}

async function main() {
  const context = cloud.getWXContext();
  const openid = String(context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");

  const familyId = currentFamilyId(openid);
  await removeFamilyDoc(familyId);
  const removedCounts = {};
  await Promise.all(
    Object.entries(COLLECTIONS)
      .filter(([key]) => key !== "families")
      .map(async ([key, collectionName]) => {
        removedCounts[key] = await clearCollectionByFamilyId(collectionName, familyId);
      }),
  );
  await saveEmptyRoom(familyId);
  const afterResetCounts = await inspectFamilyId(familyId);

  return {
    ok: true,
    familyId,
    removedCounts,
    afterResetCounts,
  };
}

module.exports = { main };
