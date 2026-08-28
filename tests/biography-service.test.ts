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
  return createInitialRoomState();
}

function ownerOf(state: ReturnType<typeof stateWithConfirmedMemory>) {
  const owner = state.members.find((member) => member.id === "owner");
  assert.ok(owner);
  return owner;
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

  const state = stateWithConfirmedMemory();
  const draft = await generateBiography(state, ownerOf(state));

  assert.equal(draft.generationMode, "local-demo");
  assert.equal(draft.sourceCount, 1);
  assert.equal(cloudCallCount, 0);
});

test("cloud generation receives only the current user's personal stories", async (context) => {
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
  state.contributions.push(createContribution({
    id: "someone-elses-personal-story",
    authorMemberId: "member-1",
    authorName: "林秋",
    relation: "女儿",
    text: "这是另一个家庭成员自己的故事。",
    scope: "personal",
    visibility: "private",
    now: new Date("2026-08-28T05:02:00.000Z"),
  }));

  const draft = await generateBiography(state, ownerOf(state));
  const memories = (requestData as { memories: Array<{ id: string }> }).memories;

  assert.equal(draft.generationMode, "cloud-ai");
  assert.deepEqual(memories.map((memory) => memory.id), ["demo-personal-rain"]);
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

  const state = stateWithConfirmedMemory();
  const draft = await generateBiography(state, ownerOf(state));

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

  const state = stateWithConfirmedMemory();
  const draft = await generateBiography(state, ownerOf(state));

  assert.equal(draft.generationMode, "local-demo");
  assert.equal(draft.sourceCount, 1);
});
