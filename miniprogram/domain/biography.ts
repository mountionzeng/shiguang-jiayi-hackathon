export type Visibility = "family" | "private";
export type ReviewStatus = "pending" | "confirmed" | "rejected" | "conflict";
export type ReviewerRole = "elder" | "owner" | "contributor";
export type GenerationMode = "local-demo" | "cloud-ai";
export type MemoryScope = "personal" | "family";
export type OrganizationMode = "local-demo" | "cloud-ai";

/**
 * 片段类型，沿用队友原型的「随手记 / 回忆录」两种写法。
 * 它只是给内容贴的标签，不再像原型那样在入口处分成两条路径：
 * 采访入口仍然只有一个，类型在整理时才选。
 */
export type MemoryType = "note" | "memoir";

/**
 * 记忆分段：接着讲＝给同一条记忆追加一段，不再另存一条记忆。
 * 规则来源：docs/2026-09-15-memory-segments-plan.md，问题八转达用户 2026-09-15 决定。
 */
export type MemorySegmentSource = "note" | "continue" | "daily-question" | "import";

export interface MemorySegment {
  /** 段内唯一，不跨记忆。 */
  id: string;
  text: string;
  createdAt: string;
  source: MemorySegmentSource;
  organizationMode?: OrganizationMode;
}

/**
 * 一条记忆的「原话 → AI 整理 → 人工修改」历史。
 * spoken：用户亲口说的原话（首条恒为它，可一键撤回到这里）；
 * ai：AI 整理后的版本；manual：用户在整理结果上亲手改过；restore：撤回到原话。
 * 规则来源：P0 #5「AI 生成文字持久显示 AI 整理，支持查看原文、撤回、人工修改历史」。
 * contribution.text 恒等于最后一条 revision 的 text（旧调用方只读 text，不受影响）。
 */
export type MemoryAiRevisionKind = "spoken" | "ai" | "manual" | "restore";

export interface MemoryAiRevision {
  id: string;
  kind: MemoryAiRevisionKind;
  text: string;
  title?: string;
  /** An explicitly saved dated version remains discoverable in the existing history. */
  saveKind?: "update-current" | "dated-version";
  versionLabel?: string;
  createdAt: string;
  organizationMode?: OrganizationMode;
}

export interface FamilyMember {
  id: string;
  name: string;
  relation: string;
  avatarText: string;
  role: ReviewerRole;
  /** Missing on legacy demo profiles; preserve them until explicitly classified. */
  kind?: "recording-profile" | "person";
  /** Soft delete: hidden everywhere and listed under "最近删除"; nothing else is removed. */
  deletedAt?: string;
}

export function isActiveMember(member: FamilyMember): boolean {
  return !member.deletedAt;
}

/** Profiles that own a book and can be switched to. Unclassified legacy profiles stay reachable. */
export function isRecordingProfile(member: FamilyMember): boolean {
  return isActiveMember(member) && member.kind !== "person";
}

export function isPerson(member: FamilyMember): boolean {
  return isActiveMember(member) && member.kind === "person";
}

export function needsClassification(member: FamilyMember): boolean {
  return isActiveMember(member) && !member.kind;
}

/**
 * 本账号的主人：首页头像、「我的」和聊天默认的讲述人都是他/她。
 * 优先认「自己」这本书，其次是账号建的第一个档案（role 为 owner）。
 */
export function accountOwner(members: FamilyMember[]): FamilyMember | undefined {
  const profiles = members.filter(isRecordingProfile);
  return profiles.find((member) => member.relation === "自己") ??
    profiles.find((member) => member.role === "owner");
}

export interface MemoryContribution {
  id: string;
  authorMemberId: string;
  authorName: string;
  relation: string;
  text: string;
  title?: string;
  summary?: string;
  emotions?: string[];
  people?: string[];
  places?: string[];
  organizationMode?: OrganizationMode;
  memoryType?: MemoryType;
  /**
   * 可选的故事名称。没有名称时，它仍是一条完整保存的「未整理片段」。
   * 故事名称与阅读权限彼此独立：归入同一故事不等于自动向任何人公开。
   */
  storyTitle?: string;
  /** 这段记忆里涉及的亲友；仅用于整理与筛选，不自动授予阅读权。 */
  relatedMemberIds?: string[];
  /**
   * personal：讲述人自己的亲历，只进入他/她的人生之书。
   * family：与家人的共同记忆，只在确认后进入记忆之家。
   *
   * 旧版缓存没有该字段；读取时一律按 family 处理，避免旧家庭素材误入个人书。
   */
  scope?: MemoryScope;
  visibility: Visibility;
  /**
   * 谁可以阅读这段个人故事。2026-09-15 起默认等于 relatedMemberIds（提到谁，谁就能看到）；
   * 不再单独询问。仍是独立字段，创建后可以单独调整（例如日后想收回某一位的阅读权）。
   * 这只是阅读权限，不改变故事归属，也不会让内容进入记忆之家或他人的人生之书。
   */
  sharedWithMemberIds?: string[];
  reviewStatus: ReviewStatus;
  createdAt: string;
  /**
   * 接着讲追加的段落。有这个字段时，`text` 始终等于各段按顺序拼接（旧客户端、
   * AI 整理入口、列表摘要都只读 text，不用改）。没有这个字段的旧记忆按只有一段处理。
   */
  segments?: MemorySegment[];
  /**
   * 软删除：放进「最近删除」，从所有正常列表里隐去，可以恢复。已经写进某一章的原文
   * 不受影响——删除来源记忆，不会拿掉书稿里已经存下的字。真正永久删除是另一个动作。
   */
  deletedAt?: string;
  /**
   * 挂在整条记忆上，不挂在某一段：最多 9 张，问题九（照片上云）负责上传和格式。
   * 只有照片、没写一句话时，text 允许为空——见 createContribution 的校验。
   */
  photoIds?: string[];
  /**
   * 原话 → AI 整理 → 人工修改的历史。有这个字段时首条恒为 spoken 原话，
   * text 等于最后一条 revision 的 text。旧记忆没有这个字段，按「只有原话」处理。
   */
  aiRevisions?: MemoryAiRevision[];
}

export const MAX_MEMORY_PHOTOS = 9;

export function isActiveMemory(contribution: MemoryContribution): boolean {
  return !contribution.deletedAt;
}

export interface BiographyDraft {
  /** Unknown versions must never be flattened and saved by legacy editors. */
  provenanceVersion?: 1;
  title: string;
  paragraphs: string[];
  sourceCount: number;
  generatedAt: string;
  generationMode: GenerationMode;
  /** Text and opaque image references only. No device paths, temporary URLs or image bytes go to cloud. */
  content?: ManuscriptContent[];
  /**
   * The book's own table of contents; `title` stays the book title. When present,
   * `paragraphs`/`content` hold a derived flattened copy so older clients still read
   * the whole book, photos included.
   */
  chapters?: ManuscriptChapter[];
}

/** Server-assigned provenance. Presence requires the protected editing protocol. */
export interface ManuscriptBlockProvenance { blockId?: string; sourceIds?: string[] }
export type ManuscriptContent = ({ text: string; photoId?: never } | { photoId: string; text?: never }) & ManuscriptBlockProvenance;

export interface ManuscriptChapter {
  /** Stable across versions so a rearranged version still refers to the same chapter. */
  id: string;
  /** Chapter name only; "第X章" follows the chapter order and is never stored. */
  title: string;
  /** Raw memories arranged into this chapter in this version. */
  memoryIds: string[];
  content: ManuscriptContent[];
  /** The user rewrote this chapter by hand; AI must not replace it without asking. */
  handEdited?: boolean;
  generationMode?: GenerationMode;
  generatedAt?: string;
  /** A picture from the storyImages cloud function shown under this chapter's text; travels with the version. */
  backdropImageId?: string;
  /**
   * memoryId -> 这一章上次用到这条记忆时，它一共有几段。不精确记到第几段，
   * 只用来推出「这一章有没有新的一段没写进」：当前段数比这个数大就是有。
   * 规则来源：docs/2026-09-15-memory-segments-plan.md。
   */
  memorySegmentCounts?: Record<string, number>;
  /**
   * 待确认的修订：写进一条记忆、或（以后）AI 重新整理这一章时产生，逐条确认/不要，
   * 全部处理完才会生成新版本；处理到一半退出页面，这个字段还在，下次回来接着确认。
   * 规则来源：docs/2026-09-15-memory-segments-plan.md，问题八转达用户 2026-09-15 决定。
   */
  pendingRevision?: PendingChapterRevision;
  /**
   * 这一章的正文里有没有 AI 生成的文字（哪怕只是接受了其中一处新增），和
   * `generationMode`（整章由谁生成的）、`handEdited`（用户在编辑器里亲手改过）分开记：
   * 一章可以同时「含 AI 文字」又「被手改过」。只会被置为 true，不会自动退回 false。
   */
  containsAiText?: boolean;
}

export type ChapterEditSource = "ai" | "memory";
export type ChapterEditStatus = "pending" | "accepted" | "rejected";

export interface ChapterEdit {
  id: string;
  kind: "insert" | "delete";
  /** insert：提议新增的文字；delete：提议删掉的原文，用来对照展示，也用来核对 anchor 有没有对上。 */
  text: string;
  /** ai：AI 新增/建议删除/改写，框里标「AI 生成」/「AI 建议删除」；memory：用户原话直接追加，不标。 */
  source: ChapterEditSource;
  memoryId?: string;
  /** insert 且来自某条记忆时：提出这条修订那一刻，这条记忆一共有几段；确认后用它更新水位，不用重新查记忆。 */
  memorySegmentCountAtProposal?: number;
  /**
   * 定位在正文里的具体位置：用「这一章跳过图片、把文本块按顺序拼起来的纯文字」
   * 算字符偏移（services/chapters.ts 的 chapterPlainText）。delete 必须有 anchor，
   * 标出要删的原文在哪一段；insert 没有 anchor 时接到正文末尾（写进一条记忆的默认做法），
   * 有 anchor 时插在这个位置（start===end 是插入点，比如紧跟在同一次提出的删除之后）。
   * 选段跨了图片或跨了两个文本块时不生成 anchor，交给前端提前拦住。
   */
  anchor?: { start: number; end: number };
  status: ChapterEditStatus;
}

export interface PendingChapterRevision {
  createdAt: string;
  edits: ChapterEdit[];
}

export interface FamilyRoomState {
  stories?: Story[];
  storyMigration?: { version: number; status: "preparing" | "restarting" | "active"; pending: StoryMigrationItem[] };
  storyOperations?: Record<string, { fingerprint: string; storyId: string }>;
  importedCloudRooms?: string[];
  roomName: string;
  protagonistName: string;
  members: FamilyMember[];
  contributions: MemoryContribution[];
  personalDrafts?: Record<string, BiographyDraft>;
  /** Retained generated text, even when its sources have changed. */
  legacyPersonalDrafts?: Record<string, BiographyDraft>;
  manuscriptRevisions?: ManuscriptRevision[];
  /** Hidden from 人生之书, while source memories and manuscript versions remain recoverable. */
  deletedStories?: DeletedStory[];
  /** @deprecated 旧版以家庭主人公为中心的章节草稿，只保留用于缓存兼容。 */
  draft?: BiographyDraft;
}

export interface DeletedStory {
  key: string;
  title: string;
  deletedAt: string;
}

/**
 * 一个真正的故事记录（阶段 A：只是类型，还没有集合在读写它）。
 * id 稳定：改名、书稿和同名记忆合并，都不会变。
 *
 * 规则来源：docs/2026-09-14-story-records-plan.md，用户 2026-09-14 确认。
 */
/** One independent story book. 人生之书 is the shelf of all Story records, never a single record. */
export interface Story {
  /** Server-owned marker; ownership does not override source distribution restrictions. */
  sourcePolicyRequired?: boolean;
  id: string;
  familyId: string;
  /** 同一账号内不重名（去掉首尾空格后比较，不含已删除的故事）。 */
  title: string;
  bookTitle?: string;
  writingMode?: "objective" | "creative";
  version?: number;
  currentRevisionId?: string;
  imageIds?: string[];
  /** 这个故事的主人公；可以是任何人，也可以没有。 */
  protagonistMemberIds: string[];
  /** 这个故事的素材：属于它的全部记忆，不论写没写进章节。一段记忆可以在多个故事里。 */
  memoryIds: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  /** 预留给问题五：故事封面图片引用。 */
  coverImageId?: string;
  /**
   * memoryId -> 用户在这个故事里对这条记忆点过「先不用」时，它当时有几段。
   * 每日一问只在当前段数比这个数还多时才会再问同一条记忆；选「写进」不受影响。
   * 规则来源：docs/2026-09-15-memory-segments-plan.md。
   */
  declinedSegments?: Record<string, number>;
  /** 从旧数据迁移来的故事，记一笔来源，方便回溯和旧客户端兼容。只读，不参与身份判断。 */
  legacy?: {
    memberId?: string;
    storyTitle?: string;
    /** 迁移前这个故事在 services/storyShelf.ts 里的 key（`story:标题` 或 `manuscript:档案id`）。
     * 给发到电脑端的快照做过渡：新旧 key 都带上，服务端按旧 key 认出同一个故事，避免换 id 后重复入库。 */
    previousShelfKey?: string;
  };
}

export interface ManuscriptRevision {
  id: string;
  storyId?: string;
  expectedStoryVersion?: number;
  sourceRevisionId?: string;
  memberId: string;
  kind: "draft" | "version" | "restore";
  label: string;
  savedAt: string;
  sourceFingerprint: string;
  draft: BiographyDraft;
}

export interface StoryMigrationChapterItem {
  id: string;
  kind?: "chapter";
  sourceRevisionId: string;
  memberId: string;
  chapter: ManuscriptChapter;
  reason: string;
  resolvedStoryId?: string;
}

export interface StoryMigrationAssetItem {
  id: string;
  kind: "image" | "image-job";
  reason: string;
  imageId?: string;
  jobId?: string;
  status?: string;
  resolvedStoryId?: string;
}

export type StoryMigrationItem = StoryMigrationChapterItem | StoryMigrationAssetItem;

export interface CreateContributionInput {
  authorMemberId: string;
  authorName: string;
  relation: string;
  text: string;
  title?: string;
  summary?: string;
  emotions?: string[];
  people?: string[];
  places?: string[];
  organizationMode?: OrganizationMode;
  memoryType?: MemoryType;
  storyTitle?: string;
  relatedMemberIds?: string[];
  scope?: MemoryScope;
  visibility: Visibility;
  /** 不传时，个人故事默认分享给 relatedMemberIds；传空数组表示明确不分享给任何人。 */
  sharedWithMemberIds?: string[];
  /** @deprecated 兼容旧调用方；新界面使用 sharedWithMemberIds。 */
  sharedWithMemberId?: string;
  /** 仅供退出恢复分片使用：输入已经整体规范化，需保留片段边界字符。 */
  preserveNormalizedText?: boolean;
  /** 有照片时 text 可以留空（只有照片、没写一句话）；最多 9 张，格式由问题九校验。 */
  photoIds?: string[];
  /** 原话→整理历史；不传时，新建的记忆按「只有原话」处理（首条 spoken 自动补上）。 */
  aiRevisions?: MemoryAiRevision[];
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

/**
 * 这条记忆的段落。旧记忆（没有 `segments`）当作只有一段，段本身就是整条记忆：
 * 段 id 复用记忆 id，来源按 note 处理，时间用记忆自己的 createdAt。
 * 对损坏字段失败关闭：非法的 `segments` 一律当作没有，回退成单段读法。
 */
export function memorySegments(contribution: MemoryContribution): MemorySegment[] {
  const stored: unknown = contribution.segments;
  if (
    Array.isArray(stored) &&
    stored.length > 0 &&
    stored.every((segment) =>
      segment &&
      typeof segment.id === "string" &&
      typeof segment.text === "string" &&
      typeof segment.createdAt === "string")
  ) {
    return stored as MemorySegment[];
  }
  return [{
    id: contribution.id,
    text: contribution.text,
    createdAt: contribution.createdAt,
    source: "note",
    organizationMode: contribution.organizationMode,
  }];
}

export function memorySegmentCount(contribution: MemoryContribution): number {
  return memorySegments(contribution).length;
}

/**
 * 接着讲：给这条记忆追加一段，`text` 跟着更新成新的拼接结果，其余字段（包括
 * `reviewStatus`、`storyTitle`）原样保留——归类和权限不因为多讲了一段而改变。
 * 新增段落单独受 500 字限制，拼起来的整条记忆不设上限。
 */
export function appendMemorySegment(
  contribution: MemoryContribution,
  text: string,
  source: MemorySegmentSource,
  organizationMode?: OrganizationMode,
  now = new Date(),
): MemoryContribution {
  const normalized = normalizeMemoryText(text);
  if (!normalized) throw new Error("请先写下这一段");
  if (normalized.length > MAX_MEMORY_LENGTH) {
    throw new Error(`单次回忆不能超过 ${MAX_MEMORY_LENGTH} 字`);
  }
  const existing = memorySegments(contribution);
  const segment: MemorySegment = {
    id: `segment-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    text: normalized,
    createdAt: now.toISOString(),
    source,
    organizationMode,
  };
  const segments = [...existing, segment];
  return {
    ...contribution,
    segments,
    text: segments.map((item) => item.text).join("\n"),
    organizationMode: organizationMode ?? contribution.organizationMode,
  };
}

const AI_TEXT_LABEL = "文字 AI 生成";
const AI_TEXT_EDITED_LABEL = "文字 AI 生成 · 已由你修改";

/**
 * 这条记忆的原话→整理历史。失败关闭：非法的 `aiRevisions` 一律当作没有
 * （照 memorySegments() 的写法），此时视为「只有原话」，不会假装有 AI 整理过。
 */
export function memoryAiRevisions(contribution: MemoryContribution): MemoryAiRevision[] {
  const stored: unknown = contribution.aiRevisions;
  if (
    Array.isArray(stored) &&
    stored.length > 0 &&
    stored.every((revision) =>
      revision &&
      typeof revision.id === "string" &&
      typeof revision.kind === "string" &&
      typeof revision.text === "string" &&
      typeof revision.createdAt === "string")
  ) {
    return stored as MemoryAiRevision[];
  }
  return [];
}

/** 首条原话（没有历史记录时，回退成当前 text——兼容没有这个字段的旧记忆）。 */
export function memoryOriginalSpokenText(contribution: MemoryContribution): string {
  const revisions = memoryAiRevisions(contribution);
  const spoken = revisions.find((revision) => revision.kind === "spoken");
  return spoken ? spoken.text : contribution.text;
}

/**
 * 当前显示的「文字 AI 生成」标签：
 * - 没有历史，或最后一条已经撤回到原话 → 不显示；
 * - 最后一条是 AI 整理 → 「文字 AI 生成」；
 * - AI 整理之后又被人手改过 → 「文字 AI 生成 · 已由你修改」。
 * 文案锁定，直接复用现成常量，不新造字符串。
 */
export function memoryAiLabel(contribution: MemoryContribution): "" | typeof AI_TEXT_LABEL | typeof AI_TEXT_EDITED_LABEL {
  const revisions = memoryAiRevisions(contribution);
  if (revisions.length === 0) return "";
  const last = revisions[revisions.length - 1];
  if (last.kind === "restore" || last.kind === "spoken") return "";
  const everOrganizedByAi = revisions.some((revision) => revision.kind === "ai");
  if (!everOrganizedByAi) return "";
  return last.kind === "manual" ? AI_TEXT_EDITED_LABEL : AI_TEXT_LABEL;
}

/**
 * 非破坏性追加一条历史（原话/AI 整理/人工修改/撤回），并把 `text`/`organizationMode`
 * 同步更新成这一条——旧调用方只读 `text` 时行为不变。首次调用会自动补上首条原话，
 * 保证「首条恒为 spoken」这个不变式，即便调用方忘了先建原话记录。
 */
export function appendAiRevision(
  contribution: MemoryContribution,
  kind: MemoryAiRevisionKind,
  text: string,
  title?: string,
  organizationMode?: OrganizationMode,
  now = new Date(),
): MemoryContribution {
  const normalized = text.trim();
  if (!normalized) throw new Error("内容不能为空");
  const existing = memoryAiRevisions(contribution);
  const withSpoken = existing.length > 0
    ? existing
    : [{
        id: `revision-${contribution.id}-spoken`,
        kind: "spoken" as const,
        text: contribution.text,
        title: contribution.title,
        createdAt: contribution.createdAt,
        organizationMode: contribution.organizationMode,
      }];
  const revision: MemoryAiRevision = {
    id: `revision-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    text: normalized,
    title: title?.trim() || undefined,
    createdAt: now.toISOString(),
    organizationMode,
  };
  const aiRevisions = [...withSpoken, revision];
  return {
    ...contribution,
    aiRevisions,
    text: normalized,
    title: revision.title ?? contribution.title,
    organizationMode: organizationMode ?? contribution.organizationMode,
  };
}

/**
 * 撤回到原话：追加一条 restore 记录，把 text/organizationMode 复位成首条原话，
 * 不删除已有历史（照 book.ts 撤回 AI 整理的语义，可撤回但不销毁记录）。
 * 已经是原话时不重复追加，避免历史里堆一串无意义的 restore。
 */
export function revertMemoryToSpoken(
  contribution: MemoryContribution,
  now = new Date(),
): MemoryContribution {
  const revisions = memoryAiRevisions(contribution);
  if (revisions.length === 0) return contribution;
  const spoken = revisions.find((revision) => revision.kind === "spoken") ?? revisions[0];
  const last = revisions[revisions.length - 1];
  if (last.kind === "restore" || last.kind === "spoken") return contribution;
  const restoreRevision: MemoryAiRevision = {
    id: `revision-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "restore",
    text: spoken.text,
    title: spoken.title,
    createdAt: now.toISOString(),
    organizationMode: spoken.organizationMode,
  };
  return {
    ...contribution,
    aiRevisions: [...revisions, restoreRevision],
    text: spoken.text,
    title: spoken.title,
    organizationMode: spoken.organizationMode,
  };
}

/** 旧缓存可能被手工写坏；展示和分组时只接受真正的字符串故事名。 */
export function contributionStoryTitle(
  contribution: MemoryContribution,
): string {
  return typeof contribution.storyTitle === "string"
    ? contribution.storyTitle.trim()
    : "";
}

/** 对相关人物缓存做失败关闭读取；损坏字段只会失去标签，不会扩大权限。 */
export function contributionRelatedMemberIds(
  contribution: MemoryContribution,
): string[] {
  const storedIds: unknown = contribution.relatedMemberIds;
  if (
    !Array.isArray(storedIds) ||
    !storedIds.every((memberId) => typeof memberId === "string")
  ) {
    return [];
  }
  return normalizeMemberIds(storedIds, contribution.authorMemberId);
}

export function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizeMemberIds(memberIds: unknown, excludedMemberId?: string): string[] {
  if (!Array.isArray(memberIds)) return [];
  return Array.from(
    new Set(
      memberIds
        .filter((memberId): memberId is string => typeof memberId === "string")
        .map((memberId) => memberId.trim())
        .filter(Boolean),
    ),
  ).filter((memberId) => memberId !== excludedMemberId);
}

function normalizeTextTags(tags: unknown, maxCount: number): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(
    new Set(
      tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .map((tag) => tag.slice(0, 12)),
    ),
  ).slice(0, maxCount);
}

/** 失败关闭：不是字符串数组、或超过 9 张，一律当作没有照片，不会绕过张数上限。 */
function normalizePhotoIds(photoIds: unknown): string[] | undefined {
  if (!Array.isArray(photoIds) || !photoIds.every((id) => typeof id === "string" && id)) return undefined;
  const unique = Array.from(new Set(photoIds));
  if (unique.length === 0) return undefined;
  if (unique.length > MAX_MEMORY_PHOTOS) throw new Error(`最多放 ${MAX_MEMORY_PHOTOS} 张照片`);
  return unique;
}

export function createContribution(input: CreateContributionInput): MemoryContribution {
  const text = input.preserveNormalizedText
    ? input.text
    : normalizeMemoryText(input.text);
  const photoIds = normalizePhotoIds(input.photoIds);

  // 只有照片、没写一句话时允许 text 为空——问题九：导入照片时用户可以跳过写字。
  if (!text.trim() && !photoIds) {
    throw new Error("请先写下一段回忆，或者加一张照片");
  }

  if (text.length > MAX_MEMORY_LENGTH) {
    throw new Error(`单次回忆不能超过 ${MAX_MEMORY_LENGTH} 字`);
  }

  const now = input.now ?? new Date();
  const id = input.id ?? `memory-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  const scope = input.scope ?? "family";
  const relatedMemberIds = normalizeMemberIds(
    input.relatedMemberIds,
    input.authorMemberId,
  );
  // 谁可以看不再单独询问：没有明确传入时，跟着「涉及的人」走。显式传入（哪怕是空数组）
  // 仍然按原样生效，留给日后单独调整阅读权限的调用方。
  const shareTargets = scope === "personal"
    ? normalizeMemberIds(
        input.sharedWithMemberIds
          ?? (input.sharedWithMemberId ? [input.sharedWithMemberId] : input.relatedMemberIds),
        input.authorMemberId,
      )
    : [];
  const emotions = normalizeTextTags(input.emotions, 4);
  const people = normalizeTextTags(input.people, 8);
  const places = normalizeTextTags(input.places, 8);

  return {
    id,
    authorMemberId: input.authorMemberId,
    authorName: input.authorName,
    relation: input.relation,
    text,
    title: input.title?.trim() || undefined,
    summary: input.summary?.trim().slice(0, 60) || undefined,
    emotions: emotions.length > 0 ? emotions : undefined,
    people: people.length > 0 ? people : undefined,
    places: places.length > 0 ? places : undefined,
    organizationMode: input.organizationMode,
    memoryType: input.memoryType ?? "note",
    storyTitle: input.storyTitle?.trim() || undefined,
    relatedMemberIds: relatedMemberIds.length > 0 ? relatedMemberIds : undefined,
    scope,
    visibility: scope === "personal" ? "private" : input.visibility,
    sharedWithMemberIds: shareTargets.length > 0 ? shareTargets : undefined,
    // 自己讲自己的故事，无需交给另一位“主人公”确认。
    reviewStatus: scope === "personal" ? "confirmed" : "pending",
    createdAt: now.toISOString(),
    photoIds,
    aiRevisions: input.aiRevisions,
  };
}

/**
 * 建一条由好几段组成的新记忆（比如导入的长文字，按顺序切成几段）：第一段照常走
 * createContribution 的校验建一条记忆，其余段依次用 appendMemorySegment 追加——
 * 每段都要非空、不超过 500 字，和「随手记」「接着讲」走的是同一套校验，不重复一遍。
 */
export function createContributionFromSegments(
  input: CreateContributionInput,
  segmentTexts: string[],
  source: MemorySegmentSource,
  now = new Date(),
): MemoryContribution {
  const [first, ...rest] = segmentTexts.map((text) => text.trim()).filter(Boolean);
  if (!first) throw new Error("请先写下一段回忆，或者加一张照片");

  let contribution = createContribution({ ...input, text: first, now, preserveNormalizedText: false });
  if (source !== "note" || rest.length > 0) {
    // 覆盖 memorySegments() 默认合成的单段（它固定标 "note"），让第一段也带上正确的来源。
    contribution = {
      ...contribution,
      segments: [{ id: contribution.id, text: contribution.text, createdAt: contribution.createdAt, source, organizationMode: input.organizationMode }],
    };
  }
  for (const text of rest) {
    contribution = appendMemorySegment(contribution, text, source, input.organizationMode, now);
  }
  return contribution;
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
      isActiveMemory(contribution) &&
      contributionScope(contribution) === "family" &&
      contribution.reviewStatus === "pending",
  );
}

export function confirmedContributions(
  contributions: MemoryContribution[],
): MemoryContribution[] {
  return contributions.filter((contribution) => isActiveMemory(contribution) && contribution.reviewStatus === "confirmed");
}

export function biographySourceContributions(
  contributions: MemoryContribution[],
): MemoryContribution[] {
  return contributions.filter(
    (contribution) =>
      isActiveMemory(contribution) &&
      contributionScope(contribution) === "family" &&
      contribution.reviewStatus === "confirmed" &&
      contribution.visibility === "family",
  );
}

/**
 * 记忆库：本账号所有档案共用。任何一本书都可以取用其中任何一段，
 * 删除某个档案也不会带走它讲过的记忆。家庭确认流程的旧投稿不在其中。
 */
export function memoryPool(contributions: MemoryContribution[]): MemoryContribution[] {
  return contributions.filter((contribution) => isActiveMemory(contribution) && contributionScope(contribution) === "personal");
}

/** 某个档案亲自讲述的个人故事（讲述人，而不是书的归属）。 */
export function personalBookContributions(
  contributions: MemoryContribution[],
  memberId: string,
): MemoryContribution[] {
  return contributions.filter(
    (contribution) =>
      isActiveMemory(contribution) &&
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

  const normalizedTargets = normalizeMemberIds(
    storedTargets,
    contribution.authorMemberId,
  );
  return normalizedTargets;
}

/** 指定家人收到的个人故事：只授予阅读权，不会成为对方的人生之书素材。 */
export function sharedPersonalContributionsForMember(
  contributions: MemoryContribution[],
  memberId: string,
): MemoryContribution[] {
  return contributions.filter(
    (contribution) =>
      isActiveMemory(contribution) &&
      contributionScope(contribution) === "personal" &&
      contribution.authorMemberId !== memberId &&
      personalShareTargetMemberIds(contribution).includes(memberId),
  );
}

/** 个人故事的主人可以指定多位亲友阅读；每段故事的权限彼此独立。 */
export function setPersonalShareTargets(
  contribution: MemoryContribution,
  actor: FamilyMember,
  targetMemberIds: string[],
): MemoryContribution {
  if (contributionScope(contribution) !== "personal") {
    throw new Error("只有个人故事可以定向分享");
  }
  if (contribution.authorMemberId !== actor.id) {
    throw new Error("只有故事的主人可以更改分享对象");
  }

  const targets = normalizeMemberIds(targetMemberIds, actor.id);
  if (targets.length !== targetMemberIds.length) {
    throw new Error("分享对象中包含无效成员");
  }

  return {
    ...contribution,
    sharedWithMemberIds: targets.length > 0 ? targets : undefined,
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
    if (!isActiveMemory(contribution)) return false;
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
  const member = state.members.find((item) => item.id === memberId);
  // Every book draws from the shared memory pool.
  return JSON.stringify({
    memberId,
    // The generated introduction names the narrator. A rename therefore makes
    // an existing generated draft stale even when its memories are unchanged.
    memberName: member?.name ?? "",
    sources: memoryPool(state.contributions)
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

/**
 * Offline fallback for one chapter: the chapter's existing text, then each chosen
 * memory not already in it, verbatim. No quotes, no template filler.
 */
export function buildLocalChapterDraft(
  memories: MemoryContribution[],
  existingText = "",
  chapterTitle = "",
  now = new Date(),
): BiographyDraft {
  if (memories.length === 0) throw new Error("先勾选要整理的记忆");
  const existing = existingText.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean);
  const kept = existing.join("\n");
  return {
    title: chapterTitle.trim() || memories.map(contributionStoryTitle).find(Boolean) || "",
    paragraphs: [...existing, ...memories.filter((memory) => !kept.includes(memory.text)).map((memory) => memory.text)],
    sourceCount: memories.length,
    generatedAt: now.toISOString(),
    generationMode: "local-demo",
  };
}

export function createEmptyRoomState(): FamilyRoomState {
  return {
    roomName: "我的拾光房间",
    protagonistName: "",
    members: [],
    contributions: [],
    personalDrafts: {},
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
