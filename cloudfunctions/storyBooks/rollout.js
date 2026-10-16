/*
 * 灰度放行：名单里的家庭，或者被邀请接纳过的家庭。
 *
 * 接纳记录只用来「通过灰度检查」，不授予任何数据权限。读章节、收副本、改稿
 * 仍然要有主人签发的章节授权；写自己的副本只作用于自己的空间。
 * 接纳记录由 inviteAccept 在同一个事务里写入，客户端不能直写。
 */
const ADMISSIONS = 'story_rollout_admissions';

async function isAdmitted(reader, familyId) {
  const record = await reader.get(ADMISSIONS, familyId);
  return record?.status === 'active' && record.familyId === familyId;
}

async function isRolledOut(reader, canary, familyId) {
  return canary.has(familyId) || await isAdmitted(reader, familyId);
}

module.exports = { ADMISSIONS, isAdmitted, isRolledOut };
