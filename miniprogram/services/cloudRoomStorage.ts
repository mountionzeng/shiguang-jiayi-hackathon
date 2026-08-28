import {
  biographySourceFingerprint,
  BiographyDraft,
  createInitialRoomState,
  FamilyRoomState,
  MemoryContribution,
} from "../domain/biography";

const COLLECTION_NAME = "family_rooms";
const DEMO_ROOM_ID = "demo-room";

interface StoredRoom {
  state?: FamilyRoomState;
}

function roomCollection() {
  return wx.cloud.database().collection(COLLECTION_NAME);
}

function serverDate() {
  return wx.cloud.database().serverDate();
}

function isNotFoundError(error: unknown): boolean {
  return String((error as { errMsg?: unknown })?.errMsg ?? error).includes("does not exist");
}

export async function loadCloudRoomState(): Promise<FamilyRoomState> {
  try {
    const response = await roomCollection().doc(DEMO_ROOM_ID).get();
    const stored = response.data as StoredRoom;
    if (stored.state && Array.isArray(stored.state.contributions)) {
      return stored.state;
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const initial = createInitialRoomState();
  await saveCloudRoomState(initial);
  return initial;
}

export async function saveCloudRoomState(state: FamilyRoomState): Promise<void> {
  await roomCollection().doc(DEMO_ROOM_ID).set({
    data: {
      state,
      updatedAt: serverDate(),
    },
  });
}

export async function appendCloudContribution(
  contribution: MemoryContribution,
): Promise<FamilyRoomState> {
  const state = await loadCloudRoomState();
  const next = {
    ...state,
    contributions: [...state.contributions, contribution],
    draft: undefined,
  };
  await saveCloudRoomState(next);
  return next;
}

export async function replaceCloudContribution(
  contribution: MemoryContribution,
): Promise<FamilyRoomState> {
  const state = await loadCloudRoomState();
  const next = {
    ...state,
    contributions: state.contributions.map((item) =>
      item.id === contribution.id ? contribution : item,
    ),
    draft: undefined,
  };
  await saveCloudRoomState(next);
  return next;
}

export async function saveCloudDraftIfSourcesUnchanged(
  draft: BiographyDraft,
  sourceFingerprint: string,
): Promise<FamilyRoomState | undefined> {
  const latestState = await loadCloudRoomState();
  if (biographySourceFingerprint(latestState) !== sourceFingerprint) {
    return undefined;
  }

  const next = { ...latestState, draft };
  await saveCloudRoomState(next);
  return next;
}

export async function resetCloudDemoRoom(): Promise<FamilyRoomState> {
  const initial = createInitialRoomState();
  await saveCloudRoomState(initial);
  return initial;
}
