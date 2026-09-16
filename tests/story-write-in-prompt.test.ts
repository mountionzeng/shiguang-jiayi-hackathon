import assert from "node:assert/strict";
import test from "node:test";

import {
  appendMemorySegment,
  createContribution,
  ManuscriptChapter,
  MemoryContribution,
  Story,
} from "../miniprogram/domain/biography";
import { declineStorySegment, shouldAskToWriteIn } from "../miniprogram/services/storyRecords";

function memory(): MemoryContribution {
  return createContribution({
    id: "memory-1",
    authorMemberId: "owner",
    authorName: "林岚",
    relation: "外孙女",
    text: "灶台边总有一股柴火味。",
    now: new Date("2026-09-01T00:00:00.000Z"),
    scope: "personal",
    visibility: "private",
  });
}

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: "story-1",
    familyId: "family_test",
    title: "外公",
    protagonistMemberIds: [],
    memoryIds: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function writtenChapter(memoryId: string, count: number): ManuscriptChapter {
  return { id: "chapter-1", title: "", memoryIds: [memoryId], content: [], memorySegmentCounts: { [memoryId]: count } };
}

test("每日一问：只在有新段没写进、又没被这个故事点过先不用时才问", () => {
  const one = memory();
  const grown = appendMemorySegment(one, "外公总会提前十分钟出门。", "continue", undefined, new Date("2026-09-08T00:00:00.000Z"));

  assert.equal(shouldAskToWriteIn(story(), one, [writtenChapter(one.id, 1)]), false, "没有新段，不问");
  assert.equal(shouldAskToWriteIn(story(), grown, [writtenChapter(one.id, 1)]), true, "有新段，问");
  assert.equal(shouldAskToWriteIn(story(), grown, []), false, "还没被任何章节写进，走「未写入」不是「新段」");
});

test("点了先不用以后，同一段不再问；再讲一段又会问", () => {
  const one = memory();
  const grown = appendMemorySegment(one, "外公总会提前十分钟出门。", "continue", undefined, new Date("2026-09-08T00:00:00.000Z"));
  const chapters = [writtenChapter(one.id, 1)];

  const declined = declineStorySegment(story(), grown);
  assert.deepEqual(declined.declinedSegments, { [one.id]: 2 });
  assert.equal(shouldAskToWriteIn(declined, grown, chapters), false, "点过先不用，同一段不再问");

  const grownAgain = appendMemorySegment(grown, "今天又想起一件小事。", "daily-question", undefined, new Date("2026-09-15T00:00:00.000Z"));
  assert.equal(shouldAskToWriteIn(declined, grownAgain, chapters), true, "又多讲了一段，还是会问");

  // declinedSegments 只会往大改，不会因为一次较早的记录把较新的往回改。
  const staleDecline = declineStorySegment(declined, one);
  assert.deepEqual(staleDecline.declinedSegments, { [one.id]: 2 }, "段数没超过已记的，不改");
});

test("选「写进」以后不受先不用记录影响：写进的判断只看章节水位", () => {
  const one = memory();
  const grown = appendMemorySegment(one, "外公总会提前十分钟出门。", "continue", undefined, new Date("2026-09-08T00:00:00.000Z"));
  const declined = declineStorySegment(story(), grown);
  const writtenIn = [writtenChapter(one.id, 2)]; // 用户已经手动写进了这一段
  assert.equal(shouldAskToWriteIn(declined, grown, writtenIn), false, "水位追平了，不管先不用记录怎么写都不该再问");
});
