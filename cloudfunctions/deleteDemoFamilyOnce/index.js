const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const DEMO_FAMILY_ID = "demo-family";
const CONFIRM_TEXT = "DELETE_DEMO_FAMILY";

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
};

function collectionMissing(error) {
  const message = String(error && error.errMsg ? error.errMsg : error);
  return (
    message.includes("collection not exists") ||
    message.includes("Db or Table not exist") ||
    message.includes("DATABASE_COLLECTION_NOT_EXIST")
  );
}

async function removeFamilyDoc() {
  try {
    await db.collection(COLLECTIONS.families).doc(DEMO_FAMILY_ID).remove();
    return 1;
  } catch (error) {
    const message = String(error && error.errMsg ? error.errMsg : error);
    if (message.includes("does not exist") || message.includes("document.remove:fail")) {
      return 0;
    }
    throw error;
  }
}

async function clearCollectionByDemoFamilyId(collectionName) {
  let removed = 0;
  while (true) {
    let response;
    try {
      response = await db.collection(collectionName).where({ familyId: DEMO_FAMILY_ID }).limit(100).get();
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

/** Generated pictures live in cloud storage; delete the files before their records. */
async function removeStoryImageFiles(familyId) {
  let removed = 0;
  for (let offset = 0; ; offset += 100) {
    let response;
    try {
      response = await db.collection(COLLECTIONS.storyImages).where({ familyId }).skip(offset).limit(100).get();
    } catch (error) {
      if (collectionMissing(error)) return removed;
      throw error;
    }
    const records = response.data || [];
    const fileIDs = records.map((record) => record.fileID).filter(Boolean);
    for (let index = 0; index < fileIDs.length; index += 50) {
      await cloud.deleteFile({ fileList: fileIDs.slice(index, index + 50) });
    }
    removed += fileIDs.length;
    if (records.length < 100) return removed;
  }
}

async function removePhotoFiles(familyId) {
  let removed = 0;
  for (let offset = 0; ; offset += 100) {
    let response;
    try {
      response = await db.collection(COLLECTIONS.photos).where({ familyId }).skip(offset).limit(100).get();
    } catch (error) {
      if (collectionMissing(error)) return removed;
      throw error;
    }
    const records = response.data || [];
    const fileIDs = records.flatMap(record => [record.displayFileID, record.smallFileID]).filter(Boolean);
    for (let index = 0; index < fileIDs.length; index += 50) {
      await cloud.deleteFile({ fileList: fileIDs.slice(index, index + 50) });
    }
    removed += fileIDs.length;
    if (records.length < 100) return removed;
  }
}

async function main(event = {}) {
  if (event.confirm !== CONFIRM_TEXT) {
    throw new Error(`CONFIRM_REQUIRED:${CONFIRM_TEXT}`);
  }

  const removedCounts = {
    families: await removeFamilyDoc(),
    storyImageFiles: await removeStoryImageFiles(DEMO_FAMILY_ID),
    photoFiles: await removePhotoFiles(DEMO_FAMILY_ID),
  };

  await Promise.all(
    Object.entries(COLLECTIONS)
      .filter(([key]) => key !== "families")
      .map(async ([key, collectionName]) => {
        removedCounts[key] = await clearCollectionByDemoFamilyId(collectionName);
      }),
  );

  return {
    ok: true,
    deletedFamilyId: DEMO_FAMILY_ID,
    removedCounts,
  };
}

module.exports = { main };
