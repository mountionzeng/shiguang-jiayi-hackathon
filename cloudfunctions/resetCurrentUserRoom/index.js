const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const COLLECTIONS = {
  stories: "stories",
  storyNames: "story_names",
  storyOperations: "story_operations",
  storyMigrationItems: "story_migration_items",
  families: "families",
  familyMembers: "family_members",
  sourceRecords: "source_records",
  memories: "memories",
  biographyDrafts: "biography_drafts",
  assets: "assets",
  aiTasks: "ai_tasks",
  generatedArtifacts: "generated_artifacts",
  familyInvitations: "family_invitations",
  familyAccess: "family_access",
  imageJobs: "image_jobs",
  storyImages: "story_images",
  storyImageLinks: "story_image_links",
  storyImageJobLinks: "story_image_job_links",
  audioOperations: "audio_operations",
  voiceProfiles: "voice_profiles",
  audioWorks: "audio_works",
  photos: "photos",
  photoCaptionLogs: "photo_caption_logs",
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

/** Fence media workers before record/file deletion; late CAS writes then cannot revive a work. */
async function fenceAudioFamily(familyId) {
  for(const [collectionName,patchFor] of [
    [COLLECTIONS.audioOperations,record=>({status:'cancelled',generation:Number(record.generation||0)+1,cancelledAt:db.serverDate()})],
    [COLLECTIONS.voiceProfiles,record=>({status:'disabled',generation:Number(record.generation||0)+1,disabledAt:db.serverDate()})],
  ]) {
    for(let offset=0;;offset+=100){
      let response;
      try{response=await db.collection(collectionName).where({familyId}).skip(offset).limit(100).get();}
      catch(error){if(collectionMissing(error)){response={data:[]};}else throw error;}
      const records=response.data||[];
      await Promise.all(records.map(record=>db.collection(collectionName).doc(record._id).update({data:patchFor(record)})));
      if(records.length<100)break;
    }
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

/** User photos have a display and small file; remove both before deleting their records. */
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

const CONFIRM_TEXT = "RESET_MY_ROOM";

/*
 * 2026-09-20 加锁。
 *
 * 这个函数会删除家庭文档、按 familyId 清空所有集合，并且 cloud.deleteFile
 * 真删云存储里的照片与配图文件。文件删掉就找不回来了——云开发的数据库回档
 * 只回数据库，不回存储桶。
 *
 * 它原先没有任何护栏：任何登录用户调一次，自己的全部内容立刻消失。
 * 线上那个真实房间正是被它清空过一次：saveEmptyRoom 写回的
 * roomName「我的拾光房间」与空的 protagonistName，与现场观测到的值完全一致。
 * 讽刺的是，同一个仓库里只删 demo 数据的 deleteDemoFamilyOnce 反而早就有确认口令。
 *
 * 现在的规矩：
 *   - 默认只预演，报告「会删掉什么」，一个字节都不动；
 *   - 真执行必须同时满足三件事：确认口令、指名道姓写出要清空的 familyId、
 *     以及在云控制台显式打开环境变量 ALLOW_ROOM_RESET=yes；
 *   - PROTECTED_FAMILY_IDS 里的房间一律拒绝，连开关打开也不行。
 */
async function main(event = {}) {
  const context = cloud.getWXContext();
  const openid = String(context.OPENID || "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");

  const familyId = currentFamilyId(openid);
  const protectedIds = String(process.env.PROTECTED_FAMILY_IDS || "")
    .split(",").map(value => value.trim()).filter(Boolean);

  if (protectedIds.includes(familyId)) {
    throw Object.assign(new Error("这个房间在保护名单里，拒绝重置"), { code: "ROOM_PROTECTED" });
  }

  if (event.confirm !== CONFIRM_TEXT || event.confirmFamilyId !== familyId) {
    const wouldRemove = await inspectFamilyId(familyId);
    return {
      ok: true,
      dryRun: true,
      familyId,
      wouldRemove,
      note: `只做了预演，没有删除任何东西。真要执行，需要 confirm="${CONFIRM_TEXT}"、confirmFamilyId="${familyId}"，并且云函数环境变量 ALLOW_ROOM_RESET=yes。`,
    };
  }

  if (String(process.env.ALLOW_ROOM_RESET || "") !== "yes") {
    throw Object.assign(new Error("房间重置开关未打开（ALLOW_ROOM_RESET）"), { code: "ROOM_RESET_DISABLED" });
  }

  await removeFamilyDoc(familyId);
  await fenceAudioFamily(familyId);
  const removedImageFiles = await removeStoryImageFiles(familyId);
  const removedPhotoFiles = await removePhotoFiles(familyId);
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
    removedImageFiles,
    removedPhotoFiles,
    afterResetCounts,
  };
}

module.exports = { main };
