export type Visibility = "family" | "private";
export type ReviewStatus = "pending" | "confirmed" | "rejected" | "conflict";
export type ReviewerRole = "elder" | "owner" | "contributor";
export type GenerationMode = "local-demo" | "cloud-ai";

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
  visibility: Visibility;
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
  draft?: BiographyDraft;
}

export interface CreateContributionInput {
  authorMemberId: string;
  authorName: string;
  relation: string;
  text: string;
  visibility: Visibility;
  now?: Date;
  id?: string;
}

export const MAX_MEMORY_LENGTH = 500;
export const VISIBILITY_LABELS: Record<Visibility, string> = {
  family: "家庭可见",
  private: "私密提交 · 仅本人和老人可见",
};

function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
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

  return {
    id,
    authorMemberId: input.authorMemberId,
    authorName: input.authorName,
    relation: input.relation,
    text,
    visibility: input.visibility,
    reviewStatus: "pending",
    createdAt: now.toISOString(),
  };
}

export function reviewContribution(
  contribution: MemoryContribution,
  reviewStatus: Exclude<ReviewStatus, "pending">,
  reviewerRole: ReviewerRole,
): MemoryContribution {
  if (reviewerRole !== "elder") {
    throw new Error("只有传记主人公可以确认事实");
  }

  return { ...contribution, reviewStatus };
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
      contribution.reviewStatus === "confirmed" && contribution.visibility === "family",
  );
}

export function visibleContributionsForMember(
  contributions: MemoryContribution[],
  viewer: FamilyMember,
): MemoryContribution[] {
  if (viewer.role === "elder") return contributions;

  return contributions.filter(
    (contribution) =>
      contribution.visibility === "family" || contribution.authorMemberId === viewer.id,
  );
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
        id: "demo-memory-rain",
        authorMemberId: "owner",
        authorName: "林岚",
        relation: "外孙女",
        text: "小时候每逢下雨，外公都会提前站在巷口等我放学，手里总多带一把小伞。",
        visibility: "family",
        now: new Date("2026-08-28T02:10:00.000Z"),
      }),
      createContribution({
        id: "demo-memory-radio",
        authorMemberId: "member-1",
        authorName: "林秋",
        relation: "女儿",
        text: "父亲年轻时喜欢修收音机，邻居家的机器坏了也常来找他。具体是哪一年，我记不清了。",
        visibility: "family",
        now: new Date("2026-08-28T02:18:00.000Z"),
      }),
    ],
  };
}
