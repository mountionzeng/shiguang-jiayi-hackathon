import {
  BiographyDraft,
  biographySourceFingerprint,
  createInitialRoomState,
  FamilyMember,
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

const CURRENT_MEMBER_KEY = "shiguang-current-member-v1";
const DEFAULT_MEMBER_ID = "owner";

/**
 * 黑客松阶段用本地"演示身份"代替真实微信身份。
 * 界面上必须标注这是演示切换，不能让它看起来像已经打通的跨设备成员系统。
 */
export function loadCurrentMemberId(): string {
  try {
    const stored = wx.getStorageSync<string>(CURRENT_MEMBER_KEY);
    if (typeof stored === "string" && stored) return stored;
  } catch (error) {
    console.warn("无法读取当前演示身份，将回到默认身份", error);
  }
  return DEFAULT_MEMBER_ID;
}

export function saveCurrentMemberId(memberId: string): void {
  wx.setStorageSync(CURRENT_MEMBER_KEY, memberId);
}

export function loadCurrentMember(state: FamilyRoomState = loadRoomState()): FamilyMember {
  const memberId = loadCurrentMemberId();
  return (
    state.members.find((member) => member.id === memberId) ??
    state.members.find((member) => member.id === DEFAULT_MEMBER_ID) ??
    state.members[0]
  );
}
