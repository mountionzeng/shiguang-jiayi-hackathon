import assert from "node:assert/strict";
import test from "node:test";
import {
  drinkingTimeAccountTest,
  importedContributions,
  pendingImportedContributions,
  splitImportedStory,
} from "../miniprogram/services/drinkingTimeAccount";

const member = { id: "owner", name: "岱", relation: "自己", avatarText: "岱", role: "owner" as const };
const document = (body: string, sourceRevision = "a".repeat(24)) => ({
  id: 7,
  title: "旧故事",
  body,
  bodyAvailable: true,
  sourceRevision,
  sourceUpdatedAt: 1_800_000_000_000,
});

test("整篇导入按500字拆分且默认仅自己可见", () => {
  const chunks = splitImportedStory("甲".repeat(620));
  assert.deepEqual(chunks.map(item => item.length), [500, 120]);
  const rows = importedContributions(document("甲".repeat(620)), member);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.scope === "personal" && row.visibility === "private" && row.reviewStatus === "confirmed"));
  assert.equal(rows[0].storyTitle, "旧故事");
  assert.equal(rows[0].createdAt, new Date(1_800_000_000_000).toISOString());
});

test("相同来源可安全重试，修改后的版本和两个不同片段都不会互相覆盖", () => {
  const first = importedContributions(document("一段正文"), member);
  assert.deepEqual(first.map(item => item.id), importedContributions(document("一段正文"), member).map(item => item.id));
  assert.notDeepEqual(first.map(item => item.id), importedContributions(document("更新正文", "b".repeat(24)), member).map(item => item.id));
  const fragmentA = importedContributions(document("完整正文"), member, "第一个片段");
  const fragmentB = importedContributions(document("完整正文"), member, "第二个片段");
  assert.notEqual(fragmentA[0].id, fragmentB[0].id);
  assert.deepEqual(pendingImportedContributions(first, first), []);
  assert.deepEqual(pendingImportedContributions([...first, ...fragmentA], first).map(item => item.id), fragmentA.map(item => item.id));
});

test("片段与整篇超过明确上限时拒绝而不是静默截断", () => {
  assert.throws(() => importedContributions(document("甲".repeat(50_001)), member), /超过 5 万字/);
  assert.throws(() => importedContributions(document("正文"), member, "乙".repeat(501)), /片段最多 500 字/);
  const punctuated = `${"甲".repeat(479)}。`.repeat(100);
  assert.equal(punctuated.length, 48_000);
  assert.equal(importedContributions(document(punctuated), member).length, 96);
});

test("错误与未知响应不会被泛型断言伪装成成功", () => {
  assert.throws(() => drinkingTimeAccountTest.recordFrom(null), /无法识别/);
  assert.match(drinkingTimeAccountTest.friendlyBridgeError(new Error("not_found")).message, /不存在/);
  assert.match(drinkingTimeAccountTest.friendlyBridgeError(new Error("replayed_request")).message, /已处理/);
  assert.match(drinkingTimeAccountTest.friendlyBridgeError(new Error("bridge_response_too_large")).message, /过大/);
  assert.deepEqual(drinkingTimeAccountTest.storyPageFrom({ stories: [{ id: 7, title: "旧故事" }], nextCursor: 50 }, 0), {
    stories: [{ id: 7, title: "旧故事" }], nextCursor: 50,
  });
  assert.throws(() => drinkingTimeAccountTest.storyPageFrom({ stories: [{ id: "7", title: "旧故事" }], nextCursor: null }, 0), /格式已变化/);
  assert.throws(() => drinkingTimeAccountTest.storyPageFrom({ stories: [], nextCursor: 0 }, 0), /分页状态异常/);
});
