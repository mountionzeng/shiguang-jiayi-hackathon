export type InviteCardStyleId = "branch" | "book" | "nest";

export interface InviteCardStyle {
  id: InviteCardStyleId;
  name: string;
  note: string;
  art: string;
}

export const INVITE_CARD_STYLES: InviteCardStyle[] = [
  { id: "branch", name: "枝头来信", note: "清浅枝叶与归鸟", art: "/assets/illustrations/memory-branch.png" },
  { id: "book", name: "旧书新页", note: "像一本等你续写的书", art: "/assets/illustrations/story-book-cover.png" },
  { id: "nest", name: "归巢相聚", note: "鸟巢与暖色水彩", art: "/assets/illustrations/memory-nest.png" },
];

function short(value: string, fallback: string): string {
  return Array.from(String(value || "").trim()).slice(0, 12).join("") || fallback;
}

export interface InvitationCopyDraft {
  headline: string;
  message: string;
}

export function invitationCopyOptions(inviteeName: string, relation: string): InvitationCopyDraft[] {
  const name = short(inviteeName, "你");
  const relationLabel = short(relation, "我们");
  return [
    { headline: "一起写下我们的故事", message: `${name}，来补上你记得的那一页。` },
    { headline: "有些故事，想和你一起写", message: "把那些值得记住的日子，慢慢写下来。" },
    { headline: "等你来说说那时候", message: `${name}，我想听听你记得的细节。` },
    { headline: `写给我的${relationLabel}`, message: "一起留住我们笑过、想念过的日子。" },
  ];
}

export function nextInvitationCopy(
  inviteeName: string,
  relation: string,
  currentIndex: number,
): { index: number; headline: string; message: string } {
  const options = invitationCopyOptions(inviteeName, relation);
  const index = ((currentIndex % options.length) + options.length) % options.length;
  return { index, ...options[index] };
}

export function invitationMessageLength(value: string): number {
  return Array.from(String(value || "").trim()).length;
}

export function validInvitationMessage(value: string): boolean {
  const length = invitationMessageLength(value);
  return length >= 4 && length <= 48;
}

export function validInvitationHeadline(value: string): boolean {
  const length = invitationMessageLength(value);
  return length >= 2 && length <= 16;
}

/**
 * Canvas has no dependable Chinese line breaker across base-library versions.
 * Keep punctuation with the previous phrase and use character units so the
 * preview and exported poster have the same stable short shape.
 */
export function wrapInvitationMessage(value: string, units = 18, maxLines = 3): string[] {
  const characters = Array.from(String(value || "").trim().replace(/\s+/g, " "));
  const lines: string[] = [];
  let line = "";
  let width = 0;
  for (const character of characters) {
    const nextWidth = width + (/[\x00-\xff]/.test(character) ? 0.55 : 1);
    if (line && nextWidth > units) {
      lines.push(line);
      line = character;
      width = /[\x00-\xff]/.test(character) ? 0.55 : 1;
      if (lines.length === maxLines) break;
    } else {
      line += character;
      width = nextWidth;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && characters.join("").length > lines.join("").length) {
    lines[maxLines - 1] = Array.from(lines[maxLines - 1]).slice(0, -1).join("") + "…";
  }
  return lines;
}
