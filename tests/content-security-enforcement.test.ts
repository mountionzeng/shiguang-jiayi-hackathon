import assert from "node:assert/strict";
import test from "node:test";

import { createContribution, FamilyRoomState } from "../miniprogram/domain/biography";
import { checkTextContent } from "../miniprogram/services/contentSecurityService";
import { appendCloudContribution, loadCloudRoomState, replaceCloudContribution } from "../miniprogram/services/cloudRoomStorage";

const FAMILY = "family_fixture-user";

/**
 * 合成的云数据库 + callFunction；contentSecurityCheck 的结果可控，其余云函数只走
 * getOpenId 的默认返回。用来验证「提到人的记忆写进云端前会先过内容安全检测」这条规则，
 * 而不是真的调用微信接口。
 */
function installCloud(checkResult: { ok: boolean } | (() => { ok: boolean }) = { ok: true }) {
  const tables = new Map<string, Map<string, any>>();
  const records = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const local = new Map<string, unknown>();
  const checkCalls: Array<{ content: string; title?: string }> = [];
  const previousWx = (globalThis as any).wx;
  (globalThis as any).wx = {
    getStorageSync: (key: string) => local.get(key),
    setStorageSync: (key: string, value: unknown) => local.set(key, value),
    cloud: {
      callFunction: async ({ name, data }: { name: string; data?: any }) => {
        if (name === "contentSecurityCheck") {
          checkCalls.push({ content: data.content, title: data.title });
          const result = typeof checkResult === "function" ? checkResult() : checkResult;
          return { result };
        }
        if (name === "getOpenId") return { result: { openid: "fixture-user" } };
        throw new Error(`unexpected cloud function: ${name}`);
      },
      database: () => ({
        serverDate: () => new Date(0),
        collection: (name: string) => ({
          where: (filter: Record<string, unknown>) => {
            let offset = 0;
            let size = 20;
            const query = {
              orderBy: () => query,
              skip: (n: number) => { offset = n; return query; },
              limit: (n: number) => { size = n; return query; },
              get: async () => ({
                data: [...records(name)].map(([id, data]) => ({ ...data, _id: id }))
                  .filter((data) => Object.entries(filter).every(([key, value]) => data[key] === value))
                  .slice(offset, offset + size),
              }),
            };
            return query;
          },
          doc: (id: string) => ({
            get: async () => ({ data: records(name).get(id) }),
            set: async ({ data }: any) => { records(name).set(id, structuredClone(data)); },
            remove: async () => { records(name).delete(id); },
          }),
        }),
      }),
    },
  };
  records("families").set(FAMILY, { roomName: "测试房间" });
  records("family_members").set(`${FAMILY}_owner`, {
    familyId: FAMILY, memberId: "owner", name: "测试者", relation: "自己", role: "owner", avatarText: "测",
  });
  return { checkCalls, restore: () => { (globalThis as any).wx = previousWx; } };
}

const personalMemory = (overrides: Partial<Parameters<typeof createContribution>[0]> = {}) => createContribution({
  authorMemberId: "owner", authorName: "测试者", relation: "自己", text: "仅供测试的虚构记录。",
  scope: "personal", visibility: "private", ...overrides,
});

test("checkTextContent：空文字直接通过、没有云环境按未通过处理、把结果透传给调用方", async (context) => {
  assert.deepEqual(await checkTextContent("   "), { ok: true, suggest: "pass" });

  const previousWx = (globalThis as any).wx;
  // 真机上 wx 全局一定存在；这里只模拟"这个版本没有 cloud 能力"这种更贴近现实的情况。
  (globalThis as any).wx = {};
  context.after(() => { (globalThis as any).wx = previousWx; });
  assert.deepEqual(await checkTextContent("一段文字"), { ok: false, suggest: "review" });
});

test("checkTextContent：正常调用把结果原样返回，调用失败按未通过处理", async (context) => {
  const cloud = installCloud({ ok: true });
  context.after(cloud.restore);
  assert.deepEqual(await checkTextContent("一段文字", "标题"), { ok: true, suggest: undefined });
  assert.deepEqual(cloud.checkCalls, [{ content: "一段文字", title: "标题" }]);

  (globalThis as any).wx.cloud.callFunction = async () => { throw new Error("网络出错"); };
  const result = await checkTextContent("另一段文字");
  assert.equal(result.ok, false);
});

test("纯私密记忆（没提到任何人）不会触发内容安全检测", async (context) => {
  const cloud = installCloud({ ok: true });
  context.after(cloud.restore);
  await appendCloudContribution(personalMemory({ id: "private-only" }));
  assert.deepEqual(cloud.checkCalls, []);
});

test("提到了人的记忆：检测通过后正常分享，检测没通过或服务不可用时仍保存但强制改成只有作者能看", async (context) => {
  const cloud = installCloud({ ok: true });
  context.after(cloud.restore);
  const passed = personalMemory({ id: "mentions-friend", relatedMemberIds: ["friend-1"] });
  let state = await appendCloudContribution(passed);
  let saved = state.contributions.find((item) => item.id === "mentions-friend")!;
  assert.deepEqual(saved.sharedWithMemberIds, ["friend-1"], "检测通过时，默认的「提到谁谁能看」照常生效");
  assert.equal(cloud.checkCalls.length, 1);

  (globalThis as any).wx.cloud.callFunction = async ({ name, data }: { name: string; data: any }) =>
    name === "contentSecurityCheck" ? { result: { ok: false } } : { result: { openid: "fixture-user" } };

  const rejected = personalMemory({ id: "flagged-content", relatedMemberIds: ["friend-1"], text: "被检测判定不合规的虚构文字。" });
  state = await appendCloudContribution(rejected);
  saved = state.contributions.find((item) => item.id === "flagged-content")!;
  assert.equal(saved.text, "被检测判定不合规的虚构文字。", "文字本身照常保存，不会被丢弃");
  assert.deepEqual(saved.relatedMemberIds, ["friend-1"], "涉及的人不受影响，只是不再对外分享");
  assert.equal(saved.sharedWithMemberIds, undefined, "分享被强制收回，只有作者自己能看");

  (globalThis as any).wx.cloud.callFunction = async ({ name }: { name: string }) => {
    if (name === "contentSecurityCheck") throw new Error("检测服务暂时不可用");
    return { result: { openid: "fixture-user" } };
  };
  state = await appendCloudContribution(personalMemory({ id: "check-unavailable", relatedMemberIds: ["friend-1"] }));
  saved = state.contributions.find((item) => item.id === "check-unavailable")!;
  assert.equal(saved.sharedWithMemberIds, undefined, "检测服务打不通时同样按未通过处理，不放行分享");

  // 编辑一段已经通过检测、正在分享的记忆，改成会被判定不合规的内容：分享同样被收回。
  (globalThis as any).wx.cloud.callFunction = async ({ name }: { name: string }) =>
    name === "contentSecurityCheck" ? { result: { ok: false } } : { result: { openid: "fixture-user" } };
  const latest = (await loadCloudRoomState()).contributions.find((item) => item.id === "mentions-friend")!;
  state = await replaceCloudContribution({ ...latest, text: "改成了被判定不合规的虚构文字。" });
  saved = state.contributions.find((item) => item.id === "mentions-friend")!;
  assert.equal(saved.sharedWithMemberIds, undefined);
});
