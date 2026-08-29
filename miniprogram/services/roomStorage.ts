import {
  BiographyDraft,
  biographySourceFingerprint,
  contributionRelatedMemberIds,
  contributionScope,
  createDemoRoomState,
  createEmptyRoomState,
  FamilyMember,
  FamilyRoomState,
  MemoryContribution,
  personalShareTargetMemberIds,
  personalBookSourceFingerprint,
  setPersonalShareTargets,
} from "../domain/biography";

const STORAGE_KEY = "shiguang-family-room-v5";
const V3_STORAGE_KEY = "shiguang-family-room-v3";
const LEGACY_STORAGE_KEY = "shiguang-family-room-v2";

function readStoredRoom(key: string): FamilyRoomState | undefined {
  const stored = wx.getStorageSync<FamilyRoomState>(key);
  if (stored && Array.isArray(stored.contributions) && Array.isArray(stored.members)) {
    return stored;
  }
  return undefined;
}

export function loadRoomState(): FamilyRoomState {
  try {
    const current = readStoredRoom(STORAGE_KEY);
    if (current) return current;

    const previous = readStoredRoom(V3_STORAGE_KEY);
    if (previous) {
      const knownMemberIds = new Set(previous.members.map((member) => member.id));
      const migrated: FamilyRoomState = {
        ...previous,
        contributions: previous.contributions.map((contribution) => {
          const storedTargets: unknown = contribution.sharedWithMemberIds;
          const normalizedTargets = Array.isArray(storedTargets) &&
            storedTargets.every((memberId) => typeof memberId === "string")
            ? Array.from(new Set(storedTargets))
                .filter((memberId) => memberId !== contribution.authorMemberId)
                .filter((memberId) => knownMemberIds.has(memberId))
            : [];

          return {
            ...contribution,
            scope: contributionScope(contribution),
            // v3 只允许一位阅读者；多人数组在旧版属于异常缓存，迁移时继续失败关闭。
            sharedWithMemberIds:
              normalizedTargets.length === 1 ? normalizedTargets : undefined,
          };
        }),
        personalDrafts: previous.personalDrafts ?? {},
      };
      saveRoomState(migrated);
      return migrated;
    }

    const legacy = readStoredRoom(LEGACY_STORAGE_KEY);
    if (legacy) {
      const migrated: FamilyRoomState = {
        ...legacy,
        // v2 没有 scope；一律归入家庭记忆，绝不能猜成某个人的亲历。
        contributions: legacy.contributions.map((contribution) => ({
          ...contribution,
          scope: contributionScope(contribution),
        })),
        personalDrafts: legacy.personalDrafts ?? {},
        // v2 草稿由家庭公开素材生成，不能冒充任何成员的新人生之书。
        draft: undefined,
      };
      saveRoomState(migrated);
      return migrated;
    }
  } catch (error) {
    console.warn("无法读取本地家庭房间，将使用演示数据", error);
  }

  const initial = createEmptyRoomState();
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

export function savePersonalDraftIfSourcesUnchanged(
  draft: BiographyDraft,
  sourceFingerprint: string,
  memberId: string,
  latestState = loadRoomState(),
): FamilyRoomState | undefined {
  if (personalBookSourceFingerprint(latestState, memberId) !== sourceFingerprint) {
    return undefined;
  }

  const next = {
    ...latestState,
    personalDrafts: {
      ...(latestState.personalDrafts ?? {}),
      [memberId]: draft,
    },
  };
  saveRoomState(next);
  return next;
}

export function appendContribution(
  contribution: MemoryContribution,
  state = loadRoomState(),
): FamilyRoomState {
  const memberIds = new Set(state.members.map((member) => member.id));
  if (!memberIds.has(contribution.authorMemberId)) {
    throw new Error("讲述者已不在当前亲友空间");
  }
  const referencedMemberIds = contributionRelatedMemberIds(contribution).concat(
    personalShareTargetMemberIds(contribution),
  );
  if (referencedMemberIds.some((memberId) => !memberIds.has(memberId))) {
    throw new Error("故事中包含已离开空间的亲友");
  }

  const personalDrafts = { ...(state.personalDrafts ?? {}) };
  if (contributionScope(contribution) === "personal") {
    delete personalDrafts[contribution.authorMemberId];
  }

  const next = {
    ...state,
    contributions: [...state.contributions, contribution],
    personalDrafts,
    draft: contributionScope(contribution) === "family" ? undefined : state.draft,
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

export function deleteContribution(
  contributionId: string,
  state = loadRoomState(),
): FamilyRoomState {
  const contribution = state.contributions.find((item) => item.id === contributionId);
  if (!contribution) {
    throw new Error("没有找到这段记忆");
  }

  const personalDrafts = { ...(state.personalDrafts ?? {}) };
  if (contributionScope(contribution) === "personal") {
    delete personalDrafts[contribution.authorMemberId];
  }

  const next = {
    ...state,
    contributions: state.contributions.filter((item) => item.id !== contributionId),
    draft: contributionScope(contribution) === "family" ? undefined : state.draft,
    personalDrafts,
  };
  saveRoomState(next);
  return next;
}

/**
 * 只更新个人故事的定向阅读者。
 * 分享权限不是书稿来源的一部分，因此不应让个人章节或家庭章节失效。
 */
/**
 * 更新一段故事的阅读名单。提交时重新读取成员和故事，避免旧页面快照覆盖新数据。
 */
export function updatePersonalShareTargets(
  contributionId: string,
  actor: FamilyMember,
  targetMemberIds: string[],
): FamilyRoomState {
  const state = loadRoomState();
  const currentActor = state.members.find((member) => member.id === actor.id);
  if (!currentActor) {
    throw new Error("当前身份已不在这个亲友空间");
  }

  const uniqueTargetIds = Array.from(new Set(targetMemberIds));
  if (
    uniqueTargetIds.length !== targetMemberIds.length ||
    uniqueTargetIds.some(
      (memberId) =>
        memberId === currentActor.id ||
        !state.members.some((member) => member.id === memberId),
    )
  ) {
    throw new Error("请选择仍在空间里的亲友");
  }

  const contribution = state.contributions.find((item) => item.id === contributionId);
  if (!contribution) {
    throw new Error("没有找到这段故事");
  }

  const updated = setPersonalShareTargets(
    contribution,
    currentActor,
    uniqueTargetIds,
  );
  const next = {
    ...state,
    contributions: state.contributions.map((item) =>
      item.id === contributionId ? updated : item,
    ),
  };
  saveRoomState(next);
  return next;
}

export function resetDemoRoom(): FamilyRoomState {
  const initial = createDemoRoomState();
  saveRoomState(initial);
  return initial;
}

export function resetCurrentRoom(): FamilyRoomState {
  const initial = createEmptyRoomState();
  saveRoomState(initial);
  saveCurrentMemberId(DEFAULT_MEMBER_ID);
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
