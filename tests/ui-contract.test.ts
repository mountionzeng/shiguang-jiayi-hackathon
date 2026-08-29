import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const switcherMarkup = readFileSync(
  resolve(
    process.cwd(),
    "miniprogram/components/story-switcher/story-switcher.wxml",
  ),
  "utf8",
);

test("transparent story tabs never use WeChat's native pressed or disabled paint", () => {
  const entrances = switcherMarkup.match(
    /<button[\s\S]*?class="story-tab[\s\S]*?<\/button>/g,
  );

  assert.equal(entrances?.length, 3);
  entrances?.forEach((entrance) => {
    assert.match(entrance, /hover-class="none"/);
    assert.doesNotMatch(entrance, /\sdisabled=/);
  });
});
