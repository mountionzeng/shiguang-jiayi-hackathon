import {
  biographySourceFingerprint,
  BiographyDraft,
  createInitialRoomState,
  FamilyMember,
  FamilyRoomState,
  MemoryContribution,
  ReviewStatus,
  Visibility,
} from "../domain/biography";

export const DEMO_FAMILY_ID = "demo-family";

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
  visibility: Visibility;
  reviewStatus: ReviewStatus;
  createdAt: string;
}

interface CloudBiographyDraft {
  familyId: string;
  draft?: BiographyDraft;
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

function familyMemberDocId(memberId: string): string {
  return `${DEMO_FAMILY_ID}_${memberId}`;
}

function sourceRecordDocId(contributionId: string): string {
  return `src_${contributionId}`;
}

function draftDocId(): string {
  return `${DEMO_FAMILY_ID}_latest`;
}

function generatedArtifactDocId(draft: BiographyDraft): string {
  return `artifact_${draft.generatedAt.replace(/[^0-9A-Za-z]/g, "_")}`;
}

function isNotFoundError(error: unknown): boolean {
  const message = String((error as { errMsg?: unknown })?.errMsg ?? error);
  return message.includes("does not exist") || message.includes("document.get:fail");
}

async function saveFamilyShell(state: FamilyRoomState): Promise<void> {
  await collection(CLOUD_COLLECTIONS.families).doc(DEMO_FAMILY_ID).set({
    data: {
      roomName: state.roomName,
      protagonistName: state.protagonistName,
      updatedAt: serverDate(),
    },
  });
}

async function saveMembers(members: FamilyMember[]): Promise<void> {
  await Promise.all(
    members.map((member) =>
      collection(CLOUD_COLLECTIONS.familyMembers)
        .doc(familyMemberDocId(member.id))
        .set({
          data: {
            ...member,
            familyId: DEMO_FAMILY_ID,
            memberId: member.id,
            updatedAt: serverDate(),
          },
        }),
    ),
  );
}

async function saveContribution(contribution: MemoryContribution): Promise<void> {
  const sourceRecordId = sourceRecordDocId(contribution.id);
  await collection(CLOUD_COLLECTIONS.sourceRecords).doc(sourceRecordId).set({
    data: {
      familyId: DEMO_FAMILY_ID,
      contributorMemberId: contribution.authorMemberId,
      contributorName: contribution.authorName,
      relation: contribution.relation,
      sourceType: "text",
      rawText: contribution.text,
      visibility: contribution.visibility,
      reviewStatus: contribution.reviewStatus,
      frontendContributionId: contribution.id,
      submittedAt: contribution.createdAt,
      updatedAt: serverDate(),
    },
  });

  await collection(CLOUD_COLLECTIONS.memories).doc(contribution.id).set({
    data: {
      familyId: DEMO_FAMILY_ID,
      sourceRecordId,
      authorMemberId: contribution.authorMemberId,
      authorName: contribution.authorName,
      relation: contribution.relation,
      text: contribution.text,
      visibility: contribution.visibility,
      reviewStatus: contribution.reviewStatus,
      createdAt: contribution.createdAt,
      updatedAt: serverDate(),
    },
  });
}

async function saveDraft(draft: BiographyDraft | undefined): Promise<void> {
  if (!draft) {
    try {
      await collection(CLOUD_COLLECTIONS.biographyDrafts).doc(draftDocId()).remove();
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    return;
  }

  await collection(CLOUD_COLLECTIONS.biographyDrafts).doc(draftDocId()).set({
    data: {
      familyId: DEMO_FAMILY_ID,
      draft,
      updatedAt: serverDate(),
    },
  });
}

async function clearDemoCollection(collectionName: string): Promise<void> {
  const response = await collection(collectionName).where({ familyId: DEMO_FAMILY_ID }).get();
  const records = response.data as Array<{ _id?: string }>;
  await Promise.all(
    records
      .map((record) => record._id)
      .filter((id): id is string => Boolean(id))
      .map((id) => collection(collectionName).doc(id).remove()),
  );
}

async function saveCloudRoomState(state: FamilyRoomState): Promise<void> {
  await saveFamilyShell(state);
  await saveMembers(state.members);
  await Promise.all(state.contributions.map((contribution) => saveContribution(contribution)));
  await saveDraft(state.draft);
}

async function seedInitialState(): Promise<FamilyRoomState> {
  const initial = createInitialRoomState();
  await saveCloudRoomState(initial);
  return initial;
}

export async function loadCloudRoomState(): Promise<FamilyRoomState> {
  let family: CloudFamily | undefined;
  try {
    const response = await collection(CLOUD_COLLECTIONS.families).doc(DEMO_FAMILY_ID).get();
    family = response.data as CloudFamily;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  if (!family) {
    return seedInitialState();
  }

  const [membersResponse, memoriesResponse, draftResponse] = await Promise.all([
    collection(CLOUD_COLLECTIONS.familyMembers).where({ familyId: DEMO_FAMILY_ID }).get(),
    collection(CLOUD_COLLECTIONS.memories)
      .where({ familyId: DEMO_FAMILY_ID })
      .orderBy("createdAt", "asc")
      .get(),
    collection(CLOUD_COLLECTIONS.biographyDrafts).doc(draftDocId()).get().catch((error) => {
      if (isNotFoundError(error)) return undefined;
      throw error;
    }),
  ]);

  const members = (membersResponse.data as CloudFamilyMember[])
    .map((member) => ({
      id: member.memberId,
      name: member.name,
      relation: member.relation,
      avatarText: member.avatarText,
      role: member.role,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  if (members.length === 0) {
    return seedInitialState();
  }

  const contributions = (memoriesResponse.data as Array<CloudMemory & { _id?: string }>).map(
    (memory) => ({
      id: String(memory._id ?? memory.sourceRecordId),
      authorMemberId: memory.authorMemberId,
      authorName: memory.authorName,
      relation: memory.relation,
      text: memory.text,
      visibility: memory.visibility,
      reviewStatus: memory.reviewStatus,
      createdAt: memory.createdAt,
    }),
  );

  const draftData = draftResponse?.data as CloudBiographyDraft | undefined;
  return {
    roomName: family.roomName ?? "拾光房间",
    protagonistName: family.protagonistName ?? "主人公",
    members,
    contributions,
    draft: draftData?.draft,
  };
}

export async function appendCloudContribution(
  contribution: MemoryContribution,
): Promise<FamilyRoomState> {
  const state = await loadCloudRoomState();
  await saveContribution(contribution);
  await saveDraft(undefined);
  return {
    ...state,
    contributions: [...state.contributions, contribution],
    draft: undefined,
  };
}

export async function replaceCloudContribution(
  contribution: MemoryContribution,
): Promise<FamilyRoomState> {
  const state = await loadCloudRoomState();
  await saveContribution(contribution);
  await saveDraft(undefined);
  return {
    ...state,
    contributions: state.contributions.map((item) =>
      item.id === contribution.id ? contribution : item,
    ),
    draft: undefined,
  };
}

export async function saveCloudDraftIfSourcesUnchanged(
  draft: BiographyDraft,
  sourceFingerprint: string,
): Promise<FamilyRoomState | undefined> {
  const latestState = await loadCloudRoomState();
  if (biographySourceFingerprint(latestState) !== sourceFingerprint) {
    return undefined;
  }

  await saveDraft(draft);
  await collection(CLOUD_COLLECTIONS.generatedArtifacts).doc(generatedArtifactDocId(draft)).set({
    data: {
      familyId: DEMO_FAMILY_ID,
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

export async function resetCloudDemoRoom(): Promise<FamilyRoomState> {
  await Promise.all([
    clearDemoCollection(CLOUD_COLLECTIONS.familyMembers),
    clearDemoCollection(CLOUD_COLLECTIONS.sourceRecords),
    clearDemoCollection(CLOUD_COLLECTIONS.memories),
    clearDemoCollection(CLOUD_COLLECTIONS.biographyDrafts),
    clearDemoCollection(CLOUD_COLLECTIONS.generatedArtifacts),
  ]);
  return seedInitialState();
}
