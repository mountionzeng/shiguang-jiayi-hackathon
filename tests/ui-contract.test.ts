import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const homeMarkup = readFileSync(
  resolve(process.cwd(), "miniprogram/pages/index/index.wxml"),
  "utf8",
);

test("transparent story entrances never use WeChat's native pressed or disabled paint", () => {
  const entrances = homeMarkup.match(
    /<button[\s\S]*?class="branch-choice[\s\S]*?<\/button>/g,
  );

  assert.equal(entrances?.length, 2);
  entrances?.forEach((entrance) => {
    assert.match(entrance, /hover-class="none"/);
    assert.doesNotMatch(entrance, /\sdisabled=/);
  });
});
