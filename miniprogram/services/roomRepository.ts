import type { ShiguangAppOptions } from "../app";
import {
  BiographyDraft,
  FamilyMember,
  FamilyRoomState,
  MemoryContribution,
} from "../domain/biography";
import { CLOUD_DATABASE_ENABLED } from "../config/runtime";
import {
  addCloudFamilyMember,
  appendCloudContribution,
  deleteCloudContribution,
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
  deleteContribution,
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

export async function resetCurrentUserRoomRemoteFirst(): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    return await resetCloudCurrentUserRoom();
  }

  return resetCurrentRoom();
}
