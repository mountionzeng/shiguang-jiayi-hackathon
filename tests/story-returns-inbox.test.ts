import assert from "node:assert/strict";
import test from "node:test";

import {
  chapterIdsWithReturns,
  homeReturnNotice,
  invalidatePendingReturns,
  loadPendingReturns,
  PendingReturn,
  returnsForChapter,
  senderLabel,
} from "../miniprogram/services/storyReturnsInbox";

function letter(overrides: Partial<PendingReturn> = {}): PendingReturn {
  return {
    returnId: "return-" + "a".repeat(64), status: "pending", sourceStoryId: "story-a", sourceChapterId: "chapter-three",
    blocks: [{ blockId: "block-" + "b".repeat(64), text: "我记得你当时还带着一把蓝伞" }],
    createdAt: "2026-10-15T08:00:00.000Z", decidedAt: "", resultRevisionId: "", senderName: "小岚", ...overrides,
  };
}

test("回信按故事、按章节归类，别的故事的回信不会混进来", () => {
  const list = [
    letter(),
    letter({ returnId: "return-" + "c".repeat(64), sourceChapterId: "chapter-five" }),
    letter({ returnId: "return-" + "d".repeat(64), sourceStoryId: "story-b" }),
  ];
  assert.equal(returnsForChapter(list, "story-a", "chapter-three").length, 1);
  assert.deepEqual([...chapterIdsWithReturns(list, "story-a")].sort(), ["chapter-five", "chapter-three"]);
  assert.equal(chapterIdsWithReturns(list, "story-none").size, 0);
});

test("署名用朋友的称呼，没有称呼时退回「一位亲友」", () => {
  assert.equal(senderLabel(letter()), "小岚");
  assert.equal(senderLabel(letter({ senderName: "  " })), "一位亲友");
  assert.equal(senderLabel(letter({ senderName: undefined })), "一位亲友");
});

test("首页提示：没有回信时什么都不显示，一位朋友写名字，多位朋友写人数", () => {
  assert.equal(homeReturnNotice([], "story-a", "外婆家的夏天"), undefined);
  assert.equal(homeReturnNotice([letter({ sourceStoryId: "story-b" })], "story-a", "外婆家的夏天"), undefined);

  const one = homeReturnNotice([letter()], "story-a", "外婆家的夏天")!;
  assert.equal(one.text, "小岚给《外婆家的夏天》回信了");
  assert.equal(one.chapterId, "chapter-three");
  assert.equal(one.extra, 0);

  const many = homeReturnNotice([
    letter(),
    letter({ returnId: "return-" + "e".repeat(64), senderName: "阿远", sourceChapterId: "chapter-five", createdAt: "2026-10-15T09:00:00.000Z" }),
  ], "story-a", "外婆家的夏天")!;
  assert.equal(many.text, "阿远等 2 位亲友给《外婆家的夏天》回信了");
  assert.equal(many.chapterId, "chapter-five", "点开直接去最新的一封");
  assert.equal(many.extra, 1);

  const sameFriendTwice = homeReturnNotice([
    letter(),
    letter({ returnId: "return-" + "f".repeat(64), createdAt: "2026-10-15T09:00:00.000Z" }),
  ], "story-a", "外婆家的夏天")!;
  assert.equal(sameFriendTwice.text, "小岚给《外婆家的夏天》回信了", "同一位朋友的两封不重复算人");
  assert.equal(sameFriendTwice.extra, 1);
});

function mockCloud(handler: () => unknown) {
  const calls: unknown[] = [];
  (globalThis as any).wx = { cloud: { callFunction: async (value: unknown) => { calls.push(value); return handler(); } } };
  return calls;
}

test("读取回信：只留待处理的；一分钟内不重复请求；收录或拒绝后失效", async (context) => {
  const previous = (globalThis as any).wx;
  context.after(() => { (globalThis as any).wx = previous; invalidatePendingReturns(); });
  invalidatePendingReturns();
  const calls = mockCloud(() => ({ result: { returns: [letter(), letter({ returnId: "return-" + "9".repeat(64), status: "accepted" })] } }));

  const first = await loadPendingReturns();
  assert.equal(first.length, 1, "已处理的不再提示");
  await loadPendingReturns();
  assert.equal(calls.length, 1, "缓存期内不重复请求云端");

  invalidatePendingReturns();
  await loadPendingReturns();
  assert.equal(calls.length, 2, "处理完一封后下一次读取拿到最新结果");
});

test("读取回信失败一律当作没有回信，不抛错，功能未开放时十分钟内不再重试", async (context) => {
  const previous = (globalThis as any).wx;
  context.after(() => { (globalThis as any).wx = previous; invalidatePendingReturns(); });

  invalidatePendingReturns();
  const closed = mockCloud(() => ({ result: { error: "STORY_BOOK_ERROR", code: "STORY_ACCESS_DISABLED", message: "故事共享尚未开放" } }));
  assert.deepEqual(await loadPendingReturns(), []);
  assert.deepEqual(await loadPendingReturns(), []);
  assert.equal(closed.length, 1, "开关没开时不会每次进首页都打一次云函数");

  invalidatePendingReturns();
  const broken = mockCloud(() => { throw new Error("网络断了"); });
  assert.deepEqual(await loadPendingReturns(), []);
  assert.equal(broken.length, 1);
});
