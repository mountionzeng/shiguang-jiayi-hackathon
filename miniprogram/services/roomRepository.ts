import { storyCommand, operationId, activeStory } from './storyBooks';
import { learnFromSavedMemory } from './personalMemory';
import { startPerformanceMeasure } from './performanceLog';
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
  updateCloudRoomProfile,
  restoreCloudStory,
  softDeleteCloudMemory,
  restoreCloudMemory,
  loadCloudRoomState,
  type RoomStateView,
  replaceCloudContribution,
  editCloudContribution,
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
  saveRoomState,
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

// The shelf and home already have a read-only, current-version projection in
// memory when a person taps a book. Hand it to the next book page once instead
// of making that page wait for the same state (and every historical revision)
// again. It is deliberately single-use: reopening a book always reads fresh
// cloud state, and an account switch cannot inherit an old snapshot.
let stagedBookState: FamilyRoomState | undefined;
let stagedStoriesState: FamilyRoomState | undefined;
let stagedRoomState: FamilyRoomState | undefined;

let stagedArchiveState: {id: string; state: FamilyRoomState} | undefined;

export function stageRoomStateForArchive(id: string, state: FamilyRoomState | undefined): void {
  stagedArchiveState = state ? {id, state} : undefined;
}

export function takeStagedRoomStateForArchive(id: string): FamilyRoomState | undefined {
  const staged = stagedArchiveState;
  stagedArchiveState = undefined;
  return staged?.id === id ? staged.state : undefined;
}

export function stageRoomStateForRoom(state: FamilyRoomState | undefined): void {
  stagedRoomState = state;
}

export function takeStagedRoomStateForRoom(): FamilyRoomState | undefined {
  const state = stagedRoomState;
  stagedRoomState = undefined;
  return state;
}

export function stageRoomStateForBook(state: FamilyRoomState | undefined): void {
  stagedBookState = state;
}

export function takeStagedRoomStateForBook(): FamilyRoomState | undefined {
  const state = stagedBookState;
  stagedBookState = undefined;
  return state;
}

// The two top-level story views can also share the state that is already on
// screen. This is single-use for the same reason as the book handoff above.
export function stageRoomStateForStories(state: FamilyRoomState | undefined): void {
  stagedStoriesState = state;
}

export function takeStagedRoomStateForStories(): FamilyRoomState | undefined {
  const state = stagedStoriesState;
  stagedStoriesState = undefined;
  return state;
}

export const usesCloudStorage = shouldUseCloudDatabase;

export function roomDataModeLabel(): string {
  return shouldUseCloudDatabase() ? "数据：微信云端" : "数据：本机存储";
}

export async function loadRoomStateRemoteFirst(options: { view?: RoomStateView } = {}): Promise<FamilyRoomState> {
  const finish = startPerformanceMeasure('room.load');
  let outcome: 'ok' | 'error' = 'error';
  let route: 'local' | 'cloud' | undefined;
  try {
    route = shouldUseCloudDatabase() ? 'cloud' : 'local';
    const state = route === 'cloud' ? await loadCloudRoomState(options) : loadRoomState();
    outcome = 'ok';
    return state;
  } finally {
    finish(outcome, { route });
  }
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
  options: { learn?: boolean } = {},
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    const state = await appendCloudContribution(contribution);
    if (options.learn !== false) learnFromSavedMemory(contribution);
    return state;
  }

  return appendContribution(contribution, loadRoomState());
}

export async function appendContributionsRemoteFirst(
  contributions: MemoryContribution[],
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    const state = await appendCloudContributions(contributions);
    contributions.forEach(learnFromSavedMemory);
    return state;
  }
  return contributions.reduce((state, contribution) => appendContribution(contribution, state), loadRoomState());
}

export async function addFamilyMemberRemoteFirst(
  name: string,
  relation: string,
  kind?: FamilyMember["kind"],
  options: { view?: "home" } = {},
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    return await addCloudFamilyMember(name, relation, kind, options);
  }

  return addFamilyMember(name, relation, loadRoomState(), kind);
}

export async function replaceContributionRemoteFirst(
  contribution: MemoryContribution,
  options: { view?: "memories" } = {},
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    const state = await replaceCloudContribution(contribution, options);
    learnFromSavedMemory(contribution);
    return state;
  }

  return replaceContribution(contribution, loadRoomState());
}

/** Read latest once, check conflicts in edit(), then save through the normal moderation path. */
export async function editContributionRemoteFirst(id: string, edit: (latest: MemoryContribution) => MemoryContribution, proposed?: MemoryContribution): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    const state = await editCloudContribution(id, edit, proposed);
    const saved = state.contributions.find(item => item.id === id);
    if (saved) learnFromSavedMemory(saved);
    return state;
  }
  const state = loadRoomState();
  const latest = state.contributions.find(item => item.id === id && !item.deletedAt);
  if (!latest) throw new Error("这段记忆已不存在，请刷新列表");
  const next = edit(latest);
  if (next.id !== id) throw new Error("记忆编号发生变化，请重新打开");
  return replaceContribution(next, state);
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
    const story = activeStory(await loadRoomStateRemoteFirst(),key);
    return storyCommand({action:'delete',storyId:key,expectedVersion:story.version,requestId:operationId()});
  }
  if (shouldUseCloudDatabase()) return await deleteCloudStory(key, title);
  return deleteStory(key, title);
}

export async function restoreStoryRemoteFirst(key: string): Promise<FamilyRoomState> {
  if (key.startsWith('story-')) {
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
export async function deleteMemberRemoteFirst(memberId: string, options: { view?: "home" } = {}): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) return await deleteCloudMember(memberId, undefined, options);
  return deleteMember(memberId);
}

/** 改记忆之家的名字与主人公名字。本地模式直接写本机状态。 */
export async function saveRoomProfileRemoteFirst(
  profile: { roomName?: string; protagonistName?: string },
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) return await updateCloudRoomProfile(profile);
  const next = { ...loadRoomState(), ...profile };
  saveRoomState(next);
  return next;
}

export async function restoreMemberRemoteFirst(memberId: string, options: { view?: "home" } = {}): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) return await restoreCloudMember(memberId, options);
  return restoreMember(memberId);
}

export async function updateMemberRemoteFirst(
  memberId: string,
  name: string,
  relation: string,
  options: { view?: "home" } = {},
): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) return await updateCloudMember(memberId, name, relation, options);
  return updateMember(memberId, name, relation);
}

export async function resetCurrentUserRoomRemoteFirst(): Promise<FamilyRoomState> {
  if (shouldUseCloudDatabase()) {
    return await resetCloudCurrentUserRoom();
  }

  return resetCurrentRoom();
}
