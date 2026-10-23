import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { linePosition, locateLine, reconcileLines, trimLineContext } from "../miniprogram/domain/lineModules";

const DIR = join(__dirname, "fixtures", "line-modules");
const raw = readFileSync(join(DIR, "cases.json"));
const cases = JSON.parse(raw.toString("utf8"));

test("fixture matches SHA256SUMS", () => {
  const sums = readFileSync(join(DIR, "SHA256SUMS"), "utf8");
  assert.ok(sums.startsWith(createHash("sha256").update(raw).digest("hex")));
});
for (const c of cases.reconcile) test(`reconcile: ${c.name}`, () => {
  let n = 0;
  const out = reconcileLines(c.prev.map(([id, text]: string[]) => ({ id, text })), c.next, () => `new${++n}`);
  assert.deepEqual(out.map(m => [m.id, m.text]), c.expect);
});
for (const c of cases.locate) test(`locate: ${c.name}`, () => assert.equal(locateLine(c.text, c.cursor), c.index));
test("trim keeps layers in order", () => {
  for (const b of cases.trim.budgets)
    assert.deepEqual(trimLineContext({ lines: cases.trim.lines, index: cases.trim.index, titles: cases.trim.titles, limit: b.limit }).included, b.keep);
});
test("position object", () => {
  const mods = [{ id: "a", text: "一" }, { id: "b", text: "二" }, { id: "c", text: "三" }];
  assert.equal(linePosition("ch", mods, 1)?.nextText, "三");
  assert.equal(linePosition("ch", mods, null), null);
});

import { lineContextText, lineIndexFromRange, lineIndexFromSelection } from "../miniprogram/services/lineContext";
test("selection text finds a unique line only", () => {
  assert.equal(lineIndexFromSelection("甲\n乙乙\n丙", "乙乙"), 1);
  assert.equal(lineIndexFromSelection("乙\n乙", "乙"), null);
  assert.equal(lineIndexFromSelection("甲", "  "), null);
});
test("range index outside text is rejected", () => {
  assert.equal(lineIndexFromRange("甲\n乙", 2), 1);
  assert.equal(lineIndexFromRange("甲\n乙", 99), null);
});
test("line context text names the line", () => {
  assert.match(lineContextText("甲\n乙\n丙", 1), /第 2 行（共 3 行）：乙/);
  assert.equal(lineContextText("甲", null), "");
});
test("switch is off by default", () => {
  const { LINE_CONTEXT_CHAT_ENABLED } = require("../miniprogram/config/runtime");
  assert.equal(LINE_CONTEXT_CHAT_ENABLED, false);
});

import { displayLines } from "../miniprogram/services/lineContext";
test("display splits every text block into one paragraph per non-empty line", () => {
  assert.deepEqual(displayLines([{ text: "甲\n乙\n\n丙" }, { text: "丁" }, { text: "" }, {}]).map(x => x.text), ["甲", "乙", "丙", "丁"]);
  assert.deepEqual(displayLines([{ text: "甲\r\n乙" }]).map(x => x.text), ["甲", "乙"]);
});
