import type { ShiguangAppOptions } from "../app";
import { BiographyDraft, FamilyRoomState, MemoryContribution } from "../domain/biography";
import { CLOUD_DATABASE_ENABLED } from "../config/runtime";
import {
  appendCloudContribution,
  loadCloudRoomState,
  replaceCloudContribution,
  resetCloudDemoRoom,
  saveCloudDraftIfSourcesUnchanged,
} from "./cloudRoomStorage";
import {
  appendContribution,
  loadRoomState,
  replaceContribution,
  resetDemoRoom,
  saveDraftIfSourcesUnchanged,
} from "./roomStorage";

function shouldUseCloudDatabase(): boolean {
  if (!CLOUD_DATABASE_ENABLED || !wx.cloud) return false;
  const app = getApp<ShiguangAppOptions>();
  return Boolean(app.globalData.cloudReady);
}

export function roomDataModeLabel(): string {
  return shouldUseCloudDatabase() ? "数据：微信云端" : "数据：本地兜底";
}

export async function loadRoomStateRemoteFirst(): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    try {
      return await loadCloudRoomState();
    } catch (error) {
      console.warn("云端家庭房间不可用，将使用本地演示数据", error);
    }
  }

  return loadRoomState();
}

export async function appendContributionRemoteFirst(
  contribution: MemoryContribution,
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    try {
      return await appendCloudContribution(contribution);
    } catch (error) {
      console.warn("云端投稿保存失败，将临时保存到本地", error);
    }
  }

  return appendContribution(contribution, loadRoomState());
}

export async function replaceContributionRemoteFirst(
  contribution: MemoryContribution,
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    try {
      return await replaceCloudContribution(contribution);
    } catch (error) {
      console.warn("云端审核保存失败，将临时保存到本地", error);
    }
  }

  return replaceContribution(contribution, loadRoomState());
}

export async function saveDraftIfSourcesUnchangedRemoteFirst(
  draft: BiographyDraft,
  sourceFingerprint: string,
): Promise<FamilyRoomState | undefined> {
  if (shouldUseCloudDatabase()) {
    try {
      return await saveCloudDraftIfSourcesUnchanged(draft, sourceFingerprint);
    } catch (error) {
      console.warn("云端草稿保存失败，将临时保存到本地", error);
    }
  }

  return saveDraftIfSourcesUnchanged(draft, sourceFingerprint, loadRoomState());
}

export async function resetDemoRoomRemoteFirst(): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    try {
      return await resetCloudDemoRoom();
    } catch (error) {
      console.warn("云端重置失败，将重置本地演示数据", error);
    }
  }

  return resetDemoRoom();
}
