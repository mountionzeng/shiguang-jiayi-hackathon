import type { ShiguangAppOptions } from "../app";
import {
  BiographyDraft,
  FamilyMember,
  FamilyRoomState,
  MemoryContribution,
} from "../domain/biography";
import { CLOUD_DATABASE_ENABLED } from "../config/runtime";
import { MemberKind } from "./memberLifecycle";
import {
  addCloudFamilyMember,
  appendCloudContribution,
  appendCloudContributions,
  classifyCloudMember,
  deleteCloudContribution,
  deleteCloudStory,
  deleteCloudMember,
  restoreCloudMember,
  updateCloudMember,
  restoreCloudStory,
  softDeleteCloudMemory,
  restoreCloudMemory,
  loadCloudRoomState,
  replaceCloudContribution,
  resetCloudCurrentUserRoom,
  saveCloudDraftIfSourcesUnchanged,
  saveCloudPersonalDraftIfSourcesUnchanged,
  updateCloudPersonalShareTargets,
} from "./cloudRoomStorage";
import {
  addFamilyMember,
  appendContribution,
  classifyMember,
  deleteContribution,
  deleteStory,
  deleteMember,
  restoreMember,
  updateMember,
  restoreStory,
  softDeleteMemory,
  restoreMemory,
  loadCurrentMember,
  saveCurrentMemberId,
  loadRoomState,
  replaceContribution,
  resetCurrentRoom,
  saveDraftIfSourcesUnchanged,
  savePersonalDraftIfSourcesUnchanged,
  updatePersonalShareTargets,
} from "./roomStorage";

function shouldUseCloudDatabase(): boolean {
  if (!CLOUD_DATABASE_ENABLED || !wx.cloud) return false;
  const app = getApp<ShiguangAppOptions>();
  if (!app.globalData.cloudReady) throw new Error("云端连接尚未就绪，请重新打开小程序后重试");
  return true;
}

export const usesCloudStorage = shouldUseCloudDatabase;

export function roomDataModeLabel(): string {
  return shouldUseCloudDatabase() ? "数据：微信云端" : "数据：本机存储";
}

export async function loadRoomStateRemoteFirst(): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    return await loadCloudRoomState();
  }

  return loadRoomState();
}

export async function loadCurrentMemberRemoteFirst(
  state?: FamilyRoomState,
): Promise<FamilyMember> {
  return loadCurrentMember(state ?? (await loadRoomStateRemoteFirst()));
}

export function saveCurrentMemberIdLocal(memberId: string): void {
  saveCurrentMemberId(memberId);
}

export async function appendContributionRemoteFirst(
  contribution: MemoryContribution,
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    return await appendCloudContribution(contribution);
  }

  return appendContribution(contribution, loadRoomState());
}

export async function appendContributionsRemoteFirst(
  contributions: MemoryContribution[],
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) return appendCloudContributions(contributions);
  return contributions.reduce((state, contribution) => appendContribution(contribution, state), loadRoomState());
}

export async function addFamilyMemberRemoteFirst(
  name: string,
  relation: string,
  kind?: FamilyMember["kind"],
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    return await addCloudFamilyMember(name, relation, kind);
  }

  return addFamilyMember(name, relation, loadRoomState(), kind);
}

export async function replaceContributionRemoteFirst(
  contribution: MemoryContribution,
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    return await replaceCloudContribution(contribution);
  }

  return replaceContribution(contribution, loadRoomState());
}

export async function deleteContributionRemoteFirst(
  contributionId: string,
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    return await deleteCloudContribution(contributionId);
  }

  return deleteContribution(contributionId, loadRoomState());
}

/** 软删除；随时可以恢复。真正永久删除用 deleteContributionRemoteFirst（例如清空「最近删除」）。 */
export async function softDeleteMemoryRemoteFirst(contributionId: string): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) return await softDeleteCloudMemory(contributionId);
  return softDeleteMemory(contributionId);
}

export async function restoreMemoryRemoteFirst(contributionId: string): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) return await restoreCloudMemory(contributionId);
  return restoreMemory(contributionId);
}

/**
 * 永久删除：一条已经在「最近删除」里的记忆，真正从本机/云端拿掉，不能再恢复。
 * 复用 deleteContributionRemoteFirst 现成的硬删除；只是限定调用点在「最近删除」页里，
 * 不在日常的「删除」按钮上——日常删除请用 softDeleteMemoryRemoteFirst。
 */
export async function purgeMemoryRemoteFirst(contributionId: string): Promise<FamilyRoomState> {
  return deleteContributionRemoteFirst(contributionId);
}

/**
 * 清空「最近删除」：把所有已经软删除的记忆逐条永久删除。故事目前没有单独的永久删除——
 * 软删除（放进 deletedStories）已经是它能达到的最彻底状态，等以后 stories 变成真正的
 * 集合再补。一条失败不影响其它条，返回处理到的最新状态。
 */
export async function purgeAllDeletedMemoriesRemoteFirst(): Promise<FamilyRoomState> {
  let state = shouldUseCloudDatabase() ? await loadCloudRoomState() : loadRoomState();
  const deletedIds = state.contributions.filter((item) => item.deletedAt).map((item) => item.id);
  for (const contributionId of deletedIds) {
    state = await purgeMemoryRemoteFirst(contributionId);
  }
  return state;
}

export async function deleteStoryRemoteFirst(key: string, title: string): Promise<FamilyRoomState> {
  if (key.startsWith('story-')) {
    const {storyCommand,operationId,activeStory} = await import('./storyBooks');
    const story = activeStory(await loadRoomStateRemoteFirst(),key);
    return storyCommand({action:'delete',storyId:key,expectedVersion:story.version,requestId:operationId()});
  }
  if (shouldUseCloudDatabase()) return await deleteCloudStory(key, title);
  return deleteStory(key, title);
}

export async function restoreStoryRemoteFirst(key: string): Promise<FamilyRoomState> {
  if (key.startsWith('story-')) {
    const {storyCommand,operationId,activeStory} = await import('./storyBooks');
    const story = activeStory(await loadRoomStateRemoteFirst(),key,true);
    return storyCommand({action:'restore',storyId:key,expectedVersion:story.version,requestId:operationId()});
  }
  if (shouldUseCloudDatabase()) return await restoreCloudStory(key);
  return restoreStory(key);
}

export async function saveDraftIfSourcesUnchangedRemoteFirst(
  draft: BiographyDraft,
  sourceFingerprint: string,
): Promise<FamilyRoomState | undefined> {
  if (shouldUseCloudDatabase()) {
    return await saveCloudDraftIfSourcesUnchanged(draft, sourceFingerprint);
  }

  return saveDraftIfSourcesUnchanged(draft, sourceFingerprint, loadRoomState());
}

export async function savePersonalDraftIfSourcesUnchangedRemoteFirst(
  draft: BiographyDraft,
  sourceFingerprint: string,
  memberId: string,
): Promise<FamilyRoomState | undefined> {
  if (shouldUseCloudDatabase()) {
    return await saveCloudPersonalDraftIfSourcesUnchanged(draft, sourceFingerprint, memberId);
  }

  return savePersonalDraftIfSourcesUnchanged(
    draft,
    sourceFingerprint,
    memberId,
    loadRoomState(),
  );
}

export async function updatePersonalShareTargetsRemoteFirst(
  contributionId: string,
  actor: FamilyMember,
  targetMemberIds: string[],
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    return await updateCloudPersonalShareTargets(contributionId, actor, targetMemberIds);
  }

  return updatePersonalShareTargets(contributionId, actor, targetMemberIds);
}

/** Sort a legacy record into a recording profile or a person; only its kind changes. */
export async function classifyMemberRemoteFirst(memberId: string, kind: MemberKind): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) return await classifyCloudMember(memberId, kind);
  return classifyMember(memberId, kind);
}

/** Soft delete; safe to retry. The current profile is refused. */
export async function deleteMemberRemoteFirst(memberId: string): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) return await deleteCloudMember(memberId);
  return deleteMember(memberId);
}

export async function restoreMemberRemoteFirst(memberId: string): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) return await restoreCloudMember(memberId);
  return restoreMember(memberId);
}

export async function updateMemberRemoteFirst(
  memberId: string,
  name: string,
  relation: string,
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) return await updateCloudMember(memberId, name, relation);
  return updateMember(memberId, name, relation);
}

export async function resetCurrentUserRoomRemoteFirst(): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    return await resetCloudCurrentUserRoom();
  }

  return resetCurrentRoom();
}
