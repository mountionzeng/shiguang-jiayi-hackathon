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
const homeMarkup = readFileSync(
  resolve(process.cwd(), "miniprogram/pages/index/index.wxml"),
  "utf8",
);
const coverMarkup = readFileSync(
  resolve(process.cwd(), "miniprogram/pages/story-cover/story-cover.wxml"),
  "utf8",
);
const socialMarkup = readFileSync(
  resolve(
    process.cwd(),
    "miniprogram/packages/story-sharing/pages/social/index.wxml",
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

test("custom book covers fill their fixed cover frames", () => {
  const homeCover = homeMarkup.match(
    /<image[\s\S]*class="ancient-book-art[\s\S]*?<\/image>/,
  )?.[0];

  assert.match(
    homeCover || "",
    /mode="\{\{coverUrl \? 'aspectFill' : 'aspectFit'\}\}"/,
  );
  assert.match(
    coverMarkup,
    /<image class="cover-art"[^>]*mode="aspectFill"/,
  );
  assert.match(
    socialMarkup,
    /<image class="cover"[^>]*mode="\{\{coverUrl \? 'aspectFill' : 'aspectFit'\}\}"/,
  );
});
