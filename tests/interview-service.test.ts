import assert from "node:assert/strict";
import test from "node:test";

import { generateInterviewPrompt } from "../miniprogram/services/interviewService";

const interviewCloud = require("../cloudfunctions/chatInterview/index.js");
import {
  CLOUD_FOLLOW_UP_LABEL,
  FOLLOW_UP_LABEL,
  QUOTA_EXHAUSTED_FOLLOW_UP_LABEL,
} from "../miniprogram/domain/interview";

const INTERNAL_LABEL_WORDS = /模板|本地|降级|AI|模型|云端|额度/;

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

test("cloud interview prompt uses an honest local template when cloud fails", async (context) => {
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

  assert.equal(prompt.generationMode, "local-fallback");
  assert.equal(prompt.fallbackReason, "function-error");
  assert.match(prompt.text, /这句话/);
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

test("exhausted moderation quota is identified while preserving honest local fallback", async context => {
  const restoreWarnings = silenceExpectedWarnings();
  const restoreGetApp = installGlobal("getApp", () => ({ globalData: { cloudReady: true, aiReady: true } }));
  let failure: unknown;
  let calls = 0;
  const restoreWx = installGlobal("wx", { cloud: { callFunction: async () => { calls += 1; throw failure; } } });
  context.after(() => { restoreWarnings(); restoreWx(); restoreGetApp(); });
  for (failure of [
    { code: "AI_CONTENT_CHECK_QUOTA_EXHAUSTED" },
    { errMsg: "cloud.callFunction:fail Error: 今日内容安全检查额度已用完，请稍后再试" },
    new Error("AI_CONTENT_CHECK_QUOTA_EXHAUSTED"),
  ]) {
    const result = await generateInterviewPrompt({ answer: "今天先到这里吧。", askedDimensions: [] });
    assert.equal(result.generationMode, "local-fallback");
    assert.equal(result.fallbackReason, "moderation-quota-exhausted");
    assert.doesNotMatch(result.text, /[？?]/);
  }
  assert.equal(calls, 3);
});

test("follow-up labels distinguish normal, unavailable, and daily-check-limit states in user language", () => {
  assert.notEqual(CLOUD_FOLLOW_UP_LABEL, FOLLOW_UP_LABEL);
  assert.notEqual(CLOUD_FOLLOW_UP_LABEL, QUOTA_EXHAUSTED_FOLLOW_UP_LABEL);
  assert.notEqual(FOLLOW_UP_LABEL, QUOTA_EXHAUSTED_FOLLOW_UP_LABEL);
  for (const label of [CLOUD_FOLLOW_UP_LABEL, FOLLOW_UP_LABEL, QUOTA_EXHAUSTED_FOLLOW_UP_LABEL]) {
    assert.doesNotMatch(label, INTERNAL_LABEL_WORDS);
  }
});

test("local fallback stays attached to the user's words and identifies itself in user language", async (context) => {
  const restoreGetApp = installGlobal("getApp", () => ({ globalData: { cloudReady: true, aiReady: false } }));
  const restoreWx = installGlobal("wx", { cloud: { callFunction: async () => { throw new Error("must not call cloud"); } } });
  context.after(() => { restoreWx(); restoreGetApp(); });

  const prompt = await generateInterviewPrompt({
    answer: "越是迷茫的时候，越是要往远处看。",
    askedDimensions: [],
  });

  assert.equal(prompt.generationMode, "local-fallback");
  assert.equal(FOLLOW_UP_LABEL, "小忆暂时没连上，先陪你聊");
  assert.match(prompt.text, /这句话/);
  assert.doesNotMatch(prompt.text, /谁和你在一起|什么时候|在哪里/);
});
test("local templates respect explicit pause or record-only requests", async context => {
  const restoreGetApp = installGlobal("getApp", () => ({ globalData: { cloudReady: true, aiReady: false } }));
  const restoreWx = installGlobal("wx", {});
  context.after(() => { restoreWx(); restoreGetApp(); });
  for (const answer of ["今天先到这里吧，我想歇一会儿。", "不太想解释原因，只想把这句话留下。", "今天先到这里吧。", "我只想记录。"]){
    const result = await generateInterviewPrompt({ answer, askedDimensions: [] });
    assert.doesNotMatch(result.text, /[？?]/);
    assert.equal(result.generationMode, "local-fallback");
  }
});
test("declining one topic does not end the local conversation", async context => {
  const restoreGetApp = installGlobal("getApp", () => ({ globalData: { cloudReady: true, aiReady: false } }));
  const restoreWx = installGlobal("wx", {});
  context.after(() => { restoreWx(); restoreGetApp(); });
  const result = await generateInterviewPrompt({ answer:"我不想聊那个人，想说说我后来怎样决定离开的。", askedDimensions:[] });
  assert.match(result.text, /[？?]/);
});

test("邀请短笺 AI 只返回可编辑的短标题和短正文", () => {
  const messages = interviewCloud._test.buildInviteCopyMessages({
    inviteeName: "阿遥",
    relation: "同学",
    currentHeadline: "一起写故事",
    currentMessage: "把我们记得的日子写下来。",
  });
  assert.match(messages[0].content, /headline/);
  assert.match(messages[0].content, /16/);
  assert.match(messages[0].content, /48/);
  assert.match(messages[0].content, /避免叠字和重复用词/);
  assert.doesNotMatch(messages[0].content, /二维码|有效期/);

  assert.deepEqual(
    interviewCloud._test.parseInviteCopy('```json\n{"headline":"一起写下来","message":"阿遥，来补上你记得的那一页。"}\n```'),
    { headline: "一起写下来", message: "阿遥，来补上你记得的那一页。" },
  );
  assert.throws(
    () => interviewCloud._test.parseInviteCopy('{"headline":"忆忆忆忆忆忆忆忆忆忆忆忆忆忆忆忆忆","message":"一起写故事"}'),
    /INVITE_COPY_INVALID/,
  );
});
