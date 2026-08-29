import assert from "node:assert/strict";
import test from "node:test";

import { generateInterviewPrompt } from "../miniprogram/services/interviewService";

function installGlobal(name: "getApp" | "wx", value: unknown): () => void {
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
    globalData: { cloudReady: true },
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
    memoryType: "memoir",
  });

  assert.equal(prompt.dimension, "feeling");
  assert.equal(prompt.text, "现在再想起那天，你心里最清楚的感觉是什么？");
  assert.deepEqual((requestData as { askedDimensions: string[] }).askedDimensions, [
    "person",
    "time",
  ]);
  assert.equal((requestData as { memoryType: string }).memoryType, "memoir");
});

test("cloud interview prompt falls back to local rules", async (context) => {
  const restoreWarnings = silenceExpectedWarnings();
  const restoreGetApp = installGlobal("getApp", () => ({
    globalData: { cloudReady: true },
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
