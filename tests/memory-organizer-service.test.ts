import assert from "node:assert/strict";
import test from "node:test";

import { organizeMemory } from "../miniprogram/services/memoryOrganizerService";

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

test("organizeMemory uses the cloud function when available", async (context) => {
  let requestData: unknown;
  const restoreGetApp = installGlobal("getApp", () => ({
    globalData: { cloudReady: true, aiReady: true },
  }));
  const restoreWx = installGlobal("wx", {
    cloud: {
      callFunction: async (request: { name: string; data: unknown }) => {
        assert.equal(request.name, "organizeMemory");
        requestData = request.data;
        return {
          result: {
            title: "外公护着我",
            summary: "外公在屋里护着我",
            body: "小时候，父母责骂我时，外公会在屋里把我护在身后。",
            emotions: ["安心", "委屈"],
            people: ["外公", "父母"],
            places: ["屋里"],
            memoryType: "note",
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

  const draft = await organizeMemory({
    transcript: ["小时候爸妈骂我时，外公总会把我护在身后。"],
    memoryType: "note",
    memberName: "林岚",
    memoryId: "memory-1",
  });

  assert.equal(draft.generationMode, "cloud-ai");
  assert.equal(draft.title, "外公护着我");
  assert.deepEqual(draft.people, ["外公", "父母"]);
  assert.deepEqual(requestData, {
    memoryId: "memory-1",
    memoryType: "note",
    memberName: "林岚",
    storyTitle: undefined,
    consentVersion: undefined,
  });
});

test("coediting organizer sends the selected memory draft and source guard, not only the old saved text", async (context) => {
  let requestData: any;
  const restoreGetApp = installGlobal("getApp", () => ({ globalData: { cloudReady: true, aiReady: true } }));
  const restoreWx = installGlobal("wx", {
    cloud: { callFunction: async (request: { name: string; data: any }) => {
      if (request.name === "recordAiConsent") return { result: { success: true } };
      requestData = request.data;
      return { result: { title: "院子听雨", summary: "雨落院子", body: "我和外婆在院子里听雨。", memoryType: "note", generationMode: "cloud-ai" } };
    } },
  });
  context.after(() => { restoreWx(); restoreGetApp(); });

  const draft = await organizeMemory({
    transcript: ["我和外婆在院子里听雨。", "还记得雨点落在瓦片上。"],
    memoryType: "note", memoryId: "memory-coedit", expectedSavedText: "原来保存的院子里听雨。",
    expectedSourceRevisionId: "revision-saved-current",
  });

  assert.equal(draft.generationMode, "cloud-ai");
  assert.deepEqual(requestData.transcript, ["我和外婆在院子里听雨。", "还记得雨点落在瓦片上。"]);
  assert.equal(requestData.expectedText, "原来保存的院子里听雨。");
  assert.equal(requestData.sourceRevisionId, "revision-saved-current");
  assert.equal(requestData.sourceOnly, true);
});

test("organizeMemory falls back to editable original text", async (context) => {
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

  const draft = await organizeMemory({
    transcript: ["第一句。", "第二句。"],
    memoryType: "memoir",
  });

  assert.equal(draft.generationMode, "local-demo");
  assert.equal(draft.memoryType, "memoir");
  assert.equal(draft.body, "第一句。 第二句。");
});

test("organizeMemory stays local until AI release readiness is enabled", async (context) => {
  let cloudCalls = 0;
  const restoreGetApp = installGlobal("getApp", () => ({ globalData: { cloudReady: true, aiReady: false } }));
  const restoreWx = installGlobal("wx", { cloud: { callFunction: async () => { cloudCalls += 1; } } });
  context.after(() => { restoreWx(); restoreGetApp(); });

  const draft = await organizeMemory({ transcript: ["暂时只在本地整理。"], memoryType: "note" });
  assert.equal(draft.generationMode, "local-demo");
  assert.equal(cloudCalls, 0);
});
