import assert from "node:assert/strict";
import test from "node:test";
import { createDemoRoomStateForTests } from "./fixtures";
import { mergeLegacyCloud } from "../miniprogram/services/localImport";
import * as repository from "../miniprogram/services/roomRepository";
import { makeRevision, saveManuscriptRevision } from "../miniprogram/services/manuscript";
import { clearAiConsent } from "../miniprogram/services/aiConsent";
import { generateBiography } from "../miniprogram/services/biographyService";
import { generateInterviewPrompt } from "../miniprogram/services/interviewService";
import { organizeMemory } from "../miniprogram/services/memoryOrganizerService";

test("local demo without a cloud SDK retains edits and photo manuscript revisions", async context => {
  const before = (globalThis as any).wx;
  const beforeApp = (globalThis as any).getApp;
  context.after(() => { (globalThis as any).wx = before; (globalThis as any).getApp = beforeApp; });
  const stored = new Map<string, unknown>([["shiguang-family-room-v5", createDemoRoomStateForTests()]]);
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: true } });
  (globalThis as any).wx = {
    getStorageSync: (key: string) => stored.get(key),
    setStorageSync: (key: string, value: unknown) => stored.set(key, value),
  };
  const state = await repository.loadRoomStateRemoteFirst();
  const item = { ...state.contributions[0], text: "本机修改" };
  await repository.replaceContributionRemoteFirst(item);
  const revision = makeRevision("owner", { title: "图文稿", paragraphs: ["本机文字"], sourceCount: 1, generatedAt: "", generationMode: "local-demo", content: [{ text: "本机文字" }, { photoId: "photo-123-test" }] }, "", "draft", "本机版本");
  await saveManuscriptRevision(revision, "");
  await saveManuscriptRevision(revision, "");
  await assert.rejects(saveManuscriptRevision({ ...revision, draft: { ...revision.draft, content: [{ photoId: "photo-123-other" }] } }, ""), /编号冲突/);
  const reopened = await repository.loadRoomStateRemoteFirst();
  assert.equal(reopened.manuscriptRevisions?.length, 1);
  assert.deepEqual(reopened.manuscriptRevisions?.[0].draft.content, revision.draft.content);
});

test("import namespaces cloud identities, retains local edits and is idempotent", () => {
  const local = createDemoRoomStateForTests();
  const remote = createDemoRoomStateForTests();
  const merged = mergeLegacyCloud(local, remote, "family-example");
  assert.equal(merged.members.length, local.members.length + remote.members.length);
  assert.equal(merged.contributions[0].id, local.contributions[0].id);
  const imported = merged.contributions[local.contributions.length];
  assert.equal(imported.authorMemberId, "family-example:" + remote.contributions[0].authorMemberId);
  assert.deepEqual(mergeLegacyCloud(merged, remote, "family-example"), merged);
  assert.deepEqual(local, createDemoRoomStateForTests(), "import does not mutate its input");
});

test("declining online AI prevents all three AI service paths from transmitting text", async context => {
  const before = (globalThis as any).wx;
  const beforeApp = (globalThis as any).getApp;
  context.after(() => { clearAiConsent(); (globalThis as any).wx = before; (globalThis as any).getApp = beforeApp; });
  clearAiConsent();
  let calls = 0;
  let consentCopy = "";
  (globalThis as any).getApp = () => ({ globalData: { cloudReady: true } });
  (globalThis as any).wx = {
    showModal: ({ content, success }: any) => {
      consentCopy = content;
      success({ confirm: false, cancel: true });
    },
    cloud: { callFunction: () => { calls++; throw new Error("not authorized"); } },
  };
  const state = createDemoRoomStateForTests();
  await generateBiography(state, state.members.find(item => item.id === "owner")!);
  await generateInterviewPrompt({ answer: "不发送的文字", askedDimensions: [] });
  await organizeMemory({ transcript: ["不发送的文字"], memoryType: "note" });
  assert.equal(calls, 0);
  assert.match(consentCopy, /这项授权不包含照片/);
  assert.match(consentCopy, /压缩后的照片使用微信云开发云存储，原图仍留在手机/);
  assert.match(consentCopy, /需要 AI 看照片时会另外询问/);
});
