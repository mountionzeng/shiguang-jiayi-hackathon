import {
  BiographyDraft,
  biographySourceFingerprint,
  createInitialRoomState,
  FamilyRoomState,
  MemoryContribution,
} from "../domain/biography";

const STORAGE_KEY = "shiguang-family-room-v2";

export function loadRoomState(): FamilyRoomState {
  try {
    const stored = wx.getStorageSync<FamilyRoomState>(STORAGE_KEY);
    if (stored && Array.isArray(stored.contributions) && Array.isArray(stored.members)) {
      return stored;
    }
  } catch (error) {
    console.warn("无法读取本地家庭房间，将使用演示数据", error);
  }

  const initial = createInitialRoomState();
  saveRoomState(initial);
  return initial;
}

export function saveRoomState(state: FamilyRoomState): void {
  wx.setStorageSync(STORAGE_KEY, state);
}

export function saveDraftIfSourcesUnchanged(
  draft: BiographyDraft,
  sourceFingerprint: string,
  latestState = loadRoomState(),
): FamilyRoomState | undefined {
  if (biographySourceFingerprint(latestState) !== sourceFingerprint) {
    return undefined;
  }

  const next = { ...latestState, draft };
  saveRoomState(next);
  return next;
}

export function appendContribution(
  contribution: MemoryContribution,
  state = loadRoomState(),
): FamilyRoomState {
  const next = {
    ...state,
    contributions: [...state.contributions, contribution],
    draft: undefined,
  };
  saveRoomState(next);
  return next;
}

export function replaceContribution(
  contribution: MemoryContribution,
  state = loadRoomState(),
): FamilyRoomState {
  const next = {
    ...state,
    contributions: state.contributions.map((item) =>
      item.id === contribution.id ? contribution : item,
    ),
    draft: undefined,
  };
  saveRoomState(next);
  return next;
}

export function resetDemoRoom(): FamilyRoomState {
  const initial = createInitialRoomState();
  saveRoomState(initial);
  return initial;
}
