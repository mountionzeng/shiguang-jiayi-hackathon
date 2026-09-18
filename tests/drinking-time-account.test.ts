import assert from "node:assert/strict";
import test from "node:test";

import { FamilyRoomState } from "../miniprogram/domain/biography";
import {
  desktopStoryOptions,
  createDesktopStoryCode,
  desktopStorySnapshot,
  drinkingTimeAccountTest,
} from "../miniprogram/services/drinkingTimeAccount";

test("新版传电脑只发送故事版本引用，不发送本地正文，失败不降级", async () => {
  const room=state();
  room.storyMigration={version:1,status:"active",pending:[]};
  room.stories=[{id:"story-a",familyId:"family_owner",title:"云端故事",bookTitle:"云端故事",writingMode:"objective",version:2,currentRevisionId:"revision-a",memoryIds:[],protagonistMemberIds:[],createdAt:"2026-09-18T00:00:00Z",updatedAt:"2026-09-18T00:00:00Z"}];
  const globals=globalThis as unknown as {wx: typeof wx};
  const previous=globals.wx;
  const calls: unknown[]=[];
  let fail=false;
  globals.wx={cloud:{async callFunction(input: unknown){
    calls.push(input);
    if(fail)throw new Error("STORY_PROTOCOL_REQUIRED");
    return {result:{code:"ABC234",expiresAt:"2026-09-18T00:05:00Z",storyId:1,imported:true}};
  }}} as unknown as typeof wx;
  try{
    await createDesktopStoryCode(room,"story-a");
    assert.deepEqual(calls[0],{name:"drinkingTimeBridge",data:{action:"issueDesktop",storyRef:{storyId:"story-a",revisionId:"revision-a",version:2}}});
    fail=true;
    await assert.rejects(createDesktopStoryCode(room,"story-a"),/来源限制/);
    assert.equal(calls.length,2);
    room.stories[0].currentRevisionId="";
    await assert.rejects(createDesktopStoryCode(room,"story-a"),/先.*保存/);
    assert.equal(calls.length,2);
  }finally{globals.wx=previous;}
});

const state = (): FamilyRoomState => ({
  roomName: "我的拾光房间",
  protagonistName: "岱",
  members: [{ id: "owner", name: "岱", relation: "自己", avatarText: "岱", role: "owner", kind: "recording-profile" }],
  contributions: [
    { id: "m1", authorMemberId: "owner", authorName: "岱", relation: "自己", text: "厨房里总有热气。", title: "灶台", summary: "外婆做饭", people: ["外婆"], places: ["厨房"], storyTitle: "外婆的厨房", scope: "personal", visibility: "private", reviewStatus: "confirmed", createdAt: "2026-09-13T10:00:00.000Z" },
    { id: "m2", authorMemberId: "owner", authorName: "岱", relation: "自己", text: "已删除的内容", storyTitle: "旧故事", scope: "personal", visibility: "private", reviewStatus: "confirmed", createdAt: "2026-09-12T10:00:00.000Z" },
  ],
  personalDrafts: {
    owner: {
      title: "外婆的厨房",
      paragraphs: ["这是整理后的第一章。"],
      sourceCount: 1,
      generatedAt: "2026-09-14T10:00:00.000Z",
      generationMode: "local-demo",
      chapters: [{ id: "c1", title: "灶台边", memoryIds: ["m1"], content: [{ text: "这是整理后的第一章。" }, { photoId: "photo-local-1" }] }],
    },
  },
  deletedStories: [{ key: "story:旧故事", title: "旧故事", deletedAt: "2026-09-14T09:00:00.000Z" }],
});

test("只列出当前有效的拾光故事，已删除故事不会重新出现", () => {
  assert.deepEqual(desktopStoryOptions(state()).map(item => item.title), ["外婆的厨房"]);
});

test("故事快照保留记忆、人物地点、章节正文和照片引用", () => {
  const snapshot = desktopStorySnapshot(state(), "story:外婆的厨房");
  assert.equal(snapshot.title, "外婆的厨房");
  assert.equal(snapshot.memories[0].text, "厨房里总有热气。");
  assert.deepEqual(snapshot.memories[0].people, ["外婆"]);
  assert.deepEqual(snapshot.manuscript?.chapters[0].content, [{ text: "这是整理后的第一章。" }, { photoId: "photo-local-1" }]);
  assert.match(snapshot.sourceRevision, /^[0-9a-f]{16}$/);
  assert.equal(snapshot.sourceRevision, desktopStorySnapshot(state(), "story:外婆的厨房").sourceRevision);
});

test("电脑端 v1 不把 AI 插图引用误当成本机照片", () => {
  const room = state();
  room.personalDrafts!.owner.chapters![0].content.push({ photoId: "photo-ai-req-abcdefgh" });
  const content = desktopStorySnapshot(room, "story:外婆的厨房").manuscript!.chapters[0].content;
  assert.deepEqual(content.slice(-2), [{ photoId: "photo-local-1" }, { text: "〔AI 插图请在小程序查看〕" }]);
});

test("删除或空故事无法生成过期快照", () => {
  assert.throws(() => desktopStorySnapshot(state(), "story:旧故事"), /已经删除或更新/);
});

test("电脑码响应必须完整且符合无歧义字母表", () => {
  const result = drinkingTimeAccountTest.transferResult({ code: "ABC234", expiresAt: "2026-09-14T10:05:00.000Z", storyId: 3, imported: true });
  assert.equal(result.storyId, 3);
  assert.throws(() => drinkingTimeAccountTest.transferResult({ code: "000000", expiresAt: "bad" }), /返回异常/);
  const authority=drinkingTimeAccountTest.transferResult({code:"ABC234",expiresAt:"2026-09-14T10:05:00.000Z",storyAccessId:8,bound:true});
  assert.equal(authority.storyAccessId,8);
});

test("接口约定 1.1.0 第 3.5 节：storyId 必须是正整数", () => {
  const base = { code: "ABC234", expiresAt: "2026-09-14T10:05:00.000Z", imported: true };
  assert.throws(() => drinkingTimeAccountTest.transferResult({ ...base, storyId: 0 }), /返回异常/);
  assert.throws(() => drinkingTimeAccountTest.transferResult({ ...base, storyId: -1 }), /返回异常/);
});
