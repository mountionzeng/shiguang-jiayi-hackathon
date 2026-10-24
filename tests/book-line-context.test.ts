import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const filename = resolve("miniprogram/pages/book/book.ts");
const nativeRequire = createRequire(filename);
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function setup(options: { enabled?: boolean; text?: string; selected?: string; range?: number; embed?: boolean; delayed?: boolean } = {}) {
  let definition: any;
  const sends: string[] = [];
  const replies: Array<() => void> = [];
  const text = options.text ?? "甲\n重复\n\n重复\n尾声";
  vm.runInNewContext(compiled, {
    exports: {}, Page: (value: any) => { definition = value; },
    require: (name: string) => {
      const value = nativeRequire(name);
      if (name.endsWith("/config/runtime")) return { ...value, LINE_CONTEXT_CHAT_ENABLED: options.enabled ?? true };
      if (name.endsWith("/services/xiaoyiCompanion")) return { ...value,
        askXiaoyiQuestion() { sends.push(this.xiaoyiContextText()); },
        organizeXiaoyiAnswer() { sends.push(this.xiaoyiContextText()); },
      };
      return value;
    },
    wx: { showToast() {} }, console, setTimeout, clearTimeout,
  }, { filename });
  const page = { ...definition, data: { ...definition.data, view: "chapter", editorReady: true, storyId: "s" },
    activeChapterId: "a", bodyBuffer: text,
    contentBuffer: [{ text }],
    chapters: [{ id: "a", title: "第一章", content: [{ text }] }],
    setData(patch: any) { Object.assign(this.data, patch); },
  };
  function respond(callback: () => void) { if (options.delayed) replies.push(callback); else callback(); }
  page.editorContext = {
    getContents({ success }: any) { respond(() => success({ text, delta: { ops: [{ insert: text }, ...(options.embed ? [{ insert: { image: "local" } }] : [])] } })); },
    getSelectionText({ success }: any) { respond(() => success({ text: options.selected ?? "" })); },
    getSelection({ success }: any) { respond(() => success({ range: options.range === undefined ? undefined : { index: options.range } })); },
  };
  return { page, sends, finish: () => replies.splice(0).forEach(reply => reply()) };
}

test("book reads the native cursor in repeated lines, sends only on ask, and waits for capture", async () => {
  const { page, sends, finish } = setup({ range: 7, delayed: true });
  const opening = page.openXiaoyi();
  assert.equal(sends.length, 0);
  const sending = page.askXiaoyiQuestion();
  assert.equal(sends.length, 0);
  finish(); await opening; await sending;
  assert.equal(page.xiaoyiLinePosition.index, 2);
  assert.equal(page.xiaoyiLinePosition.chapterId, "a");
  assert.match(sends[0], /第 3 行（共 4 行）/);
  assert.equal(sends.length, 1);
});

test("book consumes stable ids from matching canonical one-line blocks without saving", async () => {
  const { page, sends } = setup({ text: "甲\n乙", range: 2 });
  page.chapters[0].content = [{ blockId: "existing-a", text: "甲" }, { blockId: "existing-b", text: "乙" }];
  const original = JSON.stringify(page.chapters);
  await page.openXiaoyi();
  assert.equal(page.xiaoyiLinePosition.blockId, "existing-b");
  assert.equal(JSON.stringify(page.chapters), original);
  assert.equal(sends.length, 0);
});

for (const scenario of [
  { text: "甲\n\n乙\n丙", range: 2, expected: 0 },
  { text: "甲\r\n乙\r\n丙", range: 6, expected: 2 },
  { text: "原文\n粘贴一\n粘贴二\n粘贴三", range: 9, expected: 2 },
  { text: "重复\n甲\n重复\n乙", selected: "重复\n乙", embed: true, expected: 2 },
]) test(`book native line snapshot: ${JSON.stringify(scenario)}`, async () => {
  const { page, sends } = setup(scenario);
  await page.openXiaoyi();
  assert.equal(page.xiaoyiLinePosition?.index, scenario.expected);
  assert.equal(sends.length, 0);
});

for (const scenario of [
  { embed: true, range: 7 },
  { embed: true, selected: "重复", range: 7 },
  { range: 999 },
  {},
]) test(`book falls back without claiming a line: ${JSON.stringify(scenario)}`, async () => {
  const { page, sends } = setup(scenario);
  await page.openXiaoyi();
  assert.equal(page.xiaoyiLinePosition, null);
  await page.askXiaoyiQuestion();
  assert.doesNotMatch(sends[0], /^【用户停在第/);
});

for (const change of ["chapter", "close", "edit", "unload", "reopen"] as const) {
  test(`late native result is ignored after ${change}`, async () => {
    const { page, sends, finish } = setup({ range: 7, delayed: true });
    const opening = page.openXiaoyi();
    const oldSend = page.askXiaoyiQuestion();
    if (change === "chapter") { page.activeChapterId = "b"; page.bodyBuffer = "新章"; }
    if (change === "close") page.closeXiaoyi();
    if (change === "edit") page.editSequence++;
    if (change === "unload") page.unloaded = true;
    if (change === "reopen") { page.closeXiaoyi(); void page.openXiaoyi(); }
    finish(); await opening; await oldSend;
    if (change !== "reopen") assert.equal(page.xiaoyiLinePosition, null);
    if (change !== "edit") assert.equal(sends.length, 0);
    else assert.doesNotMatch(sends[0], /^【用户停在第/);
    if (change === "chapter") assert.equal(page.xiaoyiContextText(), "新章");
  });
}

test("closed flag preserves selection source and opening never calls AI", async () => {
  const { page, sends } = setup({ enabled: false, selected: "尾声", range: 10 });
  await page.openXiaoyi();
  assert.equal(page.xiaoyiLinePosition, null);
  assert.equal(sends.length, 0);
  await page.askXiaoyiQuestion();
  assert.deepEqual(sends, ["尾声"]);
});

test("long current line is bounded by the unchanged cloud sourceText limit", async () => {
  const { page, sends } = setup({ text: "甲".repeat(5000) + "\n尾声", range: 2 });
  await page.openXiaoyi(); await page.askXiaoyiQuestion();
  assert.equal(sends[0].length, 500);
  assert.match(sends[0], /^【用户停在第 1 行/);
});


test("unsupported native APIs degrade to ordinary context instead of rejecting chat", async () => {
  const { page, sends } = setup({ range: 2 });
  for (const method of ["getContents", "getSelectionText", "getSelection"]) page.editorContext[method] = () => { throw new Error("unsupported"); };
  await page.openXiaoyi(); await page.askXiaoyiQuestion();
  assert.equal(page.xiaoyiLinePosition, null);
  assert.equal(sends[0], page.bodyBuffer);
});

test("an edit after capture clears the old line and uses the latest native input buffer", async () => {
  const { page, sends } = setup({ range: 7 });
  await page.openXiaoyi();
  assert.equal(page.xiaoyiLinePosition.index, 2);
  page.editSequence++;
  page.bodyBuffer = "刚刚改过的正文";
  await page.askXiaoyiQuestion();
  assert.equal(page.xiaoyiLinePosition, null);
  assert.deepEqual(sends, ["刚刚改过的正文"]);
});
