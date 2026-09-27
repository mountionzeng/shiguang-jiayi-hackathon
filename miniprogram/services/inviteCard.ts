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

export function invitationCopyOptions(inviteeName: string, relation: string): string[] {
  const name = short(inviteeName, "你");
  const relationLabel = short(relation, "我们");
  return [
    `${name}，有些记忆因为你也在场，才显得完整。想邀请你来这里，一起把我们经历过的日子慢慢写下来。`,
    `这些年，我们一起走过许多日子。想请你也留下一段记忆，让那些值得珍惜的时光被好好记住。`,
    `${name}，故事从来不只属于一个人。想听你说说记得的细节，也想和你一起补全我们的共同回忆。`,
    `因为我们是${relationLabel}，所以有些故事只有你最懂。来和我一起写下那些笑过、想念过，也不愿忘记的日子吧。`,
  ];
}

export function nextInvitationCopy(
  inviteeName: string,
  relation: string,
  currentIndex: number,
): { index: number; message: string } {
  const options = invitationCopyOptions(inviteeName, relation);
  const index = ((currentIndex % options.length) + options.length) % options.length;
  return { index, message: options[index] };
}

export function invitationMessageLength(value: string): number {
  return Array.from(String(value || "").trim()).length;
}

export function validInvitationMessage(value: string): boolean {
  const length = invitationMessageLength(value);
  return length >= 4 && length <= 90;
}

/**
 * Canvas has no dependable Chinese line breaker across base-library versions.
 * Keep punctuation with the previous phrase and use character units so the
 * preview and exported poster have the same stable four-line shape.
 */
export function wrapInvitationMessage(value: string, units = 18, maxLines = 4): string[] {
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
