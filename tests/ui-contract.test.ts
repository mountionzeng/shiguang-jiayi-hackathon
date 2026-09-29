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
const homeStyles = readFileSync(
  resolve(process.cwd(), "miniprogram/pages/index/index.wxss"),
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

test("custom book covers are locked to the green book frame with a seam mask", () => {
  assert.match(homeMarkup, /class="book-cover-picture" wx:if="\{\{item.bookArtUrl\}\}"/);
  assert.match(homeMarkup, /class="book-cover-picture-art"[\s\S]*src="\{\{item.bookArtUrl\}\}"[\s\S]*mode="scaleToFill"/);
  assert.doesNotMatch(homeMarkup, /class="book-cover-frame/);
  assert.match(homeMarkup, /wx:else[\s\S]*class="ancient-book-art"[\s\S]*story-book-cover\.png[\s\S]*mode="aspectFill"/);
  assert.doesNotMatch(homeMarkup, /book-cover-dominant|book-cover-paper-texture|book-cover-material|book-cover-material-color|book-cover-picture-wash|book-cover-edge-mask|ancient-book-art-overlay|story-book-spine|story-switcher-book-edges|capture-memoir-book|story-book-cover-paper-texture\.png|onBookCoverLoad/);
  assert.match(homeMarkup, /class="book-cover-copy \{\{item.bookArtUrl \? 'book-cover-copy-printed' : ''\}\}"/);
  assert.match(homeMarkup, /<text class="book-kicker typewriter">拾 光 录<\/text>/);
  assert.match(homeMarkup, /<view class="book-title typewriter">\{\{item.title\}\}<\/view>/);
  assert.match(homeMarkup, /<text class="book-stat-label">段记忆<\/text>/);
  assert.match(homeMarkup, /<text class="book-stat-label">章节<\/text>/);
  assert.match(homeMarkup, /<text class="book-stat-label">人物<\/text>/);
  assert.match(
    coverMarkup,
    /<image class="cover-art"[^>]*mode="aspectFill"/,
  );
  assert.match(
    socialMarkup,
    /<image class="cover"[^>]*mode="\{\{coverUrl \? 'aspectFill' : 'aspectFit'\}\}"/,
  );
});
