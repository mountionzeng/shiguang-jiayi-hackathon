import {
  biographySourceFingerprint,
  BiographyDraft,
  createEmptyRoomState,
  contributionRelatedMemberIds,
  contributionScope,
  FamilyMember,
  FamilyRoomState,
  DeletedStory,
  isActiveMember,
  isRecordingProfile,
  MemoryContribution,
  ManuscriptRevision,
  personalBookSourceFingerprint,
  personalShareTargetMemberIds,
  ReviewStatus,
  setPersonalShareTargets,
  Visibility,
} from "../domain/biography";
import {
  applyMemberChange,
  MemberChange,
  MemberKind,
  planClassify,
  planDelete,
  planRestore,
  planUpdateMember,
} from "./memberLifecycle";
import { planDeleteStory, planRestoreStory } from "./storyLifecycle";
import { planDeleteMemory, planRestoreMemory } from "./memoryLifecycle";
import { loadCurrentMember } from "./roomStorage";
import { checkTextContent } from "./contentSecurityService";

export const CLOUD_COLLECTIONS = {
  families: "families",
  familyMembers: "family_members",
  sourceRecords: "source_records",
  memories: "memories",
  biographyDrafts: "biography_drafts",
  assets: "assets",
  aiTasks: "ai_tasks",
  generatedArtifacts: "generated_artifacts",
} as const;

interface CloudFamily {
  roomName?: string;
  protagonistName?: string;
  deletedStories?: DeletedStory[];
}

interface CloudFamilyMember extends FamilyMember {
  familyId: string;
  memberId: string;
}

interface CloudMemory {
  familyId: string;
  sourceRecordId: string;
  authorMemberId: string;
  authorName: string;
  relation: string;
  text: string;
  title?: string;
  summary?: string;
  emotions?: string[];
  people?: string[];
  places?: string[];
  organizationMode?: MemoryContribution["organizationMode"];
  memoryType?: MemoryContribution["memoryType"];
  storyTitle?: string;
  relatedMemberIds?: string[];
  scope?: MemoryContribution["scope"];
  sharedWithMemberIds?: string[];
  visibility: Visibility;
  reviewStatus: ReviewStatus;
  createdAt: string;
  segments?: MemoryContribution["segments"];
  photoIds?: MemoryContribution["photoIds"];
  deletedAt?: string;
}

interface CloudBiographyDraft {
  familyId: string;
  memberId?: string;
  draftType?: "family" | "personal" | "manuscript-revision";
  draft?: BiographyDraft;
  sourceFingerprint?: string;
  revision?: ManuscriptRevision;
}

function database() {
  return wx.cloud.database();
}

function collection(name: string) {
  return database().collection(name);
}

function serverDate() {
  return database().serverDate();
}

let cachedOpenId: string | undefined;
let cachedFamilyId: string | undefined;

function sanitizeDocumentPart(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]/g, "_");
}

async function loadOpenId(): Promise<string> {
  if (cachedOpenId) return cachedOpenId;
  const response = await wx.cloud.callFunction({ name: "getOpenId" });
  const result = response.result as { openid?: unknown; account?: { primaryFamilyId?: unknown } } | undefined;
  const openid = String(result?.openid ?? "").trim();
  if (!openid) throw new Error("OPENID_NOT_AVAILABLE");
  cachedOpenId = openid;
  const linkedFamilyId = String(result?.account?.primaryFamilyId ?? "").trim();
  cachedFamilyId = /^family_[0-9A-Za-z_-]{1,120}$/.test(linkedFamilyId)
    ? linkedFamilyId
    : `family_${sanitizeDocumentPart(openid)}`;
  return cachedOpenId;
}

export async function currentFamilyId(): Promise<string> {
  const openid = await loadOpenId();
  return cachedFamilyId ?? `family_${sanitizeDocumentPart(openid)}`;
}

function familyMemberDocId(familyId: string, memberId: string): string {
  return `${familyId}_${sanitizeDocumentPart(memberId)}`;
}

function memoryDocId(familyId: string, contributionId: string): string {
  return `${familyId}_${sanitizeDocumentPart(contributionId)}`;
}

function sourceRecordDocId(familyId: string, contributionId: string): string {
  return `src_${familyId}_${sanitizeDocumentPart(contributionId)}`;
}

function familyDraftDocId(familyId: string): string {
  return `${familyId}_family_latest`;
}

function personalDraftDocId(familyId: string, memberId: string): string {
  return `${familyId}_${sanitizeDocumentPart(memberId)}_personal_latest`;
}

function generatedArtifactDocId(familyId: string, draft: BiographyDraft): string {
  return `artifact_${familyId}_${draft.generatedAt.replace(/[^0-9A-Za-z]/g, "_")}`;
}

function isNotFoundError(error: unknown): boolean {
  const message = String((error as { errMsg?: unknown })?.errMsg ?? error);
  return /document\b.*\b(does not exist|not found)|cannot find document with _id/i.test(message);
}

// Only discard undefined fields, not serverDate sentinel objects.
function definedFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

async function loadAllWhere(collectionName: string, filter: Record<string, unknown>) {
  const data: any[] = [];
  for (let offset = 0; ; offset += 20) {
    const response = await collection(collectionName).where(filter)
      .orderBy("_id", "asc").skip(offset).limit(20).get();
    data.push(...response.data);
    if (response.data.length < 20) return { data };
  }
}

async function loadAll(collectionName: string, familyId: string) {
  return loadAllWhere(collectionName, { familyId });
}

type LoadedCloudMemory = CloudMemory & { _id?: string; frontendContributionId?: string };

function contributionIdOf(memory: LoadedCloudMemory): string {
  return String(memory.frontendContributionId ?? memory._id ?? memory.sourceRecordId);
}

/** Old clients could leave more than one cloud document for the same logical memory. */
function uniqueCloudMemories(records: LoadedCloudMemory[], familyId: string): LoadedCloudMemory[] {
  const unique = new Map<string, LoadedCloudMemory>();
  for (const memory of records) {
    const contributionId = contributionIdOf(memory);
    const current = unique.get(contributionId);
    const canonicalId = memoryDocId(familyId, contributionId);
    if (!current || memory._id === canonicalId || current._id !== canonicalId) {
      unique.set(contributionId, memory);
    }
  }
  return [...unique.values()];
}

async function invalidateDraft(familyId: string, contribution: MemoryContribution) {
  // Source fingerprints make stale drafts unreadable even if cleanup fails.
  try {
    if (contributionScope(contribution) === "personal") {
      // Keep the last generated text recoverable. Fingerprints flag stale sources.
      return;
    } else {
      await saveDraft(familyId, undefined);
    }
  } catch {
    console.warn("旧书稿清理未完成；读取时会校验来源，记忆操作已完成");
  }
}

async function saveFamilyShell(familyId: string, state: FamilyRoomState): Promise<void> {
  await collection(CLOUD_COLLECTIONS.families).doc(familyId).set({
    data: {
      roomName: state.roomName,
      protagonistName: state.protagonistName,
      deletedStories: state.deletedStories ?? [],
      updatedAt: serverDate(),
    },
  });
}

async function saveMembers(familyId: string, members: FamilyMember[]): Promise<void> {
  await Promise.all(
    members.map((member) =>
      collection(CLOUD_COLLECTIONS.familyMembers)
        .doc(familyMemberDocId(familyId, member.id))
        .set({
          data: {
            ...member,
            familyId,
            memberId: member.id,
            updatedAt: serverDate(),
          },
        }),
    ),
  );
}

async function saveContribution(
  familyId: string,
  contribution: MemoryContribution,
): Promise<void> {
  const sourceRecordId = sourceRecordDocId(familyId, contribution.id);
  await collection(CLOUD_COLLECTIONS.sourceRecords).doc(sourceRecordId).set({
    data: definedFields({
      familyId,
      contributorMemberId: contribution.authorMemberId,
      contributorName: contribution.authorName,
      relation: contribution.relation,
      sourceType: "text",
      rawText: contribution.text,
      title: contribution.title,
      summary: contribution.summary,
      emotions: contribution.emotions,
      people: contribution.people,
      places: contribution.places,
      organizationMode: contribution.organizationMode,
      memoryType: contribution.memoryType,
      storyTitle: contribution.storyTitle,
      relatedMemberIds: contributionRelatedMemberIds(contribution),
      scope: contributionScope(contribution),
      sharedWithMemberIds: personalShareTargetMemberIds(contribution),
      visibility: contribution.visibility,
      reviewStatus: contribution.reviewStatus,
      frontendContributionId: contribution.id,
      submittedAt: contribution.createdAt,
      updatedAt: serverDate(),
    }),
  });

  await collection(CLOUD_COLLECTIONS.memories).doc(memoryDocId(familyId, contribution.id)).set({
    data: definedFields({
      familyId,
      sourceRecordId,
      frontendContributionId: contribution.id,
      authorMemberId: contribution.authorMemberId,
      authorName: contribution.authorName,
      relation: contribution.relation,
      text: contribution.text,
      title: contribution.title,
      summary: contribution.summary,
      emotions: contribution.emotions,
      people: contribution.people,
      places: contribution.places,
      organizationMode: contribution.organizationMode,
      memoryType: contribution.memoryType,
      storyTitle: contribution.storyTitle,
      relatedMemberIds: contributionRelatedMemberIds(contribution),
      scope: contributionScope(contribution),
      sharedWithMemberIds: personalShareTargetMemberIds(contribution),
      visibility: contribution.visibility,
      reviewStatus: contribution.reviewStatus,
      createdAt: contribution.createdAt,
      segments: contribution.segments,
      deletedAt: contribution.deletedAt,
      photoIds: contribution.photoIds,
      updatedAt: serverDate(),
    }),
  });
}

async function saveDraft(familyId: string, draft: BiographyDraft | undefined, sourceFingerprint = ""): Promise<void> {
  if (!draft) {
    try {
      await collection(CLOUD_COLLECTIONS.biographyDrafts).doc(familyDraftDocId(familyId)).remove();
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    return;
  }

  await collection(CLOUD_COLLECTIONS.biographyDrafts).doc(familyDraftDocId(familyId)).set({
    data: {
      familyId,
      draftType: "family",
      draft,
      sourceFingerprint,
      updatedAt: serverDate(),
    },
  });
}

async function savePersonalDraft(
  familyId: string,
  memberId: string,
  draft: BiographyDraft,
  sourceFingerprint = "",
): Promise<void> {
  await collection(CLOUD_COLLECTIONS.biographyDrafts).doc(personalDraftDocId(familyId, memberId)).set({
    data: {
      familyId,
      memberId,
      draftType: "personal",
      draft,
      sourceFingerprint,
      updatedAt: serverDate(),
    },
  });
}

async function removePersonalDraft(familyId: string, memberId: string): Promise<void> {
  try {
    await collection(CLOUD_COLLECTIONS.biographyDrafts).doc(personalDraftDocId(familyId, memberId)).remove();
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

async function removeDocIfExists(collectionName: string, documentId: string): Promise<void> {
  try {
    await collection(collectionName).doc(documentId).remove();
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

async function clearFamilyCollection(
  collectionName: string,
  familyId: string,
): Promise<void> {
  while (true) {
    const response = await collection(collectionName).where({ familyId }).limit(20).get();
    const records = response.data as Array<{ _id?: string }>;
    if (records.length === 0) return;
    await Promise.all(
      records
        .map((record) => record._id)
        .filter((id): id is string => Boolean(id))
        .map((id) => collection(collectionName).doc(id).remove()),
    );
  }
}

async function saveCloudRoomState(
  familyId: string,
  state: FamilyRoomState,
): Promise<void> {
  await saveFamilyShell(familyId, state);
  await saveMembers(familyId, state.members);
  await Promise.all(state.contributions.map((contribution) => saveContribution(familyId, contribution)));
  await saveDraft(familyId, state.draft);
  await Promise.all(
    Object.entries(state.personalDrafts ?? {}).map(([memberId, draft]) =>
      savePersonalDraft(familyId, memberId, draft),
    ),
  );
}

async function seedInitialState(familyId: string): Promise<FamilyRoomState> {
  const initial = createEmptyRoomState();
  await saveFamilyShell(familyId, initial);
  return initial;
}

type StoryServiceRoomState = Partial<FamilyRoomState> & {
  error?: string;
  code?: string;
  message?: string;
  roomStateVersion?: number;
  draftSourceFingerprint?: string;
  personalDraftSourceFingerprints?: Record<string, string>;
};

function storyServiceError(result: StoryServiceRoomState): Error & { code?: string } {
  const error = new Error(result.message || "故事库加载失败") as Error & { code?: string };
  if (result.code) error.code = result.code;
  return error;
}

function missingStoryService(error: unknown): boolean {
  return /FUNCTION_NOT_FOUND|-501000|could not be found|unexpected cloud function:\s*storyBooks/i.test(
    String((error as { message?: unknown; errMsg?: unknown } | undefined)?.message ??
      (error as { errMsg?: unknown } | undefined)?.errMsg ?? error),
  );
}

async function loadStoryServiceRoomState(): Promise<StoryServiceRoomState> {
  const response = await wx.cloud.callFunction({ name: "storyBooks", data: { action: "state" } });
  const result = (response.result ?? {}) as StoryServiceRoomState;
  if (result.error) throw storyServiceError(result);
  return result;
}

function unsupportedStoryMemberAction(error: unknown): boolean {
  const detail = error as { code?: unknown; message?: unknown; errMsg?: unknown } | undefined;
  return missingStoryService(error) || /不支持的故事操作/i.test(
    [detail?.code, detail?.message, detail?.errMsg, error].map(String).join(" "),
  );
}

async function callStoryMemberAction(
  action: "memberAdd" | "memberUpdate" | "memberDelete" | "memberRestore",
  data: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await wx.cloud.callFunction({ name: "storyBooks", data: { ...data, action } });
    const result = (response.result ?? {}) as StoryServiceRoomState & { ok?: boolean };
    if (result.ok === true) return true;
    if (result.error) {
      const error = storyServiceError(result);
      if (unsupportedStoryMemberAction(error)) return false;
      throw error;
    }
    throw new Error("人物服务返回无效响应，请稍后重试");
  } catch (error) {
    if (unsupportedStoryMemberAction(error)) return false;
    throw error;
  }
}

function isCompleteStoryServiceRoomState(result: StoryServiceRoomState): boolean {
  return result.roomStateVersion === 1 &&
    typeof result.roomName === "string" &&
    typeof result.protagonistName === "string" &&
    Array.isArray(result.members) &&
    Array.isArray(result.contributions) &&
    Array.isArray(result.manuscriptRevisions) &&
    Array.isArray(result.deletedStories) &&
    Array.isArray(result.stories) &&
    !!result.personalDrafts && typeof result.personalDrafts === "object" && !Array.isArray(result.personalDrafts) &&
    !!result.personalDraftSourceFingerprints && typeof result.personalDraftSourceFingerprints === "object" && !Array.isArray(result.personalDraftSourceFingerprints);
}

function normalizeStoryServiceRoomState(result: StoryServiceRoomState): FamilyRoomState {
  const state: FamilyRoomState = {
    ...createEmptyRoomState(),
    roomName: String(result.roomName || "我的拾光房间"),
    protagonistName: String(result.protagonistName || ""),
    members: Array.isArray(result.members) ? result.members : [],
    contributions: Array.isArray(result.contributions) ? result.contributions : [],
    draft: result.draft,
    personalDrafts: result.personalDrafts ?? {},
    // Versioned service drafts carry source fingerprints. If one no longer
    // matches, it must stay hidden instead of resurfacing through the
    // unversioned legacy fallback.
    legacyPersonalDrafts: {},
    manuscriptRevisions: Array.isArray(result.manuscriptRevisions) ? result.manuscriptRevisions : [],
    deletedStories: Array.isArray(result.deletedStories) ? result.deletedStories : [],
    stories: Array.isArray(result.stories) ? result.stories : [],
    ...(result.storyMigration ? { storyMigration: result.storyMigration } : {}),
  };
  state.draft = result.draftSourceFingerprint === biographySourceFingerprint(state) ? result.draft : undefined;
  const sourceFingerprints = result.personalDraftSourceFingerprints ?? {};
  state.personalDrafts = Object.fromEntries(Object.entries(result.personalDrafts ?? {}).filter(([memberId]) =>
    sourceFingerprints[memberId] === personalBookSourceFingerprint(state, memberId)));
  return state;
}

export async function loadCloudRoomState(options: { readOnly?: boolean } = {}): Promise<FamilyRoomState> {
  const familyId = await currentFamilyId();
  let storyServiceState: StoryServiceRoomState | undefined;
  try {
    storyServiceState = await loadStoryServiceRoomState();
    if (storyServiceState.roomStateVersion === 1) {
      if (!isCompleteStoryServiceRoomState(storyServiceState)) throw new Error("故事服务返回不完整，请稍后重试");
      return normalizeStoryServiceRoomState(storyServiceState);
    }
  } catch (error) {
    if (!missingStoryService(error) && (error as { code?: string } | undefined)?.code !== "STORY_NOT_FOUND") throw error;
  }
  let family: CloudFamily | undefined;
  try {
    const response = await collection(CLOUD_COLLECTIONS.families).doc(familyId).get();
    family = response.data as CloudFamily;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  if (!family) {
    if (options.readOnly) return createEmptyRoomState();
    return seedInitialState(familyId);
  }

  const [membersResponse, memoriesResponse, draftResponse] = await Promise.all([
    loadAll(CLOUD_COLLECTIONS.familyMembers, familyId),
    loadAll(CLOUD_COLLECTIONS.memories, familyId),
    loadAll(CLOUD_COLLECTIONS.biographyDrafts, familyId),
  ]);

  const members = (membersResponse.data as CloudFamilyMember[])
    .map((member) => ({
      id: member.memberId,
      name: member.name,
      relation: member.relation,
      avatarText: member.avatarText,
      role: member.role,
      ...(member.kind ? { kind: member.kind } : {}),
      ...(typeof member.deletedAt === "string" && member.deletedAt ? { deletedAt: member.deletedAt } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (members.length === 0) {
    return {
      ...createEmptyRoomState(),
      roomName: family.roomName ?? "我的拾光房间",
      protagonistName: family.protagonistName ?? "",
      deletedStories: family.deletedStories ?? [],
    };
  }

  const contributions = uniqueCloudMemories(memoriesResponse.data as LoadedCloudMemory[], familyId).map(
    (memory) => ({
      id: contributionIdOf(memory),
      authorMemberId: memory.authorMemberId,
      authorName: memory.authorName,
      relation: memory.relation,
      text: memory.text,
      title: memory.title,
      summary: memory.summary,
      emotions: memory.emotions,
      people: memory.people,
      places: memory.places,
      organizationMode: memory.organizationMode,
      memoryType: memory.memoryType,
      storyTitle: memory.storyTitle,
      relatedMemberIds: memory.relatedMemberIds,
      scope: memory.scope,
      sharedWithMemberIds: memory.sharedWithMemberIds,
      visibility: memory.visibility,
      reviewStatus: memory.reviewStatus,
      createdAt: memory.createdAt,
      segments: memory.segments,
      deletedAt: memory.deletedAt,
      photoIds: memory.photoIds,
    }),
  );

  const draftRecords = draftResponse.data as CloudBiographyDraft[];
  const familyDraft = draftRecords.find((record) => record.draftType === "family")?.draft;
  const personalDrafts = Object.fromEntries(
    draftRecords
      .filter((record) => record.draftType === "personal" && record.memberId && record.draft)
      .map((record) => [record.memberId as string, record.draft as BiographyDraft]),
  );

  const state = {
    roomName: family.roomName ?? "拾光房间",
    protagonistName: family.protagonistName ?? "主人公",
    members,
    contributions,
    draft: familyDraft,
    personalDrafts,
    legacyPersonalDrafts: { ...personalDrafts },
    manuscriptRevisions: draftRecords.filter(record => record.draftType === "manuscript-revision" && record.revision)
      .map(record => record.revision as ManuscriptRevision),
    deletedStories: family.deletedStories ?? [],
  };

  // Legacy drafts remain stored, but must be regenerated before being presented
  // as a current manuscript because their original source version is unknown.
  state.draft = draftRecords.find(record => record.draftType === "family" &&
    record.sourceFingerprint === biographySourceFingerprint(state))?.draft;
  state.personalDrafts = Object.fromEntries(draftRecords
    .filter(record => record.draftType === "personal" && record.memberId && record.draft &&
      record.sourceFingerprint === personalBookSourceFingerprint(state, record.memberId))
    .map(record => [record.memberId as string, record.draft as BiographyDraft]));
  try {
    const result = storyServiceState ?? await loadStoryServiceRoomState();
    if (result?.storyMigration) return {...state,stories:result.stories ?? [],storyMigration:result.storyMigration,
      manuscriptRevisions:[...state.manuscriptRevisions,...(result.manuscriptRevisions ?? [])]};
  } catch (error) {
    // Older deployments remain readable, but the new write API never falls back.
    if (!missingStoryService(error)) throw error;
  }
  return state;
}

export async function saveCloudManuscriptRevision(revision: ManuscriptRevision): Promise<void> {
  const familyId = await currentFamilyId();
  await collection(CLOUD_COLLECTIONS.biographyDrafts)
    .doc(`${familyId}_${sanitizeDocumentPart(revision.id)}`).set({
      data: { familyId, memberId: revision.memberId, draftType: "manuscript-revision", revision, updatedAt: serverDate() },
    });
}

/**
 * 提到了别人、或者标了分享对象的个人记忆，写进云端前必须先过内容安全检测（微信要求，
 * 详见 cloudfunctions/contentSecurityCheck）。纯私密记忆（没提到任何人）不会被别的
 * 微信账号看到，不需要检测，也不发起这次网络请求。
 *
 * 检测没通过、或者检测服务暂时不可用时，仍然保存这段文字，但强制改成只有作者自己能看；
 * 调用方可以对比保存前后的 sharedWithMemberIds 判断是否发生了这种情况，据此提示作者。
 */
async function enforceContentSecurity(contribution: MemoryContribution): Promise<MemoryContribution> {
  const mayBeShownToOthers = contributionScope(contribution) === "personal" &&
    (contributionRelatedMemberIds(contribution).length > 0 || personalShareTargetMemberIds(contribution).length > 0);
  if (!mayBeShownToOthers) return contribution;
  const result = await checkTextContent(contribution.text, contribution.title);
  if (result.ok) return contribution;
  return { ...contribution, sharedWithMemberIds: undefined };
}

export async function appendCloudContribution(
  contribution: MemoryContribution,
): Promise<FamilyRoomState> {
  return appendCloudContributions([contribution]);
}

/** Bounded multi-record import: load the room once, then write resumable stable IDs. */
export async function appendCloudContributions(
  rawContributions: MemoryContribution[],
): Promise<FamilyRoomState> {
  if (rawContributions.length === 0) return loadCloudRoomState();
  const contributions = await Promise.all(rawContributions.map(enforceContentSecurity));
  const familyId = await currentFamilyId();
  const state = await loadCloudRoomState();
  for (let offset = 0; offset < contributions.length; offset += 5) {
    await Promise.all(contributions.slice(offset, offset + 5).map(item => saveContribution(familyId, item)));
  }
  await Promise.all(contributions.map(item => invalidateDraft(familyId, item)));
  const importedIds = new Set(contributions.map(item => item.id));
  const personalDrafts = { ...(state.personalDrafts ?? {}) };
  for (const item of contributions) {
    if (contributionScope(item) === "personal") delete personalDrafts[item.authorMemberId];
  }
  return {
    ...state,
    contributions: [...state.contributions.filter(item => !importedIds.has(item.id)), ...contributions],
    draft: contributions.some(item => contributionScope(item) === "family") ? undefined : state.draft,
    personalDrafts,
  };
}

export async function addCloudFamilyMember(
  name: string,
  relation: string,
  kind?: FamilyMember["kind"],
): Promise<FamilyRoomState> {
  const familyId = await currentFamilyId();
  const state = await loadCloudRoomState();
  const trimmedName = name.trim();
  const trimmedRelation = relation.trim() || "家人";
  if (!trimmedName) {
    throw new Error("请填写家人的名字");
  }
  if (trimmedName.length > 12) {
    throw new Error("名字不能超过 12 个字");
  }
  const sameName = state.members.find((member) => member.name === trimmedName);
  if (sameName) {
    throw new Error(sameName.deletedAt ? "这个名字在「最近删除」里，可以直接恢复" : "名单里已经有这个名字");
  }

  const firstProfile = state.members.length === 0;
  if (kind === "person" && !state.members.some(isRecordingProfile)) {
    throw new Error("请先新建一本书，再加人");
  }
  const member: FamilyMember = {
    id: firstProfile ? "owner" : `member-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: trimmedName,
    relation: (firstProfile && !relation.trim() ? "自己" : trimmedRelation).slice(0, 12),
    avatarText: trimmedName.slice(0, 1),
    role: firstProfile ? "owner" : "contributor",
    ...(kind ? { kind } : {}),
  };
  if (await callStoryMemberAction("memberAdd", {
    memberId: member.id,
    name: member.name,
    relation: member.relation,
    kind: member.kind ?? "recording-profile",
  })) return loadCloudRoomState();
  await saveMembers(familyId, [member]);
  return {
    ...state,
    members: [...state.members, member],
  };
}

export async function replaceCloudContribution(
  rawContribution: MemoryContribution,
): Promise<FamilyRoomState> {
  const familyId = await currentFamilyId();
  const state = await loadCloudRoomState();
  if (!state.contributions.some(item => item.id === rawContribution.id)) {
    throw new Error("这段记忆已不存在，请刷新列表");
  }
  const contribution = await enforceContentSecurity(rawContribution);
  await saveContribution(familyId, contribution);
  await invalidateDraft(familyId, contribution);
  const personalDrafts = { ...(state.personalDrafts ?? {}) };
  delete personalDrafts[contribution.authorMemberId];
  return {
    ...state,
    contributions: state.contributions.map((item) =>
      item.id === contribution.id ? contribution : item,
    ),
    draft: undefined,
    personalDrafts,
  };
}

export async function deleteCloudContribution(
  contributionId: string,
): Promise<FamilyRoomState> {
  const familyId = await currentFamilyId();
  const state = await loadCloudRoomState();
  const contribution = state.contributions.find((item) => item.id === contributionId);
  const [allMemories, allSources] = await Promise.all([
    loadAll(CLOUD_COLLECTIONS.memories, familyId),
    loadAll(CLOUD_COLLECTIONS.sourceRecords, familyId),
  ]);
  // Reuse the existing family-scoped queries so this repair needs no new cloud
  // database composite index. Filter the small account dataset in memory.
  const memoryCopies = allMemories.data.filter((item: LoadedCloudMemory) =>
    contributionIdOf(item) === contributionId);
  const memoryDocumentIds = new Set<string>([
    memoryDocId(familyId, contributionId),
    contributionId,
    ...memoryCopies.map((item: { _id?: string }) => item._id)
      .filter((id: unknown): id is string => typeof id === "string"),
  ]);
  const referencedSourceIds = new Set(memoryCopies
    .map((item: { sourceRecordId?: string }) => item.sourceRecordId)
    .filter((id: unknown): id is string => typeof id === "string"));
  const sourceCopies = allSources.data.filter((item: {
    _id?: string;
    frontendContributionId?: string;
  }) => item.frontendContributionId === contributionId ||
    (typeof item._id === "string" && referencedSourceIds.has(item._id)));
  const sourceDocumentIds = new Set<string>([
    sourceRecordDocId(familyId, contributionId),
    `src_${contributionId}`,
    ...referencedSourceIds,
    ...sourceCopies.map((item: { _id?: string }) => item._id)
      .filter((id: unknown): id is string => typeof id === "string"),
  ]);
  // Remove every raw copy before every visible copy. A retry resolves the same
  // logical ID, so legacy random document IDs cannot reappear after refresh.
  await Promise.all([...sourceDocumentIds].map(id =>
    removeDocIfExists(CLOUD_COLLECTIONS.sourceRecords, id)));
  await Promise.all([...memoryDocumentIds].map(id =>
    removeDocIfExists(CLOUD_COLLECTIONS.memories, id)));
  if (!contribution) return state;
  await invalidateDraft(familyId, contribution);

  const personalDrafts = { ...(state.personalDrafts ?? {}) };
  if (contributionScope(contribution) === "personal") {
    delete personalDrafts[contribution.authorMemberId];
  }

  return {
    ...state,
    contributions: state.contributions.filter((item) => item.id !== contributionId),
    draft: contributionScope(contribution) === "family" ? undefined : state.draft,
    personalDrafts,
  };
}

export async function saveCloudDraftIfSourcesUnchanged(
  draft: BiographyDraft,
  sourceFingerprint: string,
): Promise<FamilyRoomState | undefined> {
  const familyId = await currentFamilyId();
  const latestState = await loadCloudRoomState();
  if (biographySourceFingerprint(latestState) !== sourceFingerprint) {
    return undefined;
  }

  await saveDraft(familyId, draft, sourceFingerprint);
  await collection(CLOUD_COLLECTIONS.generatedArtifacts).doc(generatedArtifactDocId(familyId, draft)).set({
    data: {
      familyId,
      productType: "memoir_review",
      artifactType: "text",
      title: draft.title,
      paragraphs: draft.paragraphs,
      sourceCount: draft.sourceCount,
      generationMode: draft.generationMode,
      generatedAt: draft.generatedAt,
      createdAt: serverDate(),
    },
  });

  return { ...latestState, draft };
}

export async function saveCloudPersonalDraftIfSourcesUnchanged(
  draft: BiographyDraft,
  sourceFingerprint: string,
  memberId: string,
): Promise<FamilyRoomState | undefined> {
  const familyId = await currentFamilyId();
  const latestState = await loadCloudRoomState();
  if (personalBookSourceFingerprint(latestState, memberId) !== sourceFingerprint) {
    return undefined;
  }

  await savePersonalDraft(familyId, memberId, draft, sourceFingerprint);
  await collection(CLOUD_COLLECTIONS.generatedArtifacts).doc(generatedArtifactDocId(familyId, draft)).set({
    data: {
      familyId,
      memberId,
      productType: "memoir_review",
      artifactType: "text",
      title: draft.title,
      paragraphs: draft.paragraphs,
      sourceCount: draft.sourceCount,
      generationMode: draft.generationMode,
      generatedAt: draft.generatedAt,
      createdAt: serverDate(),
    },
  });

  return {
    ...latestState,
    personalDrafts: {
      ...(latestState.personalDrafts ?? {}),
      [memberId]: draft,
    },
  };
}

export async function updateCloudPersonalShareTargets(
  contributionId: string,
  actor: FamilyMember,
  targetMemberIds: string[],
): Promise<FamilyRoomState> {
  const familyId = await currentFamilyId();
  const state = await loadCloudRoomState();
  const currentActor = state.members.find((member) => member.id === actor.id);
  const contribution = state.contributions.find((item) => item.id === contributionId);
  if (!currentActor) throw new Error("当前身份已不在这个亲友空间");
  if (!contribution) throw new Error("没有找到这段故事");
  if (targetMemberIds.some((memberId) => !state.members.some((member) => member.id === memberId && isActiveMember(member)))) {
    throw new Error("请选择仍在空间里的亲友");
  }

  const updated = setPersonalShareTargets(contribution, currentActor, targetMemberIds);
  await saveContribution(familyId, updated);
  return {
    ...state,
    contributions: state.contributions.map((item) =>
      item.id === contributionId ? updated : item,
    ),
  };
}

async function changeCloudMember(
  plan: (state: FamilyRoomState) => MemberChange | undefined,
): Promise<FamilyRoomState> {
  const familyId = await currentFamilyId();
  const state = await loadCloudRoomState();
  const change = plan(state);
  if (!change) return state;
  // References first: if they fail, the member stays visible and a retry repeats the same writes.
  await saveContributionsInBatches(familyId, change.contributions);
  await saveMembers(familyId, [change.member]);
  return applyMemberChange(state, change);
}

async function saveContributionsInBatches(familyId: string, contributions: MemoryContribution[]): Promise<void> {
  const batchSize = 10;
  for (let offset = 0; offset < contributions.length; offset += batchSize) {
    await Promise.all(contributions.slice(offset, offset + batchSize).map((contribution) => saveContribution(familyId, contribution)));
  }
}

export async function classifyCloudMember(memberId: string, kind: MemberKind): Promise<FamilyRoomState> {
  return changeCloudMember((state) => planClassify(state, memberId, kind, loadCurrentMember(state).id));
}

export async function deleteCloudMember(memberId: string, now = new Date()): Promise<FamilyRoomState> {
  // 先走服务端：云函数创建的人物文档没有客户端 _openid，客户端直写会被权限挡掉，
  // 界面上看得见却永远删不掉。服务端不支持时才退回本地改法。
  if (await callStoryMemberAction("memberDelete", { memberId })) return loadCloudRoomState();
  return changeCloudMember((state) => planDelete(state, memberId, loadCurrentMember(state).id, now));
}

export async function restoreCloudMember(memberId: string): Promise<FamilyRoomState> {
  if (await callStoryMemberAction("memberRestore", { memberId })) return loadCloudRoomState();
  return changeCloudMember((state) => planRestore(state, memberId));
}

export async function updateCloudMember(memberId: string, name: string, relation: string): Promise<FamilyRoomState> {
  const familyId = await currentFamilyId();
  const state = await loadCloudRoomState();
  const change = planUpdateMember(state, memberId, name, relation);
  if (!change) return state;
  if (await callStoryMemberAction("memberUpdate", { memberId, name, relation })) return loadCloudRoomState();
  await saveContributionsInBatches(familyId, change.contributions);
  await saveMembers(familyId, [change.member]);
  return applyMemberChange(state, change);
}

async function saveDeletedStories(familyId: string, deletedStories: DeletedStory[]): Promise<void> {
  await collection(CLOUD_COLLECTIONS.families).doc(familyId).update({
    data: { deletedStories, updatedAt: serverDate() },
  });
}

/** 软删除一段记忆：放进「最近删除」，可以恢复。真正永久删除请用 deleteCloudContribution。 */
export async function softDeleteCloudMemory(contributionId: string, now = new Date()): Promise<FamilyRoomState> {
  const familyId = await currentFamilyId();
  const state = await loadCloudRoomState();
  const updated = planDeleteMemory(state, contributionId, now);
  if (!updated) return state;
  await saveContribution(familyId, updated);
  return { ...state, contributions: state.contributions.map(item => item.id === contributionId ? updated : item) };
}

export async function restoreCloudMemory(contributionId: string): Promise<FamilyRoomState> {
  const familyId = await currentFamilyId();
  const state = await loadCloudRoomState();
  const updated = planRestoreMemory(state, contributionId);
  if (!updated) return state;
  await saveContribution(familyId, updated);
  return { ...state, contributions: state.contributions.map(item => item.id === contributionId ? updated : item) };
}

export async function deleteCloudStory(key: string, title: string): Promise<FamilyRoomState> {
  const familyId = await currentFamilyId();
  const state = await loadCloudRoomState();
  const next = planDeleteStory(state, key, title);
  await saveDeletedStories(familyId, next.deletedStories ?? []);
  return next;
}

export async function restoreCloudStory(key: string): Promise<FamilyRoomState> {
  const familyId = await currentFamilyId();
  const state = await loadCloudRoomState();
  const next = planRestoreStory(state, key);
  await saveDeletedStories(familyId, next.deletedStories ?? []);
  return next;
}

export async function resetCloudCurrentUserRoom(): Promise<FamilyRoomState> {
  const familyId = await currentFamilyId();

  try {
    await wx.cloud.callFunction({ name: "resetCurrentUserRoom" });
    return loadCloudRoomState();
  } catch (error) {
    const state = await loadCloudRoomState();
    if (state.storyMigration) throw new Error('清空没有完成，请重试；已有故事仍保留');
    console.warn("服务端清空当前账号失败，将尝试客户端清空", error);
  }

  await Promise.all([
    removeDocIfExists(CLOUD_COLLECTIONS.families, familyId),
    clearFamilyCollection(CLOUD_COLLECTIONS.familyMembers, familyId),
    clearFamilyCollection(CLOUD_COLLECTIONS.sourceRecords, familyId),
    clearFamilyCollection(CLOUD_COLLECTIONS.memories, familyId),
    clearFamilyCollection(CLOUD_COLLECTIONS.biographyDrafts, familyId),
    clearFamilyCollection(CLOUD_COLLECTIONS.generatedArtifacts, familyId),
    clearFamilyCollection(CLOUD_COLLECTIONS.assets, familyId),
    clearFamilyCollection(CLOUD_COLLECTIONS.aiTasks, familyId),
  ]);

  return seedInitialState(familyId);
}
