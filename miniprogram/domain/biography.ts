export type Visibility = "family" | "private";
export type ReviewStatus = "pending" | "confirmed" | "rejected" | "conflict";
export type ReviewerRole = "elder" | "owner" | "contributor";
export type GenerationMode = "local-demo" | "cloud-ai";
export type MemoryScope = "personal" | "family";

/**
 * 片段类型，沿用队友原型的「随手记 / 回忆录」两种写法。
 * 它只是给内容贴的标签，不再像原型那样在入口处分成两条路径：
 * 采访入口仍然只有一个，类型在整理时才选。
 */
export type MemoryType = "note" | "memoir";

export interface FamilyMember {
  id: string;
  name: string;
  relation: string;
  avatarText: string;
  role: ReviewerRole;
}

export interface MemoryContribution {
  id: string;
  authorMemberId: string;
  authorName: string;
  relation: string;
  text: string;
  title?: string;
  memoryType?: MemoryType;
  /**
   * personal：讲述人自己的亲历，只进入他/她的人生之书。
   * family：与家人的共同记忆，只在确认后进入记忆之家。
   *
   * 旧版缓存没有该字段；读取时一律按 family 处理，避免旧家庭素材误入个人书。
   */
  scope?: MemoryScope;
  visibility: Visibility;
  /**
   * 个人故事可额外授权给指定家人阅读。
   * 这只是阅读权限，不改变故事归属，也不会让内容进入记忆之家或他人的人生之书。
   * 当前版本只允许零或一位接收者；数组形态仅用于缓存兼容，多个不同 ID 会失败关闭。
   */
  sharedWithMemberIds?: string[];
  reviewStatus: ReviewStatus;
  createdAt: string;
}

export interface BiographyDraft {
  title: string;
  paragraphs: string[];
  sourceCount: number;
  generatedAt: string;
  generationMode: GenerationMode;
}

export interface FamilyRoomState {
  roomName: string;
  protagonistName: string;
  members: FamilyMember[];
  contributions: MemoryContribution[];
  personalDrafts?: Record<string, BiographyDraft>;
  /** @deprecated 旧版以家庭主人公为中心的章节草稿，只保留用于缓存兼容。 */
  draft?: BiographyDraft;
}

export interface CreateContributionInput {
  authorMemberId: string;
  authorName: string;
  relation: string;
  text: string;
  title?: string;
  memoryType?: MemoryType;
  scope?: MemoryScope;
  visibility: Visibility;
  sharedWithMemberId?: string;
  now?: Date;
  id?: string;
}

export const MAX_MEMORY_LENGTH = 500;
export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  note: "随手记",
  memoir: "回忆录",
};
export const VISIBILITY_LABELS: Record<Visibility, string> = {
  family: "家庭可见",
  private: "仅自己可见",
};

export function contributionScope(contribution: MemoryContribution): MemoryScope {
  return contribution.scope ?? "family";
}

function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizeShareTargets(memberIds: unknown, authorMemberId: string): string[] {
  if (!Array.isArray(memberIds)) return [];
  return Array.from(
    new Set(
      memberIds
        .filter((memberId): memberId is string => typeof memberId === "string")
        .map((memberId) => memberId.trim())
        .filter(Boolean),
    ),
  ).filter((memberId) => memberId !== authorMemberId);
}

export function createContribution(input: CreateContributionInput): MemoryContribution {
  const text = normalizeMemoryText(input.text);

  if (!text) {
    throw new Error("请先写下一段回忆");
  }

  if (text.length > MAX_MEMORY_LENGTH) {
    throw new Error(`单次回忆不能超过 ${MAX_MEMORY_LENGTH} 字`);
  }

  const now = input.now ?? new Date();
  const id = input.id ?? `memory-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  const scope = input.scope ?? "family";
  const shareTargets =
    scope === "personal"
      ? normalizeShareTargets([input.sharedWithMemberId], input.authorMemberId)
      : [];

  return {
    id,
    authorMemberId: input.authorMemberId,
    authorName: input.authorName,
    relation: input.relation,
    text,
    title: input.title?.trim() || undefined,
    memoryType: input.memoryType ?? "note",
    scope,
    visibility: scope === "personal" ? "private" : input.visibility,
    sharedWithMemberIds: shareTargets.length > 0 ? shareTargets : undefined,
    // 自己讲自己的故事，无需交给另一位“主人公”确认。
    reviewStatus: scope === "personal" ? "confirmed" : "pending",
    createdAt: now.toISOString(),
  };
}

export function reviewContribution(
  contribution: MemoryContribution,
  reviewStatus: Exclude<ReviewStatus, "pending">,
  reviewerRole: ReviewerRole,
): MemoryContribution {
  if (contributionScope(contribution) === "personal") {
    throw new Error("个人故事由讲述者本人负责，不进入家庭确认");
  }
  if (reviewerRole !== "elder") {
    throw new Error("只有传记主人公可以确认事实");
  }

  return { ...contribution, reviewStatus };
}

export function pendingFamilyContributions(
  contributions: MemoryContribution[],
): MemoryContribution[] {
  return contributions.filter(
    (contribution) =>
      contributionScope(contribution) === "family" &&
      contribution.reviewStatus === "pending",
  );
}

export function confirmedContributions(
  contributions: MemoryContribution[],
): MemoryContribution[] {
  return contributions.filter((contribution) => contribution.reviewStatus === "confirmed");
}

export function biographySourceContributions(
  contributions: MemoryContribution[],
): MemoryContribution[] {
  return contributions.filter(
    (contribution) =>
      contributionScope(contribution) === "family" &&
      contribution.reviewStatus === "confirmed" &&
      contribution.visibility === "family",
  );
}

/** 当前用户人生之书的素材：只取他/她亲自讲述的个人故事。 */
export function personalBookContributions(
  contributions: MemoryContribution[],
  memberId: string,
): MemoryContribution[] {
  return contributions.filter(
    (contribution) =>
      contributionScope(contribution) === "personal" &&
      contribution.authorMemberId === memberId,
  );
}

/** 对本地缓存中的分享对象做失败关闭的读取，异常字段绝不能变成阅读授权。 */
export function personalShareTargetMemberIds(
  contribution: MemoryContribution,
): string[] {
  if (contributionScope(contribution) !== "personal") return [];

  const storedTargets: unknown = contribution.sharedWithMemberIds;
  if (
    !Array.isArray(storedTargets) ||
    !storedTargets.every((memberId) => typeof memberId === "string")
  ) {
    return [];
  }

  const normalizedTargets = normalizeShareTargets(
    storedTargets,
    contribution.authorMemberId,
  );
  return normalizedTargets.length <= 1 ? normalizedTargets : [];
}

/** 指定家人收到的个人故事：只授予阅读权，不会成为对方的人生之书素材。 */
export function sharedPersonalContributionsForMember(
  contributions: MemoryContribution[],
  memberId: string,
): MemoryContribution[] {
  return contributions.filter(
    (contribution) =>
      contributionScope(contribution) === "personal" &&
      contribution.authorMemberId !== memberId &&
      personalShareTargetMemberIds(contribution).includes(memberId),
  );
}

/** 个人故事的主人可以指定一位家人阅读，传 undefined 即取消定向分享。 */
export function setPersonalShareTarget(
  contribution: MemoryContribution,
  actor: FamilyMember,
  targetMemberId?: string,
): MemoryContribution {
  if (contributionScope(contribution) !== "personal") {
    throw new Error("只有个人故事可以定向分享");
  }
  if (contribution.authorMemberId !== actor.id) {
    throw new Error("只有故事的主人可以更改分享对象");
  }

  const target = targetMemberId?.trim();
  if (target === actor.id) {
    throw new Error("不能分享给自己");
  }

  return {
    ...contribution,
    sharedWithMemberIds: target ? [target] : undefined,
  };
}

/**
 * 家人视角能看到的原始片段。
 *
 * 规则来源：共享人生之书需求 R9。
 * - 老人拥有确认权，因此看得到全部原始片段。
 * - 其他家人只看得到自己投稿的内容，以及"已确认且家庭可见"的内容。
 * - 未经确认的家庭可见投稿不再对其他家人公开，避免未核实说法提前影响家人记忆。
 */
export function visibleContributionsForMember(
  contributions: MemoryContribution[],
  viewer: FamilyMember,
): MemoryContribution[] {
  return contributions.filter((contribution) => {
    if (contributionScope(contribution) === "personal") {
      return (
        contribution.authorMemberId === viewer.id ||
        personalShareTargetMemberIds(contribution).includes(viewer.id)
      );
    }
    if (viewer.role === "elder") return true;
    if (contribution.authorMemberId === viewer.id) return true;
    return contribution.visibility === "family" && contribution.reviewStatus === "confirmed";
  });
}

/**
 * "待确认"入口在不同身份下指向不同的集合：
 * 老人看到需要自己处理的全部待确认片段，家人只看到自己投稿的等待状态。
 */
export function pendingContributionsFor(
  contributions: MemoryContribution[],
  viewer: FamilyMember,
): MemoryContribution[] {
  const pending = pendingFamilyContributions(contributions);
  if (viewer.role === "elder") return pending;
  return pending.filter((contribution) => contribution.authorMemberId === viewer.id);
}

export function biographySourceFingerprint(state: FamilyRoomState): string {
  return JSON.stringify({
    protagonistName: state.protagonistName,
    sources: biographySourceContributions(state.contributions)
      .map((memory) => ({
        id: memory.id,
        authorMemberId: memory.authorMemberId,
        authorName: memory.authorName,
        relation: memory.relation,
        text: memory.text,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export function personalBookSourceFingerprint(
  state: FamilyRoomState,
  memberId: string,
): string {
  return JSON.stringify({
    memberId,
    sources: personalBookContributions(state.contributions, memberId)
      .map((memory) => ({
        id: memory.id,
        text: memory.text,
        title: memory.title,
        memoryType: memory.memoryType,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export function buildLocalBiographyDraft(
  protagonistName: string,
  contributions: MemoryContribution[],
  now = new Date(),
): BiographyDraft {
  const confirmed = biographySourceContributions(contributions);

  if (confirmed.length === 0) {
    throw new Error("至少确认一段回忆后才能生成章节");
  }

  const paragraphs = [
    `这是关于${protagonistName}的第一章。以下文字只整理自 ${confirmed.length} 条已经由本人确认的家庭回忆。`,
    ...confirmed.map(
      (memory) => `“${memory.text}”——${memory.authorName}（${memory.relation}）`,
    ),
    "这些片段先被认真地收在这里，等待下一位家人继续讲述，也等待主人公亲自补上更多细节。",
  ];

  return {
    title: "第一章｜被记住的日常",
    paragraphs,
    sourceCount: confirmed.length,
    generatedAt: now.toISOString(),
    generationMode: "local-demo",
  };
}

export function buildLocalPersonalBiographyDraft(
  memberName: string,
  memberId: string,
  contributions: MemoryContribution[],
  now = new Date(),
): BiographyDraft {
  const personal = personalBookContributions(contributions, memberId);

  if (personal.length === 0) {
    throw new Error("至少写下一段自己的经历后才能生成章节");
  }

  return {
    title: "第一章｜我记得的那一天",
    paragraphs: [
      `这是${memberName}亲自讲述的人生片段。以下文字只整理自 ${personal.length} 段自己的回忆。`,
      ...personal.map((memory) => `“${memory.text}”`),
      "这些亲历先被认真地收在这里，等我想起更多细节，再继续往下写。",
    ],
    sourceCount: personal.length,
    generatedAt: now.toISOString(),
    generationMode: "local-demo",
  };
}

export function createInitialRoomState(): FamilyRoomState {
  return {
    roomName: "林家的拾光房间",
    protagonistName: "林致远",
    members: [
      { id: "elder", name: "林致远", relation: "主人公", avatarText: "远", role: "elder" },
      { id: "owner", name: "林岚", relation: "外孙女", avatarText: "岚", role: "owner" },
      { id: "member-1", name: "林秋", relation: "女儿", avatarText: "秋", role: "contributor" },
      { id: "member-2", name: "陈野", relation: "女婿", avatarText: "野", role: "contributor" },
    ],
    contributions: [
      createContribution({
        id: "demo-personal-rain",
        authorMemberId: "owner",
        authorName: "林岚",
        relation: "外孙女",
        text: "我小时候最喜欢下雨天，因为放学走到巷口时，总能看见外公带着两把伞在那里等我。",
        scope: "personal",
        visibility: "private",
        now: new Date("2026-08-28T02:05:00.000Z"),
      }),
      reviewContribution(
        createContribution({
          id: "demo-memory-rain",
          authorMemberId: "owner",
          authorName: "林岚",
          relation: "外孙女",
          text: "小时候每逢下雨，外公都会提前站在巷口等我放学，手里总多带一把小伞。",
          scope: "family",
          visibility: "family",
          now: new Date("2026-08-28T02:10:00.000Z"),
        }),
        "confirmed",
        "elder",
      ),
      createContribution({
        id: "demo-memory-radio",
        authorMemberId: "member-1",
        authorName: "林秋",
        relation: "女儿",
        text: "父亲年轻时喜欢修收音机，邻居家的机器坏了也常来找他。具体是哪一年，我记不清了。",
        scope: "family",
        visibility: "family",
        now: new Date("2026-08-28T02:18:00.000Z"),
      }),
    ],
  };
}

/**
 * 从记忆之家撤下自己的片段。
 *
 * 规则来源：交接文档「取消分享／从记忆之家删除」。
 * 只撤销"家庭可见"这一件事：原始内容仍由投稿人保留，老人依然看得到，
 * 老人的确认结论也不受影响。真正的删除是另一个动作，必须由本人另行明确执行。
 */
export function revokeFamilyVisibility(
  contribution: MemoryContribution,
  actor: FamilyMember,
): MemoryContribution {
  if (contribution.authorMemberId !== actor.id) {
    throw new Error("只有讲述这段回忆的人可以把它撤下");
  }

  if (contribution.visibility === "private") return contribution;

  return { ...contribution, visibility: "private" };
}
