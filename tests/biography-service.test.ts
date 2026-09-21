import assert from "node:assert/strict";
import test from "node:test";

import {
  createContribution,
  reviewContribution,
} from "../miniprogram/domain/biography";
import { generateBiography } from "../miniprogram/services/biographyService";
import { createDemoRoomStateForTests as createInitialRoomState } from "./fixtures";

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
    globalData: { cloudReady: false, aiReady: false },
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
    globalData: { cloudReady: true, aiReady: true },
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
    globalData: { cloudReady: true, aiReady: true },
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

test("a local fallback reports why the online AI was not used", async (context) => {
  const restoreWarnings = silenceExpectedWarnings();
  const restoreGetApp = installGlobal("getApp", () => ({ globalData: { cloudReady: true, aiReady: true } }));
  const errors = [
    [{ errMsg: "cloud.callFunction:fail -504002 functions execute fail. Error: AI_NOT_CONFIGURED" }, "ai-not-configured"],
    [{ errMsg: "cloud.callFunction:fail -504003 Invoking task timed out after 3 seconds" }, "timeout"],
    [{ errMsg: "cloud.callFunction:fail -501000 FunctionName parameter could not be found" }, "function-missing"],
  ] as const;
  const { generateBiographyWithStatus } = await import("../miniprogram/services/biographyService");
  context.after(() => { restoreWarnings(); restoreGetApp(); });
  for (const [error, reason] of errors) {
    const restoreWx = installGlobal("wx", { cloud: { callFunction: async () => { throw error; } } });
    const state = stateWithConfirmedMemory();
    const result = await generateBiographyWithStatus(state, ownerOf(state));
    restoreWx();
    assert.equal(result.draft.generationMode, "local-demo");
    assert.equal(result.fallbackReason, reason);
  }
  const { clearAiConsent } = await import("../miniprogram/services/aiConsent");
  clearAiConsent();
  const restoreWx = installGlobal("wx", {
    showModal: ({ success }: any) => success({ confirm: false, cancel: true }),
    cloud: { callFunction: async () => { throw new Error("must not be called"); } },
  });
  const state = stateWithConfirmedMemory();
  assert.equal((await generateBiographyWithStatus(state, ownerOf(state))).fallbackReason, "consent-declined");
  restoreWx();
  clearAiConsent();
});

test("chapter organizing sends the chosen memories from the shared pool with the chapter name and text", async (context) => {
  const { generateBiographyWithStatus } = await import("../miniprogram/services/biographyService");
  let requestData: any;
  let cloudReady = true;
  const restoreGetApp = installGlobal("getApp", () => ({ globalData: { cloudReady, aiReady: cloudReady } }));
  const restoreWx = installGlobal("wx", {
    cloud: {
      callFunction: async (request: { data: unknown }) => {
        requestData = request.data;
        return { result: { title: "第二章｜雨天", paragraphs: ["整理后的正文。"], sourceCount: 1, generatedAt: "2026-09-11T00:00:00.000Z", generationMode: "cloud-ai" } };
      },
    },
  });
  context.after(() => { restoreWx(); restoreGetApp(); });
  const state = stateWithConfirmedMemory();
  state.contributions.push(createContribution({ id: "second-personal", authorMemberId: "owner", authorName: "林岚", relation: "外孙女", text: "第二段自己的回忆。", scope: "personal", visibility: "private" }));
  state.contributions.push(createContribution({ id: "someone-else", authorMemberId: "member-1", authorName: "林秋", relation: "女儿", text: "别人的故事。", scope: "personal", visibility: "private" }));
  const request = { memoryIds: ["second-personal", "someone-else"], chapterTitle: "雨天", existingText: "已有正文" };

  const cloud = await generateBiographyWithStatus(state, ownerOf(state), request);
  assert.equal(cloud.draft.generationMode, "cloud-ai");
  // Every profile shares one memory pool; another narrator keeps their own relation.
  assert.deepEqual(requestData.memories.map((memory: { id: string; relation: string }) => [memory.id, memory.relation]),
    [["second-personal", "本人"], ["someone-else", "女儿"]]);
  assert.equal(requestData.chapterTitle, "雨天");
  assert.equal(requestData.existingText, "已有正文");

  cloudReady = false;
  const local = await generateBiographyWithStatus(state, ownerOf(state), request);
  assert.equal(local.fallbackReason, "cloud-not-ready");
  assert.equal(local.draft.title, "雨天");
  assert.deepEqual(local.draft.paragraphs, ["已有正文", "第二段自己的回忆。", "别人的故事。"]);
  await assert.rejects(generateBiographyWithStatus(state, ownerOf(state), { memoryIds: ["not-in-pool"] }), /先勾选/);
});

test("malformed cloud output also falls back to the local draft", async (context) => {
  const restoreWarnings = silenceExpectedWarnings();
  const restoreGetApp = installGlobal("getApp", () => ({
    globalData: { cloudReady: true, aiReady: true },
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
