import assert from "node:assert/strict";
import test from "node:test";

import { organizeMemory } from "../miniprogram/services/memoryOrganizerService";

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

test("organizeMemory uses the cloud function when available", async (context) => {
  let requestData: unknown;
  const restoreGetApp = installGlobal("getApp", () => ({
    globalData: { cloudReady: true },
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
  });

  assert.equal(draft.generationMode, "cloud-ai");
  assert.equal(draft.title, "外公护着我");
  assert.deepEqual(draft.people, ["外公", "父母"]);
  assert.deepEqual((requestData as { transcript: string[] }).transcript, [
    "小时候爸妈骂我时，外公总会把我护在身后。",
  ]);
});

test("organizeMemory falls back to editable original text", async (context) => {
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

  const draft = await organizeMemory({
    transcript: ["第一句。", "第二句。"],
    memoryType: "memoir",
  });

  assert.equal(draft.generationMode, "local-demo");
  assert.equal(draft.memoryType, "memoir");
  assert.equal(draft.body, "第一句。 第二句。");
});
