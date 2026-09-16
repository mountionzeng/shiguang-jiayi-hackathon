import assert from "node:assert/strict";
import test from "node:test";

import { classifyImportFiles, importTitle, splitImportedText } from "../miniprogram/services/memoryImport";

test("导入文件区分图片、一个文字文件和不支持的格式", () => {
  const result = classifyImportFiles([
    { name: "旧照片.JPG", path: "one", type: "file" },
    { name: "回忆.md", path: "two", type: "file" },
    { name: "资料.pdf", path: "three", type: "file" },
  ]);
  assert.deepEqual(result.images.map(file => file.path), ["one"]);
  assert.equal(result.text?.path, "two");
  assert.deepEqual(result.unsupportedNames, ["资料.pdf"]);
  assert.throws(() => classifyImportFiles([
    { name: "一.txt", path: "one" }, { name: "二.md", path: "two" },
  ]), /一次只能导入一个文字文件/);
});

test("Markdown 导入去掉图片和标题符号、链接只留文字，再按自然段和标点分段", () => {
  const long = "甲".repeat(300) + "。" + "乙".repeat(300);
  const segments = splitImportedText(`\uFEFF# 标题\n![图](x.jpg)\n[旧链接](https://example.com)\n${long}`, "md");
  assert.deepEqual(segments.slice(0, 2), ["标题", "旧链接"]);
  assert.equal(segments[2].length, 301);
  assert.equal(segments[3].length, 300);
  assert.ok(segments.every(segment => Array.from(segment).length <= 500));
});

test("导入文字拒绝乱码、空文件和超过两万字，标题去掉后缀并限长", () => {
  assert.throws(() => splitImportedText("坏�字"), /UTF-8/);
  assert.throws(() => splitImportedText("  \n "), /没有可导入/);
  assert.throws(() => splitImportedText("字".repeat(20_001)), /2 万字/);
  assert.equal(importTitle("一段很长很长的家庭往事.txt"), "一段很长很长的家庭往事");
});
