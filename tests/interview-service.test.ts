import assert from "node:assert/strict";
import test from "node:test";

import { generateInterviewPrompt } from "../miniprogram/services/interviewService";

function installGlobal(name: "getApp" | "wx", value: unknown): () => void {
  if (name === "wx") value = { showModal: ({ success }: any) => success({ confirm: true, cancel: false }), ...(value as object) };
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });

  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete (globalThis as Record<string, unknown>)[name];
  };
}

function silenceExpectedWarnings(): () => void {
  const previous = console.warn;
  console.warn = () => undefined;
  return () => {
    console.warn = previous;
  };
}

test("cloud interview prompt uses chatInterview when available", async (context) => {
  let requestData: unknown;
  const restoreGetApp = installGlobal("getApp", () => ({
    globalData: { cloudReady: true, aiReady: true },
  }));
  const restoreWx = installGlobal("wx", {
    cloud: {
      callFunction: async (request: { name: string; data: unknown }) => {
        assert.equal(request.name, "chatInterview");
        requestData = request.data;
        return {
          result: {
            dimension: "feeling",
            text: "现在再想起那天，你心里最清楚的感觉是什么？",
            generationMode: "cloud-ai",
          },
        };
      },
    },
  });
  context.after(() => {
    restoreWx();
    restoreGetApp();
  });

  const prompt = await generateInterviewPrompt({
    answer: "那年冬天我和外公在老屋门口等车。",
    askedDimensions: ["person", "time"],
    mode: "personal",
    memberName: "林岚",
    storyTitle: "老屋门口",
    previousAnswers: ["那时候天很冷。"],
    conversation: [
      { role: "assistant", text: "你最早记得的那个家，是什么样子？" },
      { role: "user", text: "那时候天很冷。" },
    ],
    memoryType: "memoir",
  });

  assert.equal(prompt.dimension, "feeling");
  assert.equal(prompt.text, "现在再想起那天，你心里最清楚的感觉是什么？");
  assert.deepEqual((requestData as { askedDimensions: string[] }).askedDimensions, [
    "person",
    "time",
  ]);
  assert.equal((requestData as { memoryType: string }).memoryType, "memoir");
  assert.deepEqual((requestData as { conversation: unknown }).conversation, [
    { role: "assistant", text: "你最早记得的那个家，是什么样子？" },
    { role: "user", text: "那时候天很冷。" },
  ]);
});

test("coediting interview includes only the displayed memory and disables unrelated memory context", async (context) => {
  let requestData: any;
  const restoreGetApp = installGlobal("getApp", () => ({ globalData: { cloudReady: true, aiReady: true } }));
  const restoreWx = installGlobal("wx", {
    cloud: { callFunction: async (request: { name: string; data: any }) => {
      requestData = request.data;
      return { result: { dimension: "feeling", text: "那时听见雨声，你心里是什么感觉？" } };
    } },
  });
  context.after(() => { restoreWx(); restoreGetApp(); });
  await generateInterviewPrompt({
    answer: "我想补充那时很安心。", askedDimensions: [], mode: "personal", memoryType: "note",
    conversation: [{ role: "user", text: "我想补充那时很安心。" }],
    sourceText: "我和外婆坐在院子里听雨。", sourceOnly: true,
  });
  assert.equal(requestData.sourceText, "我和外婆坐在院子里听雨。");
  assert.equal(requestData.sourceOnly, true);
});

test("cloud interview prompt falls back to local rules", async (context) => {
  const restoreWarnings = silenceExpectedWarnings();
  const restoreGetApp = installGlobal("getApp", () => ({
    globalData: { cloudReady: true, aiReady: true },
  }));
  const restoreWx = installGlobal("wx", {
    cloud: {
      callFunction: async () => {
        throw new Error("cloud unavailable");
      },
    },
  });
  context.after(() => {
    restoreWarnings();
    restoreWx();
    restoreGetApp();
  });

  const prompt = await generateInterviewPrompt({
    answer: "一九六二年的秋天，我在城南的院子里修收音机。",
    askedDimensions: [],
    mode: "personal",
  });

  assert.ok(["person", "feeling"].includes(prompt.dimension));
  assert.ok(prompt.text.length > 0);
});

test("cloud-ready preview does not call interview AI before release", async (context) => {
  let cloudCalls = 0;
  const restoreGetApp = installGlobal("getApp", () => ({ globalData: { cloudReady: true, aiReady: false } }));
  const restoreWx = installGlobal("wx", { cloud: { callFunction: async () => { cloudCalls += 1; } } });
  context.after(() => { restoreWx(); restoreGetApp(); });

  const prompt = await generateInterviewPrompt({ answer: "先保留在本地", askedDimensions: [] });
  assert.equal(prompt.generationMode, "local-fallback");
  assert.equal(prompt.fallbackReason, "cloud-not-ready");
  assert.equal(cloudCalls, 0);
});
