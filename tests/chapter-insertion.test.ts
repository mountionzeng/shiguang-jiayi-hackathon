import assert from "node:assert/strict";
import test from "node:test";
import { chapterInsertionPoints, insertChapterText } from "../miniprogram/services/chapterInsertion";
import { ManuscriptContent } from "../miniprogram/domain/biography";

test("insertion after a paragraph preserves original bytes and surrounding photo order", () => {
  const original: ManuscriptContent[] = [{ photoId: "photo-before" }, { text: "第一段。\r\n\r\n第二段。\n" }, { photoId: "photo-after" }, { text: "末段。" }];
  const snapshot = JSON.stringify(original);
  const point = chapterInsertionPoints(original)[1];
  const result = insertChapterText(original, point.id, "新记忆。🍀");
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(result[0].photoId, "photo-before");
  assert.equal(result[1].text, "第一段。\r\n\r\n");
  assert.match(result[2].text!, /新记忆。🍀/);
  assert.equal(result[3].text, "第二段。\n");
  assert.equal(result[4].photoId, "photo-after");
  assert.equal(result[5].text, "末段。");
});

test("chapter start and end remain distinct from positions beside photos", () => {
  const original: ManuscriptContent[] = [{ photoId: "photo-before" }, { text: "第一段\n第二段" }, { photoId: "photo-after" }];
  const points = chapterInsertionPoints(original);
  assert.equal(points.length, 4);
  const start = insertChapterText(original, "start", "新记忆");
  assert.deepEqual(start.slice(1), original);
  const end = insertChapterText(original, "end", "新记忆");
  assert.deepEqual(end.slice(0, -1), original);
  const middle = insertChapterText(original, points[2].id, "新记忆");
  assert.equal(middle[middle.length - 1]?.photoId, "photo-after");
});

test("empty chapters accept insertion; invalid or blank insertions never mutate original", () => {
  assert.deepEqual(insertChapterText([], "start", "首段"), [{ text: "首段\n\n" }]);
  const original: ManuscriptContent[] = [{ text: "旧文" }];
  assert.throws(() => insertChapterText(original, "0:999", "新段"), /位置已变动/);
  assert.throws(() => insertChapterText(original, "end", " \n "), /要插入的文字/);
  assert.deepEqual(original, [{ text: "旧文" }]);
});
