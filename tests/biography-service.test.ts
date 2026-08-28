import assert from "node:assert/strict";
import test from "node:test";

import {
  createContribution,
  createInitialRoomState,
  reviewContribution,
} from "../miniprogram/domain/biography";
import { generateBiography } from "../miniprogram/services/biographyService";

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

function stateWithConfirmedMemory() {
  const state = createInitialRoomState();
  return {
    ...state,
    contributions: [
      reviewContribution(state.contributions[0], "confirmed", "elder"),
      state.contributions[1],
    ],
  };
}

test("cloud disabled uses a transparent local draft", async (context) => {
  let cloudCallCount = 0;
  const restoreGetApp = installGlobal("getApp", () => ({
    globalData: { cloudReady: false },
  }));
  const restoreWx = installGlobal("wx", {
    cloud: {
      callFunction: async () => {
        cloudCallCount += 1;
        throw new Error("cloud must stay disabled");
      },
    },
  });
  context.after(() => {
    restoreWx();
    restoreGetApp();
  });

  const draft = await generateBiography(stateWithConfirmedMemory());

  assert.equal(draft.generationMode, "local-demo");
  assert.equal(draft.sourceCount, 1);
  assert.equal(cloudCallCount, 0);
});

test("cloud generation receives only confirmed family-visible memories", async (context) => {
  let requestData: unknown;
  const restoreGetApp = installGlobal("getApp", () => ({
    globalData: { cloudReady: true },
  }));
  const restoreWx = installGlobal("wx", {
    cloud: {
      callFunction: async (request: { data: unknown }) => {
        requestData = request.data;
        return {
          result: {
            title: "第一章｜雨天的巷口",
            paragraphs: ["外公会在雨天等我放学。"],
            sourceCount: 1,
            generatedAt: "2026-08-28T05:00:00.000Z",
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

  const state = stateWithConfirmedMemory();
  state.contributions.push(
    reviewContribution(
      createContribution({
        id: "private-source",
        authorMemberId: "owner",
        authorName: "林岚",
        relation: "外孙女",
        text: "这条属实但没有同意公开。",
        visibility: "private",
        now: new Date("2026-08-28T05:02:00.000Z"),
      }),
      "confirmed",
      "elder",
    ),
  );

  const draft = await generateBiography(state);
  const memories = (requestData as { memories: Array<{ id: string }> }).memories;

  assert.equal(draft.generationMode, "cloud-ai");
  assert.deepEqual(memories.map((memory) => memory.id), ["demo-memory-rain"]);
});

test("cloud failure falls back instead of breaking chapter generation", async (context) => {
  const restoreWarnings = silenceExpectedWarnings();
  const restoreGetApp = installGlobal("getApp", () => ({
    globalData: { cloudReady: true },
  }));
  const restoreWx = installGlobal("wx", {
    cloud: {
      callFunction: async () => {
        throw new Error("network unavailable");
      },
    },
  });
  context.after(() => {
    restoreWarnings();
    restoreWx();
    restoreGetApp();
  });

  const draft = await generateBiography(stateWithConfirmedMemory());

  assert.equal(draft.generationMode, "local-demo");
  assert.equal(draft.sourceCount, 1);
});

test("malformed cloud output also falls back to the local draft", async (context) => {
  const restoreWarnings = silenceExpectedWarnings();
  const restoreGetApp = installGlobal("getApp", () => ({
    globalData: { cloudReady: true },
  }));
  const restoreWx = installGlobal("wx", {
    cloud: {
      callFunction: async () => ({ result: { title: "缺少正文" } }),
    },
  });
  context.after(() => {
    restoreWarnings();
    restoreWx();
    restoreGetApp();
  });

  const draft = await generateBiography(stateWithConfirmedMemory());

  assert.equal(draft.generationMode, "local-demo");
  assert.equal(draft.sourceCount, 1);
});
